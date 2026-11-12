'use strict';

const { requestJson, localDate, endOfMonthLocal, addDaysLocal, pick, toNumber, round2 } = require('../lib/http');

const AUTH_BASE = 'https://copilot.tencent.com';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const BALANCE_ENDPOINTS = [
  { url: 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource', body: {}, parser: 'resource' },
  { url: 'https://copilot.tencent.com/v2/billing/meter/get-user-resource', body: {}, parser: 'resource' },
  { url: 'https://www.workbuddy.cn/billing/meter/get-user-resource-summary', body: {}, parser: 'summary' }
];

function authHeaders(withBody) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Domain': AUTH_BASE,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'X-Product': 'SaaS',
    'User-Agent': CLIENT_UA,
    'X-Request-ID': require('crypto').randomUUID()
  };
  if (withBody) headers['Content-Type'] = 'application/json';
  return headers;
}

function tokensFromPayload(json) {
  if (!json || typeof json !== 'object') return null;
  const data = json.data && typeof json.data === 'object' ? json.data : json;
  const accessToken = pick(data, ['accessToken', 'access_token', 'token']);
  if (!accessToken || typeof accessToken !== 'string') return null;
  const refreshToken = pick(data, ['refreshToken', 'refresh_token']);
  const expiresIn = toNumber(pick(data, ['expiresIn', 'expires_in']));
  const expiresAtRaw = toNumber(pick(data, ['expiresAt', 'expires_at']));
  let expiresAt = 0;
  if (Number.isFinite(expiresAtRaw) && expiresAtRaw > 0) {
    expiresAt = expiresAtRaw < 1e12 ? expiresAtRaw * 1000 : expiresAtRaw;
  } else if (Number.isFinite(expiresIn) && expiresIn > 0) {
    expiresAt = Date.now() + expiresIn * 1000;
  }
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    expiresAt
  };
}

async function startLogin() {
  const res = await requestJson(`${AUTH_BASE}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: authHeaders(true),
    body: '{}'
  });
  if (!res.ok) throw new Error(`请求授权链接失败（HTTP ${res.status}）`);
  const data = res.json && (res.json.data || res.json);
  const state = data && data.state;
  const authUrl = data && data.authUrl;
  if (!state || !authUrl) throw new Error('授权响应缺少 state 或 authUrl');
  return { state, loginUrl: authUrl };
}

async function pollLogin(state) {
  const encoded = encodeURIComponent(state);
  const res = await requestJson(`${AUTH_BASE}/v2/plugin/auth/token?state=${encoded}`, {
    method: 'GET',
    headers: authHeaders(false)
  });
  if (!res.ok) return { status: 'pending' };
  const json = res.json || {};
  if (Number(json.code) === 0) {
    const tokens = tokensFromPayload(json);
    if (tokens) return { status: 'ok', tokens };
  }
  return { status: 'pending' };
}

async function refreshToken(cfg) {
  const wb = cfg.workbuddy || {};
  if (!wb.refreshToken) return null;
  const headers = authHeaders(false);
  headers['X-Refresh-Token'] = wb.refreshToken;
  const res = await requestJson(`${AUTH_BASE}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers
  });
  if (!res.ok) return null;
  return tokensFromPayload(res.json);
}

function balanceHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Authorization': `Bearer ${token}`,
    'User-Agent': BROWSER_UA,
    'Origin': 'https://www.workbuddy.cn',
    'Referer': 'https://www.workbuddy.cn/profile/credits-usage',
    'X-Requested-With': 'XMLHttpRequest'
  };
}

function kindLabel(kind) {
  const k = String(kind || '').toLowerCase();
  if (k.includes('plan_base')) return '套餐基础积分';
  if (k.includes('plan_bonus')) return '套餐赠送积分';
  if (k.includes('addon')) return '加量包';
  if (k.includes('benefit') || k.includes('bonus')) return '活动/奖励积分';
  return kind ? String(kind) : 'WorkBuddy 积分';
}

function deriveExpiry(kind, explicit) {
  const date = localDate(explicit);
  if (date) return date;
  const k = String(kind || '').toLowerCase();
  if (k.includes('plan_base') || k.includes('plan_bonus')) return endOfMonthLocal();
  if (k.includes('addon')) return addDaysLocal(30);
  return null;
}

