'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const trae = require('./adapters/trae');
const workbuddy = require('./adapters/workbuddy');
const qoder = require('./adapters/qoder');

const PORT = Number(process.env.CREDIT_SYNC_PORT || 8797);
const CONFIG_PATH = path.join(__dirname, 'config.json');
const VERSION = '1.0.0';

const pendingLogins = new Map();

function defaultConfig() {
  return {
    port: PORT,
    qoderToken: '',
    workbuddy: {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      connectedAt: 0
    }
  };
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const base = defaultConfig();
    return {
      ...base,
      ...parsed,
      workbuddy: { ...base.workbuddy, ...(parsed.workbuddy || {}) }
    };
  } catch (e) {
    return defaultConfig();
  }
}

function saveConfig(cfg) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

function publicConfig(cfg) {
  const wb = cfg.workbuddy || {};
  return {
    workbuddy: {
      connected: !!wb.accessToken,
      expiresAt: wb.expiresAt || 0,
      connectedAt: wb.connectedAt || 0
    },
    qoder: { configured: !!cfg.qoderToken }
  };
}

function traeState() {
  try {
    const list = trae.listAuthCandidates();
    if (!list.length) return { available: false };
    const best = list[0];
    return {
      available: true,
      product: best.product,
      expiresAt: best.expMs || 0,
      expired: !!best.expMs && best.expMs < Date.now() + 60 * 1000
    };
  } catch (e) {
    return { available: false };
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null' || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

async function runSync() {
  const cfg = loadConfig();
  const tasks = [
    ['trae', () => trae.sync(cfg)],
    ['workbuddy', () => workbuddy.sync(cfg)],
    ['qoder', () => qoder.sync(cfg)]
  ];

  const results = await Promise.all(tasks.map(async ([platform, fn]) => {
    try {
      const result = await fn();
      if (platform === 'workbuddy' && result.tokens) {
        const fresh = loadConfig();
        fresh.workbuddy = {
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken || fresh.workbuddy.refreshToken,
          expiresAt: result.tokens.expiresAt || fresh.workbuddy.expiresAt,
          connectedAt: fresh.workbuddy.connectedAt || Date.now()
        };
        saveConfig(fresh);
        delete result.tokens;
      }
      console.log(`[sync] ${platform}: ${result.ok ? 'ok' : 'fail'} - ${result.message || ''}`);
      return result;
    } catch (e) {
      console.log(`[sync] ${platform}: error - ${e.message}`);
      return {
        platform,
        ok: false,
        code: 'EXCEPTION',
        message: e && e.message ? e.message : '同步失败'
      };
    }
  }));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    results
  };
}

const server = http.createServer(async (req, res) => {
  if (!setCors(req, res)) {
    sendJson(res, 403, { ok: false, message: 'origin not allowed' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        name: 'credit-workbench-sync',
        version: VERSION,
        time: new Date().toISOString()
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const cfg = loadConfig();
      sendJson(res, 200, {
        ok: true,
        config: publicConfig(cfg),
        trae: traeState(),
        serverTime: new Date().toISOString()
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const cfg = loadConfig();

      if (typeof body.qoderToken === 'string') {
        cfg.qoderToken = body.qoderToken.trim();
      }
      if (body.workbuddy && body.workbuddy.disconnect) {
        cfg.workbuddy = defaultConfig().workbuddy;
      }
      saveConfig(cfg);
      sendJson(res, 200, { ok: true, config: publicConfig(cfg) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/login/workbuddy/start') {
      const ticket = await workbuddy.startLogin();
      pendingLogins.set(ticket.state, Date.now());
      for (const [key, at] of pendingLogins) {
        if (Date.now() - at > 10 * 60 * 1000) pendingLogins.delete(key);
      }
      sendJson(res, 200, { ok: true, loginUrl: ticket.loginUrl, state: ticket.state });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/login/workbuddy/poll') {
      const state = url.searchParams.get('state') || '';
      if (!pendingLogins.has(state)) {
        sendJson(res, 200, { ok: true, status: 'expired', message: '登录会话已过期，请重新连接' });
        return;
      }
      const polled = await workbuddy.pollLogin(state);
      if (polled.status === 'ok') {
        const cfg = loadConfig();
        cfg.workbuddy = {
          accessToken: polled.tokens.accessToken,
          refreshToken: polled.tokens.refreshToken || '',
          expiresAt: polled.tokens.expiresAt || 0,
          connectedAt: Date.now()
        };
        saveConfig(cfg);
        pendingLogins.delete(state);
        sendJson(res, 200, { ok: true, status: 'ok', config: publicConfig(cfg) });
        return;
      }
      sendJson(res, 200, { ok: true, status: 'pending' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sync') {
      const result = await runSync();
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { ok: false, message: 'not found' });
  } catch (e) {
    sendJson(res, 500, { ok: false, message: e && e.message ? e.message : 'internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  积分工作台 · 本地同步服务');
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log('  数据只在本机读写，凭证保存在 sync/config.json');
  console.log('  关闭此窗口即可停止服务');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用：可能同步服务已在运行。`);
  } else {
    console.error('启动失败：', e.message);
  }
  process.exit(1);
});
