'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requestJson, localDate, todayLocal, round2 } = require('../lib/http');

const SALT_A = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const SALT_B = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const SALT_C = Uint8Array.from([191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209]);
const SALT_D = Uint8Array.from([246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170]);

const ENTITLEMENT_URL = 'https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list';

function xorSalts(a, b) {
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

function deriveKeyIv(randomBytes, isPrivate) {
  const salt = isPrivate ? xorSalts(SALT_C, SALT_D) : xorSalts(SALT_A, SALT_B);
  const h1 = crypto.createHash('sha512').update(Buffer.from(randomBytes)).digest();
  const fh = crypto.createHash('sha512').update(Buffer.concat([h1, Buffer.from(salt)])).digest();
  return { key: fh.subarray(0, 16), iv: fh.subarray(16, 32) };
}

function decryptTraeValue(b64) {
  const buf = Buffer.from(b64, 'base64');
  const header = buf.subarray(0, 6);
  const randomBytes = buf.subarray(6, 38);
  const encData = buf.subarray(38);
  const isAes = header[0] === 0x74 && header[1] === 0x63 && header[2] === 0x05 &&
    header[3] === 0x10 && header[4] === 0 && header[5] === 0;
  const isPrivate = header[0] === 18 && header[1] === 57 && header[2] === 32 &&
    header[3] === 32 && header[4] === 2 && header[5] === 3;
  if (!isAes && !isPrivate) throw new Error('未知的登录态加密格式');
  const { key, iv } = deriveKeyIv(randomBytes, isPrivate);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const out = Buffer.concat([decipher.update(encData), decipher.final()]);
  const storedHash = out.subarray(0, 64);
  const plain = out.subarray(64);
  const calc = crypto.createHash('sha512').update(plain).digest();
  if (!storedHash.equals(calc)) throw new Error('登录态校验失败，格式可能已变更');
  return plain.toString('utf8');
}

function findDeviceId(storage, storageFile) {
  const key = Object.keys(storage).find((k) => /^iCubeAuthInfo:\/\/icube-dc:\d+/.test(k));
  if (key) {
    const m = key.match(/icube-dc:(\d{6,})/);
    if (m) return m[1];
  }
  try {
    const productDir = path.dirname(path.dirname(path.dirname(storageFile)));
    const logDir = path.join(productDir, 'logs', 'aha_log');
    if (!fs.existsSync(logDir)) return '';
    for (const name of fs.readdirSync(logDir).filter((n) => /aha_electron.*\.log$/.test(n))) {
      const text = fs.readFileSync(path.join(logDir, name), 'latin1');
      const m = text.match(/InitDeviceId[^\r\n]{0,120}?device_id:\s*(\d{6,})/);
      if (m) return m[1];
    }
  } catch (e) { /* 忽略读取失败 */ }
  return '';
}

function tokenExpiryMs(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload && payload.exp) return payload.exp * 1000;
    }
  } catch (e) { /* 不是 JWT */ }
  return 0;
}

function listAuthCandidates() {
  const appData = process.env.APPDATA;
  if (!appData || !fs.existsSync(appData)) return [];
  const candidates = [];
  for (const name of fs.readdirSync(appData)) {
    if (!/trae/i.test(name)) continue;
    const file = path.join(appData, name, 'User', 'globalStorage', 'storage.json');
    if (!fs.existsSync(file)) continue;
    try {
      const storage = JSON.parse(fs.readFileSync(file, 'utf8'));
      const encrypted = storage['iCubeAuthInfo://icube.cloudide'];
      if (!encrypted) continue;
      const auth = String(encrypted).trim().startsWith('{')
        ? JSON.parse(encrypted)
        : JSON.parse(decryptTraeValue(encrypted));
      const token = auth.token || auth.accessToken;
      if (!token) continue;
      const expMs = tokenExpiryMs(token) || (auth.expiredAt ? Date.parse(auth.expiredAt) : 0);
      candidates.push({
        product: name,
        file,
        token,
        uid: auth.userId || auth.uid || '',
        expMs,
        deviceId: findDeviceId(storage, file)
      });
    } catch (e) { /* 跳过无法解析的客户端 */ }
  }
  return candidates.sort((a, b) => b.expMs - a.expMs);
}

