'use strict';

const DEFAULT_TIMEOUT = 20000;

async function requestJson(url, options = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-json */ }
    return { status: res.status, ok: res.ok, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function localDate(value) {
  if (value === null || value === undefined || value === '') return null;
  let ms;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    ms = n < 1e12 ? n * 1000 : n;
  } else {
    ms = Date.parse(value);
  }
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

function todayLocal() {
  return localDate(Date.now());
}

function addDaysLocal(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

function endOfMonthLocal() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 0);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lowered = {};
  Object.keys(obj).forEach((k) => { lowered[k.toLowerCase()] = obj[k]; });
  for (const key of keys) {
    const direct = obj[key];
    if (direct !== undefined && direct !== null && direct !== '') return direct;
    const loose = lowered[String(key).toLowerCase()];
    if (loose !== undefined && loose !== null && loose !== '') return loose;
  }
  return undefined;
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.-]/g, '');
    if (!cleaned) return NaN;
    return Number(cleaned);
  }
  return NaN;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  DEFAULT_TIMEOUT,
  requestJson,
  localDate,
  todayLocal,
  addDaysLocal,
  endOfMonthLocal,
  pick,
  toNumber,
  round2
};