function parseSummary(json) {
  const root = json && (json.data || json);
  if (!root || typeof root !== 'object') return null;
  const groups = root.CreditGroups || root.creditGroups || root.credit_groups;
  const tranches = [];
  let total = 0;

  if (Array.isArray(groups)) {
    groups.forEach((group, index) => {
      if (!group || typeof group !== 'object') return;
      const kind = pick(group, ['Kind', 'kind', 'Type', 'type', 'CreditKind', 'creditKind']);
      const totalValue = toNumber(pick(group, ['CycleTotalCapacity', 'Total', 'total', 'Limit', 'limit', 'TotalCredits', 'totalCredits', 'Amount', 'amount']));
      const usedValue = toNumber(pick(group, ['CycleUsedCapacity', 'Used', 'used', 'Consumed', 'consumed', 'UsedCredits', 'usedCredits']));
      let remain = toNumber(pick(group, [
        'CycleRemainCapacity',
        'Remain', 'remain', 'Remaining', 'remaining', 'RemainingCredits', 'remainingCredits',
        'Credits', 'credits', 'Balance', 'balance', 'Available', 'available', 'Value', 'value'
      ]));
      if (!Number.isFinite(remain) && Number.isFinite(totalValue) && Number.isFinite(usedValue)) {
        remain = totalValue - usedValue;
      }
      remain = round2(remain);
      if (!Number.isFinite(remain) || remain <= 0) return;

      const expiry = deriveExpiry(kind, pick(group, [
        'ExpireTime', 'expireTime', 'ExpireAt', 'expireAt', 'ExpiredTime', 'expiredTime',
        'ExpireDate', 'expireDate', 'EndTime', 'endTime', 'ValidUntil', 'validUntil',
        'NextResetTime', 'nextResetTime', 'PeriodEndTime', 'periodEndTime'
      ]));
      if (!expiry) return;

      tranches.push({
        id: `workbuddy-auto-${expiry}-${index}`,
        providerId: 'workbuddy',
        amount: remain,
        unit: '积分',
        expiry,
        note: `WorkBuddy · ${kindLabel(kind)}`,
        source: 'auto'
      });
      total = round2(total + remain);
    });
  }

  if (!tranches.length) {
    const totalCredits = toNumber(pick(root, ['TotalCredits', 'totalCredits', 'Total', 'total']));
    if (Number.isFinite(totalCredits) && totalCredits > 0) {
      const expiry = endOfMonthLocal();
      tranches.push({
        id: `workbuddy-auto-${expiry}-total`,
        providerId: 'workbuddy',
        amount: round2(totalCredits),
        unit: '积分',
        expiry,
        note: 'WorkBuddy · 总积分（按套餐月底到期估算）',
        source: 'auto'
      });
      total = round2(totalCredits);
    }
  }

  return { tranches, total };
}

function shortPackageLabel(name) {
  const raw = String(name || '');
  if (/赠送|bonus/i.test(raw)) return '赠送积分';
  if (/基础|套餐|base|plan/i.test(raw)) return '套餐积分';
  if (/加量|addon/i.test(raw)) return '加量包';
  if (/奖励|benefit/i.test(raw)) return '奖励积分';
  return '积分包';
}

function expiryOfCycle(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return localDate(value);
}

function parseResource(json) {
  const root = json && (json.data || json);
  const accounts = root && root.Response && root.Response.Data && root.Response.Data.Accounts;
  if (!Array.isArray(accounts)) return null;

  const groups = new Map();
  let total = 0;

  accounts.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const cycleSize = toNumber(item.CycleCapacitySize) || 0;
    const remain = cycleSize > 0
      ? toNumber(item.CycleCapacityRemain)
      : toNumber(item.CapacityRemain);
    if (!Number.isFinite(remain) || remain <= 0) return;

    const expiry = expiryOfCycle(item.CycleEndTime || item.ExpiredTime) ||
      deriveExpiry('addon', pick(item, ['ExpireTime', 'expireTime', 'EndTime', 'endTime']));
    if (!expiry) return;

    const label = shortPackageLabel(item.SubProductName || item.PackageName);
    const key = `${expiry}|${label}`;
    const current = groups.get(key) || { expiry, label, amount: 0, count: 0 };
    current.amount = round2(current.amount + remain);
    current.count += 1;
    groups.set(key, current);
    total = round2(total + remain);
  });

  const tranches = Array.from(groups.values())
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0))
    .map((g, index) => ({
      id: `workbuddy-auto-${g.expiry}-${index}`,
      providerId: 'workbuddy',
      amount: g.amount,
      unit: '积分',
      expiry: g.expiry,
      note: `WorkBuddy · ${g.label}${g.count > 1 ? `（${g.count} 包）` : ''}`,
      source: 'auto'
    }));

  return { tranches, total };
}

async function fetchBalance(token) {
  let lastError = '';
  for (const endpoint of BALANCE_ENDPOINTS) {
    const res = await requestJson(endpoint.url, {
      method: 'POST',
      headers: balanceHeaders(token),
      body: JSON.stringify(endpoint.body || {})
    });
    if (res.status === 401 || res.status === 403) {
      return { unauthorized: true, detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      continue;
    }
    const parsed = endpoint.parser === 'resource'
      ? (parseResource(res.json) || parseSummary(res.json))
      : (parseSummary(res.json) || parseResource(res.json));
    if (parsed && parsed.tranches.length) return { parsed, endpoint: endpoint.url };
    lastError = '响应里没有可解析的额度字段';
  }
  return { error: lastError || '额度接口没有返回数据' };
}

async function sync(cfg) {
  const wb = cfg.workbuddy || {};
  if (!wb.accessToken) {
    return {
      platform: 'workbuddy',
      ok: false,
      code: 'NEED_LOGIN',
      message: '未连接 WorkBuddy，请在“同步设置”里点“连接 WorkBuddy”'
    };
  }

  let tokens = null;
  let result = await fetchBalance(wb.accessToken);
  if (result.unauthorized && wb.refreshToken) {
    tokens = await refreshToken(cfg);
    if (tokens) result = await fetchBalance(tokens.accessToken);
  }

  if (result.unauthorized) {
    return {
      platform: 'workbuddy',
      ok: false,
      code: 'NEED_LOGIN',
      message: 'WorkBuddy 登录已失效，请重新连接'
    };
  }
  if (!result.parsed) {
    return {
      platform: 'workbuddy',
      ok: false,
      code: 'PARSE',
      message: `WorkBuddy 余额接口暂时不可用（${result.error}）`
    };
  }

  return {
    platform: 'workbuddy',
    ok: true,
    message: result.parsed.tranches.length
      ? `已同步 ${result.parsed.tranches.length} 个积分分组，共 ${result.parsed.total} 积分`
      : '接口已连通，但当前没有可用的积分',
    tranches: result.parsed.tranches,
    meta: { endpoint: result.endpoint, total: result.parsed.total },
    tokens
  };
}

module.exports = { sync, startLogin, pollLogin, refreshToken };