function buildHeaders(auth) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Trae/0.1.52',
    'Authorization': `Cloud-IDE-JWT ${auth.token}`,
    'X-User-Region': 'CN',
    'x-device-brand': '83DG',
    'x-device-type': 'windows',
    'x-os-version': 'Windows 11 Pro',
    'x-app-version': '0.1.52'
  };
  if (auth.uid) headers['X-Uid'] = String(auth.uid);
  if (auth.deviceId) headers['x-device-id'] = String(auth.deviceId);
  return headers;
}

function findPacks(json) {
  if (!json) return null;
  const roots = [json, json.data, json.result, json.Result];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    if (Array.isArray(root.user_entitlement_pack_list)) return root.user_entitlement_pack_list;
    if (root.data && Array.isArray(root.data.user_entitlement_pack_list)) return root.data.user_entitlement_pack_list;
  }
  return null;
}

function aggregate(packs) {
  const groups = new Map();
  let total = 0;
  let usedPacks = 0;

  packs.forEach((pack) => {
    if (!pack || typeof pack !== 'object') return;
    const base = pack.entitlement_base_info || {};
    const quota = base.quota || {};
    const limit = Number(quota.credits_limit);
    if (!Number.isFinite(limit) || limit <= 0) return;

    const usedRaw = pack.usage && pack.usage.credits_amount;
    const used = Number.isFinite(Number(usedRaw)) ? Number(usedRaw) : 0;
    const remain = round2(limit - used);
    if (!(remain > 0)) return;

    const expiry = localDate(pack.expire_time || base.end_time || pack.yearly_expire_time);
    if (!expiry) return;
    if (expiry < todayLocal()) return;

    const label = String(pack.group_name || pack.display_desc || 'TRAE 权益包').trim() || 'TRAE 权益包';
    const key = `${expiry}|${label}`;
    const current = groups.get(key) || { expiry, label, amount: 0, packs: 0 };
    current.amount = round2(current.amount + remain);
    current.packs += 1;
    groups.set(key, current);
    total = round2(total + remain);
    usedPacks += 1;
  });

  const tranches = Array.from(groups.values())
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0))
    .map((g, index) => ({
      id: `trae-auto-${g.expiry}-${index}`,
      providerId: 'trae',
      amount: g.amount,
      unit: '积分',
      expiry: g.expiry,
      note: `TRAE · ${g.label}${g.packs > 1 ? `（${g.packs} 笔）` : ''}`,
      source: 'auto'
    }));

  return { tranches, total, usedPacks };
}

async function sync() {
  const candidates = listAuthCandidates();
  if (!candidates.length) {
    return {
      platform: 'trae',
      ok: false,
      code: 'NO_LOGIN',
      message: '未找到本机 TRAE 登录态，请先打开并登录 TRAE 客户端'
    };
  }

  const auth = candidates[0];
  if (auth.expMs && auth.expMs < Date.now() + 60 * 1000) {
    return {
      platform: 'trae',
      ok: false,
      code: 'TOKEN_EXPIRED',
      message: 'TRAE 登录已过期，请打开一次 TRAE 客户端后重试'
    };
  }

  const res = await requestJson(ENTITLEMENT_URL, {
    method: 'POST',
    headers: buildHeaders(auth),
    body: JSON.stringify({ require_usage: true })
  }, 25000);

  if (res.status === 401 || (res.json && Number(res.json.code) === 1001)) {
    return {
      platform: 'trae',
      ok: false,
      code: 'TOKEN_EXPIRED',
      message: 'TRAE 登录凭证已失效，请打开一次 TRAE 客户端后重试'
    };
  }
  if (!res.ok) {
    return {
      platform: 'trae',
      ok: false,
      code: `HTTP_${res.status}`,
      message: `TRAE 接口返回 HTTP ${res.status}`
    };
  }

  const packs = findPacks(res.json);
  if (!packs) {
    return {
      platform: 'trae',
      ok: false,
      code: 'PARSE',
      message: 'TRAE 接口响应里没有权益包列表'
    };
  }

  const result = aggregate(packs);
  return {
    platform: 'trae',
    ok: true,
    message: result.tranches.length
      ? `已同步 ${result.tranches.length} 个到期批次，共 ${result.total} 积分`
      : '接口已连通，但当前没有可用积分',
    tranches: result.tranches,
    meta: {
      product: auth.product,
      tokenExpiry: auth.expMs ? new Date(auth.expMs).toISOString() : null,
      packs: packs.length,
      expiringGroups: result.tranches.length,
      total: result.total
    }
  };
}

module.exports = { sync, listAuthCandidates };
