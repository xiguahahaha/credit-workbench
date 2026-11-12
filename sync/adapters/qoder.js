'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { requestJson, localDate, round2 } = require('../lib/http');

const USAGE_URL = 'https://openapi.qoder.com.cn/sash/api/v2/me/usage';
const PROFILE_DIR = path.join(process.env.APPDATA || '', 'com.qodercn.app.stable');
const AUTH_FILE = path.join(PROFILE_DIR, 'auth.v1.dat');
const DPAPI_HELPER = path.join(__dirname, '..', 'lib', 'qoder-dpapi-key.ps1');

const keyCache = {};

function readDpapiKey(profileDir) {
  if (keyCache[profileDir]) return Promise.resolve(keyCache[profileDir]);
  return new Promise((resolve, reject) => {
    execFile(
      'pwsh',
      ['-NoProfile', '-File', DPAPI_HELPER, '-ProfileDir', profileDir],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        const key = Buffer.from(String(stdout).trim(), 'base64');
        if (key.length !== 32) return reject(new Error('DPAPI 密钥长度异常'));
        keyCache[profileDir] = key;
        resolve(key);
      }
    );
  });
}

async function readClientToken() {
  if (!fs.existsSync(AUTH_FILE)) {
    return { error: '未找到 Qoder CN 登录文件，请先打开并登录 Qoder' };
  }
  try {
    const bytes = fs.readFileSync(AUTH_FILE);
    if (bytes.subarray(0, 3).toString() !== 'v10') {
      return { error: 'Qoder 登录态格式已变更' };
    }
    const key = await readDpapiKey(PROFILE_DIR);
    const nonce = bytes.subarray(3, 15);
    const tag = bytes.subarray(bytes.length - 16);
    const cipher = bytes.subarray(15, bytes.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
    const auth = JSON.parse(plain);
    if (!auth.token) return { error: 'Qoder 客户端未登录' };
    return {
      token: auth.token,
      expiresAt: auth.expiresAt || '',
      name: (auth.user && auth.user.name) || ''
    };
  } catch (e) {
    return { error: e.message || '读取 Qoder 登录态失败' };
  }
}

async function resolveToken(cfg) {
  const manual = String(cfg.qoderToken || '').trim();
  if (manual) return { token: manual, source: 'config' };
  return await readClientToken();
}

function authHeaders(token) {
  const headers = { 'Accept': 'application/json', 'User-Agent': 'Qoder' };
  if (token.includes('=')) headers.Cookie = token;
  else headers.Authorization = `Bearer ${token}`;
  return headers;
}

function pickLabel(item) {
  const labels = item.displayLabels;
  if (Array.isArray(labels)) {
    const title = labels.find((l) => l && l.dimension === 'title');
    if (title) {
      const i18n = title.valueI18n || {};
      if (i18n['zh-CN']) return String(i18n['zh-CN']);
      if (i18n.zh) return String(i18n.zh);
      if (title.value) return String(title.value);
    }
  }
  return item.name || item.title || '积分包';
}

function meaningfulDate(value) {
  const date = localDate(value);
  if (!date) return '';
  if (date > '2100-01-01') return '';
  return date;
}

function parseUsage(json) {
  const root = json && (json.data || json);
  const usage = root && (root.qoderUsage || root);
  if (!usage || typeof usage !== 'object') return null;

  const tranches = [];
  let total = 0;
  const packages = usage.dedicatedResourcePackages;

  if (Array.isArray(packages)) {
    packages.forEach((pkg, index) => {
      if (!pkg || typeof pkg !== 'object') return;
      if (pkg.available === false) return;
      const status = String(pkg.status || '');
      if (status && !status.includes('ACTIVE')) return;
      let remain = Number(pkg.remaining);
      if (!Number.isFinite(remain)) {
        const totalValue = Number(pkg.total);
        const usedValue = Number(pkg.used);
        if (Number.isFinite(totalValue) && Number.isFinite(usedValue)) remain = totalValue - usedValue;
      }
      if (!Number.isFinite(remain) || remain <= 0) return;
      const expiry = meaningfulDate(pkg.expiresAt);
      if (!expiry) return;
      tranches.push({
        id: `qoder-auto-${expiry}-${index}`,
        providerId: 'qoder',
        amount: round2(remain),
        unit: 'Credits',
        expiry,
        note: `Qoder · ${pickLabel(pkg)}`,
        source: 'auto'
      });
      total = round2(total + remain);
    });
  }

  if (!tranches.length) {
    const addOn = usage.addOnQuota;
    const addOnRemain = addOn && Number(addOn.remaining);
    if (Number.isFinite(addOnRemain) && addOnRemain > 0) {
      const expiry = meaningfulDate(usage.expiresAt);
      tranches.push({
        id: 'qoder-auto-balance',
        providerId: 'qoder',
        amount: round2(addOnRemain),
        unit: 'Credits',
        expiry,
        note: `Qoder · 积分余额${expiry ? '' : '（长期有效）'}`,
        source: 'auto'
      });
      total = round2(total + addOnRemain);
    }
  }

  if (!tranches.length) {
    const plan = usage.userQuota;
    const planRemain = plan && Number(plan.remaining);
    if (Number.isFinite(planRemain) && planRemain > 0) {
      tranches.push({
        id: 'qoder-auto-plan',
        providerId: 'qoder',
        amount: round2(planRemain),
        unit: 'Credits',
        expiry: '',
        note: 'Qoder · 套餐积分（长期有效）',
        source: 'auto'
      });
      total = round2(total + planRemain);
    }
  }

  return {
    tranches,
    total,
    isQuotaExceeded: usage.isQuotaExceeded === true,
    accountExpiry: usage.expiresAt || null
  };
}

async function sync(cfg) {
  const resolved = await resolveToken(cfg);
  if (!resolved || !resolved.token) {
    return {
      platform: 'qoder',
      ok: false,
      code: 'NEED_LOGIN',
      message: (resolved && resolved.error ? resolved.error : '未检测到 Qoder 登录态') +
        '，请打开 Qoder CN 客户端登录后重试'
    };
  }

  const res = await requestJson(USAGE_URL, { method: 'GET', headers: authHeaders(resolved.token) }, 25000);
  if (res.status === 401 || res.status === 403) {
    return {
      platform: 'qoder',
      ok: false,
      code: 'TOKEN_INVALID',
      message: 'Qoder 登录已失效，请重新登录客户端或在同步设置里更新令牌'
    };
  }
  if (!res.ok) {
    return {
      platform: 'qoder',
      ok: false,
      code: `HTTP_${res.status}`,
      message: `Qoder 用量接口返回 HTTP ${res.status}`
    };
  }

  const parsed = parseUsage(res.json);
  if (!parsed) {
    return {
      platform: 'qoder',
      ok: false,
      code: 'PARSE',
      message: 'Qoder 用量响应里没有可识别的额度字段'
    };
  }

  return {
    platform: 'qoder',
    ok: true,
    message: parsed.tranches.length
      ? `已同步 ${parsed.tranches.length} 个积分批次，共 ${parsed.total} Credits`
      : '接口已连通，但当前没有可用积分',
    tranches: parsed.tranches,
    meta: {
      source: resolved.source,
      isQuotaExceeded: parsed.isQuotaExceeded,
      accountExpiry: parsed.accountExpiry
    }
  };
}

module.exports = { sync };
