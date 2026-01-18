require('dotenv').config();

const { execSync } = require('child_process');
const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Resvg } = require('@resvg/resvg-js');
const PDFDocument = require('pdfkit');
const net = require('net');
const { getPrismaClient } = require('./prismaClient');
const { YandexGPTService } = require('./services/YandexGPTService');

function getYooKassaCredentials() {
  const shopId = typeof process.env.YOOKASSA_SHOP_ID === 'string' ? process.env.YOOKASSA_SHOP_ID.trim() : '';
  const secretKey = typeof process.env.YOOKASSA_SECRET_KEY === 'string' ? process.env.YOOKASSA_SECRET_KEY.trim() : '';

  if (!shopId) {
    const err = new Error('YOOKASSA_SHOP_ID не задан');
    err.statusCode = 500;
    throw err;
  }

  if (!secretKey) {
    const err = new Error('YOOKASSA_SECRET_KEY не задан');
    err.statusCode = 500;
    throw err;
  }

  return { shopId, secretKey };
}

function getYooKassaAuthorizationHeader() {
  const { shopId, secretKey } = getYooKassaCredentials();
  const token = Buffer.from(`${shopId}:${secretKey}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

async function yooKassaRequest({ method, path, idempotenceKey, data }) {
  const baseUrl = 'https://api.yookassa.ru/v3';
  const url = `${baseUrl}${path}`;

  const headers = {
    Authorization: getYooKassaAuthorizationHeader(),
    'Content-Type': 'application/json',
  };
  if (typeof idempotenceKey === 'string' && idempotenceKey.trim()) {
    headers['Idempotence-Key'] = idempotenceKey.trim();
  }

  const response = await axios.request({
    method,
    url,
    headers,
    data,
    timeout: 15000,
    validateStatus: () => true,
  });

  const status = Number(response?.status ?? 0);
  if (status >= 200 && status < 300) return response.data;

  const err = new Error('Ошибка YooKassa');
  err.statusCode = status >= 400 && status < 600 ? status : 502;
  throw err;
}

async function yooKassaCreatePayment({ payload, idempotenceKey }) {
  return await yooKassaRequest({ method: 'post', path: '/payments', idempotenceKey, data: payload });
}

async function yooKassaGetPayment(paymentId) {
  const id = typeof paymentId === 'string' ? paymentId.trim() : '';
  if (!id) {
    const err = new Error('Не удалось определить paymentId');
    err.statusCode = 400;
    throw err;
  }
  return await yooKassaRequest({ method: 'get', path: `/payments/${encodeURIComponent(id)}` });
}

function getYooKassaReturnUrl() {
  const returnUrl = process.env.YOOKASSA_RETURN_URL;
  if (returnUrl) return returnUrl;

  const err = new Error('YOOKASSA_RETURN_URL не задан');
  err.statusCode = 500;
  throw err;
}

function buildYooKassaReturnUrl(extraParams = {}) {
  try {
    const url = new URL(getYooKassaReturnUrl());

    url.searchParams.set('payment', 'success');

    if (typeof extraParams === 'object' && extraParams !== null) {
      for (const [key, value] of Object.entries(extraParams)) {
        if (typeof value === 'string' && value.trim()) {
          url.searchParams.set(key, value.trim());
        }
      }
    }

    return url.toString();
  } catch {
    const err = new Error('YOOKASSA_RETURN_URL должен быть валидным URL');
    err.statusCode = 500;
    throw err;
  }
}

function ensureDatabaseUrl() {
  if (process.env.DATABASE_URL) return;

  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT;
  const db = process.env.POSTGRES_DB;

  if (!user || !password || !host || !port || !db) return;

  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@${host}:${port}/${db}?schema=public`;
}

ensureDatabaseUrl();

function runPrismaMigrateDeploy() {
  if (!process.env.DATABASE_URL) return;
  if (process.env.DISABLE_PRISMA_MIGRATE === 'true') return;
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
}

runPrismaMigrateDeploy();

function redactScanResultForUnpaid(result) {
  if (typeof result !== 'object' || result === null) return result;
  const r = result;
  const next = { ...r };

  if (typeof next.full_analysis === 'string') next.full_analysis = '';
  if (typeof next.advice === 'string') next.advice = '';

  if (Array.isArray(next.flags)) {
    next.flags = [];
  }

  return next;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toIntInRange(value, min, max) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < min || i > max) return null;
  return i;
}

function toBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n') return false;
  return null;
}

function allowPublicById() {
  return toBoolean(process.env.ALLOW_PUBLIC_BY_ID) ?? false;
}

function getEnvInt(name) {
  const raw = typeof process.env[name] === 'string' ? process.env[name].trim() : '';
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function normalizeAnonymizationOptions(value) {
  if (!isPlainObject(value)) return null;
  const v = value;
  const enabled = v.enabled === true;
  if (!enabled) return { enabled: false };

  const maskLinks = v.maskLinks !== false;
  const maskEmails = v.maskEmails !== false;
  const maskPhones = v.maskPhones !== false;
  const maskUsernames = v.maskUsernames !== false;
  const maskCards = v.maskCards !== false;

  return {
    enabled: true,
    maskLinks,
    maskEmails,
    maskPhones,
    maskUsernames,
    maskCards,
  };
}

function anonymizeText(input, options) {
  if (!options || options.enabled !== true) return input;
  let out = String(input);

  if (options.maskLinks) {
    out = out
      .replace(/\bhttps?:\/\/[^\s)\]}]+/gi, '[ссылка]')
      .replace(/\bwww\.[^\s)\]}]+/gi, '[ссылка]');
  }

  if (options.maskEmails) {
    out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]');
  }

  if (options.maskPhones) {
    out = out.replace(/\+?\d[\d\s\-().]{7,}\d/g, '[телефон]');
  }

  if (options.maskCards) {
    out = out.replace(/\b(?:\d[ -]*?){13,19}\b/g, '[карта]');
  }

  if (options.maskUsernames) {
    out = out.replace(/@([\p{L}0-9_]{2,})/giu, '@***');
  }

  return out;
}

function computeAutoDeleteAt({ retentionHours }) {
  if (retentionHours === null) return null;
  const ms = retentionHours * 60 * 60 * 1000;
  return new Date(Date.now() + ms);
}

function getRetentionHoursFromRequestOrEnv({ reqRetentionHours, envName }) {
  const min = getEnvInt('RETENTION_HOURS_MIN') ?? 1;
  const max = getEnvInt('RETENTION_HOURS_MAX') ?? 8760;
  if (reqRetentionHours === 0 || reqRetentionHours === '0') return null;
  const fromReq = reqRetentionHours !== null ? toIntInRange(reqRetentionHours, min, max) : null;
  if (fromReq !== null) return fromReq;

  const fromEnv = getEnvInt(envName);
  if (fromEnv === null) return null;
  return toIntInRange(fromEnv, min, max);
}

function parseCookieHeader(headerValue) {
  const header = typeof headerValue === 'string' ? headerValue : '';
  if (!header) return {};
  const out = {};
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function getSessionSecret() {
  const secret = typeof process.env.SESSION_SECRET === 'string' ? process.env.SESSION_SECRET.trim() : '';
  if (!secret) {
    const err = new Error('SESSION_SECRET не задан');
    err.statusCode = 500;
    throw err;
  }
  if (secret.length < 32) {
    const err = new Error('SESSION_SECRET слишком короткий (нужно минимум 32 символа)');
    err.statusCode = 500;
    throw err;
  }
  return secret;
}

function hashSessionToken(token) {
  const secret = getSessionSecret();
  return crypto.createHash('sha256').update(`${secret}:${token}`).digest('hex');
}

function getRequestIp(req) {
  const xf = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
  const ip = (xf || req.ip || '').split(',')[0].trim();
  return ip || '';
}

function parseAllowedCidrs(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return [];
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function ipv6ToBytes(input) {
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;

  const mappedPrefix = '::ffff:';
  if (raw.startsWith(mappedPrefix)) {
    const v4 = ipv4ToInt(raw.slice(mappedPrefix.length));
    if (v4 === null) return null;
    const bytes = Buffer.alloc(16);
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes.writeUInt32BE(v4 >>> 0, 12);
    return bytes;
  }

  const hasDouble = raw.includes('::');
  const pieces = hasDouble ? raw.split('::') : [raw];
  if (hasDouble && pieces.length !== 2) return null;

  const left = hasDouble ? pieces[0] : raw;
  const right = hasDouble ? pieces[1] : '';

  const leftParts = left ? left.split(':').filter(Boolean) : [];
  const rightParts = right ? right.split(':').filter(Boolean) : [];
  if (leftParts.some((p) => p.length > 4) || rightParts.some((p) => p.length > 4)) return null;

  const missing = hasDouble ? 8 - (leftParts.length + rightParts.length) : 0;
  if (!hasDouble && leftParts.length !== 8) return null;
  if (hasDouble && missing < 0) return null;

  const parts = hasDouble
    ? leftParts.concat(new Array(missing).fill('0')).concat(rightParts)
    : leftParts;
  if (parts.length !== 8) return null;

  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    const v = Number.parseInt(parts[i], 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
    bytes.writeUInt16BE(v, i * 2);
  }
  return bytes;
}

function parseCidr(cidr) {
  const raw = typeof cidr === 'string' ? cidr.trim() : '';
  if (!raw) return null;
  const idx = raw.lastIndexOf('/');
  const ipStr = idx === -1 ? raw : raw.slice(0, idx);
  const prefixStr = idx === -1 ? '' : raw.slice(idx + 1);

  const family = net.isIP(ipStr);
  if (family === 4) {
    const ipInt = ipv4ToInt(ipStr);
    if (ipInt === null) return null;
    const prefix = prefixStr ? Number(prefixStr) : 32;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { family: 4, ipInt, prefix };
  }
  if (family === 6) {
    const ipBytes = ipv6ToBytes(ipStr);
    if (!ipBytes) return null;
    const prefix = prefixStr ? Number(prefixStr) : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    return { family: 6, ipBytes, prefix };
  }
  return null;
}

function isIpInCidr(ip, cidr) {
  const family = net.isIP(ip);
  const parsed = parseCidr(cidr);
  if (!parsed || !family) return false;

  if (family === 4 && parsed.family === 4) {
    const ipInt = ipv4ToInt(ip);
    if (ipInt === null) return false;
    if (parsed.prefix === 0) return true;
    const mask = parsed.prefix === 32 ? 0xffffffff : (0xffffffff << (32 - parsed.prefix)) >>> 0;
    return (ipInt & mask) === (parsed.ipInt & mask);
  }

  if (family === 6 && parsed.family === 6) {
    const ipBytes = ipv6ToBytes(ip);
    if (!ipBytes) return false;
    const bits = parsed.prefix;
    const fullBytes = Math.floor(bits / 8);
    const restBits = bits % 8;

    for (let i = 0; i < fullBytes; i += 1) {
      if (ipBytes[i] !== parsed.ipBytes[i]) return false;
    }

    if (restBits === 0) return true;
    const mask = (0xff << (8 - restBits)) & 0xff;
    return (ipBytes[fullBytes] & mask) === (parsed.ipBytes[fullBytes] & mask);
  }

  return false;
}

function verifyWebhookRequest(req) {
  const shopId = typeof process.env.YOOKASSA_SHOP_ID === 'string' ? process.env.YOOKASSA_SHOP_ID.trim() : '';
  const secretKey = typeof process.env.YOOKASSA_SECRET_KEY === 'string' ? process.env.YOOKASSA_SECRET_KEY.trim() : '';

  const expectedToken = typeof process.env.YOOKASSA_WEBHOOK_TOKEN === 'string' ? process.env.YOOKASSA_WEBHOOK_TOKEN.trim() : '';
  const allowedCidrs = parseAllowedCidrs(process.env.YOOKASSA_WEBHOOK_ALLOWED_CIDRS);

  if (shopId && secretKey && !expectedToken && allowedCidrs.length === 0) {
    const err = new Error('Webhook: не задан YOOKASSA_WEBHOOK_TOKEN или YOOKASSA_WEBHOOK_ALLOWED_CIDRS');
    err.statusCode = 500;
    throw err;
  }

  if (expectedToken) {
    const tokenFromPath = typeof req.params?.token === 'string' ? req.params.token.trim() : '';
    const tokenFromQuery = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
    const got = tokenFromPath || tokenFromQuery;
    if (!got || got !== expectedToken) {
      const err = new Error('Webhook: недействительный токен');
      err.statusCode = 403;
      throw err;
    }
  }

  if (allowedCidrs.length > 0) {
    const ip = getRequestIp(req);
    const ok = allowedCidrs.some((cidr) => isIpInCidr(ip, cidr));
    if (!ok) {
      const err = new Error('Webhook: запрещённый IP');
      err.statusCode = 403;
      throw err;
    }
  }
}

function normalizeOrigin(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.origin;
  } catch {
    return '';
  }
}

function getAllowedOriginsFromEnv() {
  const raw = typeof process.env.CORS_ORIGIN === 'string' ? process.env.CORS_ORIGIN : '';
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((x) => normalizeOrigin(x))
    .filter(Boolean);
}

function isSameOriginRequest(req) {
  const origin = normalizeOrigin(req.headers.origin);
  if (!origin) {
    const ref = typeof req.headers.referer === 'string' ? req.headers.referer : '';
    const refOrigin = normalizeOrigin(ref);
    if (!refOrigin) return false;
    const allowed = getAllowedOriginsFromEnv();
    if (allowed.length > 0) return allowed.includes(refOrigin);
    const base = normalizeOrigin(getBaseUrl(req));
    return Boolean(base) && base === refOrigin;
  }

  const allowed = getAllowedOriginsFromEnv();
  if (allowed.length > 0) return allowed.includes(origin);
  const base = normalizeOrigin(getBaseUrl(req));
  return Boolean(base) && base === origin;
}

function hashIp(ip) {
  if (!ip) return null;
  const secret = getSessionSecret();
  return crypto.createHash('sha256').update(`${secret}:ip:${ip}`).digest('hex');
}

function isSecureRequest(req) {
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'] : '';
  const proto = (forwardedProto || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https') return true;
  if (proto === 'http') return false;
  if (typeof req.secure === 'boolean') return req.secure;
  return false;
}

function buildCookieSetHeader(name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push('Path=/');
  if (options?.httpOnly) parts.push('HttpOnly');
  if (options?.secure) parts.push('Secure');
  const sameSite = options?.sameSite;
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (typeof options?.maxAgeSeconds === 'number') parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAgeSeconds))}`);
  return parts.join('; ');
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const raw = typeof stored === 'string' ? stored : '';
  const parts = raw.split('$');
  if (parts.length !== 3) return false;
  const algo = parts[0];
  const salt = parts[1];
  const hash = parts[2];
  if (algo !== 'scrypt') return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
  } catch {
    return false;
  }
}

function normalizeEmail(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!v) return '';
  if (v.length > 254) return '';
  if (!/^\S+@\S+\.\S+$/.test(v)) return '';
  return v;
}

async function getAuthContext(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const sid = typeof cookies.sid === 'string' ? cookies.sid : '';
  if (!sid) return null;
  const tokenHash = hashSessionToken(sid);
  const prisma = getPrismaClient();
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt <= new Date()) return null;
  if (!session.user) return null;
  await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  return { session, user: session.user };
}

function requireAuth(handler) {
  return async (req, res, next) => {
    try {
      const ctx = await getAuthContext(req);
      if (!ctx) {
        const err = new Error('Нужна авторизация');
        err.statusCode = 401;
        throw err;
      }
      req.auth = { userId: ctx.user.id, email: ctx.user.email, sessionId: ctx.session.id };
      await handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

function optionalAuth(handler) {
  return async (req, res, next) => {
    try {
      const ctx = await getAuthContext(req);
      if (ctx) {
        req.auth = { userId: ctx.user.id, email: ctx.user.email, sessionId: ctx.session.id };
      }
      await handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

function makeShareId() {
  return crypto.randomBytes(16).toString('hex');
}

async function findPublicScanByToken({ prisma, token }) {
  const byShare = await prisma.scan.findUnique({ where: { shareId: token } });
  if (byShare) return byShare;
  if (!allowPublicById()) return null;
  return await prisma.scan.findUnique({ where: { id: token } });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function getBaseUrl(req) {
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'] : '';
  const proto = (forwardedProto || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function normalizeVerdict(result) {
  if (typeof result !== 'object' || result === null) {
    return {
      rating: 50,
      short_verdict: 'Нужна диагностика',
      teaser: 'Ссылка выглядит рабочей. Но данные отчёта не распарсились…',
    };
  }

  const r = result;
  const rating = Number(r.rating ?? r.score);
  const shortVerdict = typeof (r.short_verdict ?? r.verdict) === 'string' ? String(r.short_verdict ?? r.verdict) : '';
  const teaser = typeof r.teaser === 'string' ? r.teaser : '';

  return {
    rating: Number.isFinite(rating) ? Math.max(0, Math.min(100, Math.round(rating))) : 50,
    short_verdict: shortVerdict.trim() || 'Похоже, тут что-то есть',
    teaser: teaser.trim() || 'Мы нашли пару странных моментов. И это только начало…',
  };
}

function pickOgPalette(rating) {
  if (rating >= 81) {
    return {
      accent: '#ef4444',
      accent2: '#fb7185',
      label: 'СРОЧНО БЕГИ',
    };
  }

  if (rating <= 29) {
    return {
      accent: '#34d399',
      accent2: '#22c55e',
      label: 'ПОХОЖЕ НОРМ',
    };
  }

  return {
    accent: '#d946ef',
    accent2: '#a855f7',
    label: 'ОСТОРОЖНО',
  };
}

function renderOgSvg({ rating, shortVerdict, teaser }) {
  const palette = pickOgPalette(rating);
  const title = escapeXml(shortVerdict);
  const subtitle = escapeXml(teaser.length > 180 ? `${teaser.slice(0, 179).trim()}…` : teaser);
  const label = escapeXml(palette.label);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#020617" />
      <stop offset="1" stop-color="#0b1226" />
    </linearGradient>
    <radialGradient id="glow" cx="25%" cy="20%" r="70%">
      <stop offset="0" stop-color="${palette.accent}" stop-opacity="0.24" />
      <stop offset="1" stop-color="${palette.accent}" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="glow2" cx="85%" cy="25%" r="70%">
      <stop offset="0" stop-color="${palette.accent2}" stop-opacity="0.18" />
      <stop offset="1" stop-color="${palette.accent2}" stop-opacity="0" />
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)" />
  <rect width="1200" height="630" fill="url(#glow)" />
  <rect width="1200" height="630" fill="url(#glow2)" />

  <g font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial">
    <text x="80" y="110" fill="#e2e8f0" font-size="28" font-weight="800" letter-spacing="6">REDFLAG SCANNER</text>

    <g transform="translate(80 170)">
      <rect x="0" y="0" width="220" height="54" rx="27" fill="${palette.accent}" fill-opacity="0.18" stroke="${palette.accent}" stroke-opacity="0.35" />
      <text x="110" y="36" text-anchor="middle" fill="#ffffff" font-size="16" font-weight="900" letter-spacing="4">${label}</text>
    </g>

    <g transform="translate(80 260)">
      <text x="0" y="0" fill="#ffffff" font-size="92" font-weight="900">${rating}</text>
      <text x="168" y="-12" fill="#94a3b8" font-size="24" font-weight="800" letter-spacing="4">/ 100</text>
      <text x="0" y="64" fill="#94a3b8" font-size="18" font-weight="800" letter-spacing="6">РЕЙТИНГ</text>
    </g>

    <g transform="translate(80 390)">
      <text x="0" y="0" fill="#ffffff" font-size="58" font-weight="900">${title}</text>
    </g>

    <g transform="translate(80 458)">
      <text x="0" y="0" fill="#cbd5e1" font-size="28" font-weight="600">${subtitle}</text>
    </g>

    <g transform="translate(80 560)">
      <text x="0" y="0" fill="#94a3b8" font-size="22" font-weight="700">Открой отчёт по ссылке</text>
    </g>
  </g>
</svg>`;
}

const app = express();

app.set('trust proxy', 1);

const defaultLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Слишком много запросов. Попробуй позже.' });
  },
});

const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Слишком много сканирований. Приходи позже или купи безлимит.',
    });
  },
});

const askLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Слишком много вопросов. Попробуй позже.' });
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Слишком много попыток. Попробуй позже.' });
  },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Слишком много запросов. Попробуй позже.' });
  },
});

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    credentials: true,
  }),
);

app.use(defaultLimiter);

app.use(express.json({ limit: '2mb' }));

const yandex = new YandexGPTService();

function getSessionTtlSeconds() {
  const hours = getEnvInt('SESSION_TTL_HOURS') ?? 720;
  if (!Number.isFinite(hours) || hours < 1 || hours > 8760) {
    const err = new Error('SESSION_TTL_HOURS должен быть числом от 1 до 8760');
    err.statusCode = 500;
    throw err;
  }
  return Math.trunc(hours) * 60 * 60;
}

function setSidCookie(req, res, token, maxAgeSeconds) {
  const secure = toBoolean(process.env.COOKIE_SECURE) ?? isSecureRequest(req);
  const sameSite = (typeof process.env.COOKIE_SAMESITE === 'string' ? process.env.COOKIE_SAMESITE.trim() : '') || 'Lax';
  const header = buildCookieSetHeader('sid', token, { httpOnly: true, secure, sameSite, maxAgeSeconds });
  res.setHeader('Set-Cookie', header);
}

function clearSidCookie(req, res) {
  const secure = toBoolean(process.env.COOKIE_SECURE) ?? isSecureRequest(req);
  const sameSite = (typeof process.env.COOKIE_SAMESITE === 'string' ? process.env.COOKIE_SAMESITE.trim() : '') || 'Lax';
  const header = buildCookieSetHeader('sid', '', { httpOnly: true, secure, sameSite, maxAgeSeconds: 0 });
  res.setHeader('Set-Cookie', header);
}

function getCsrfTtlSeconds() {
  const hours = getEnvInt('CSRF_TTL_HOURS') ?? 24;
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
    const err = new Error('CSRF_TTL_HOURS должен быть числом от 1 до 720');
    err.statusCode = 500;
    throw err;
  }
  return Math.trunc(hours) * 60 * 60;
}

function makeCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function setCsrfCookie(req, res, token, maxAgeSeconds) {
  const secure = toBoolean(process.env.COOKIE_SECURE) ?? isSecureRequest(req);
  const sameSite = (typeof process.env.COOKIE_SAMESITE === 'string' ? process.env.COOKIE_SAMESITE.trim() : '') || 'Lax';
  const header = buildCookieSetHeader('csrf', token, { httpOnly: false, secure, sameSite, maxAgeSeconds });
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', header);
    return;
  }
  const next = Array.isArray(prev) ? prev.concat([header]) : [prev, header];
  res.setHeader('Set-Cookie', next);
}

function verifyCsrf(req) {
  if (!isSameOriginRequest(req)) {
    const err = new Error('CSRF: неподходящий Origin');
    err.statusCode = 403;
    throw err;
  }

  const cookies = parseCookieHeader(req.headers.cookie);
  const csrfCookie = typeof cookies.csrf === 'string' ? cookies.csrf : '';
  const csrfHeader = typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '';

  if (!csrfCookie || !csrfHeader) {
    const err = new Error('CSRF: токен обязателен');
    err.statusCode = 403;
    throw err;
  }

  if (csrfCookie.length < 16 || csrfCookie.length > 256 || csrfHeader.length < 16 || csrfHeader.length > 256) {
    const err = new Error('CSRF: некорректный токен');
    err.statusCode = 403;
    throw err;
  }

  try {
    const a = Buffer.from(csrfCookie, 'utf8');
    const b = Buffer.from(csrfHeader, 'utf8');
    if (a.length !== b.length) {
      const err = new Error('CSRF: токен не совпадает');
      err.statusCode = 403;
      throw err;
    }
    if (!crypto.timingSafeEqual(a, b)) {
      const err = new Error('CSRF: токен не совпадает');
      err.statusCode = 403;
      throw err;
    }
  } catch {
    const err = new Error('CSRF: токен не совпадает');
    err.statusCode = 403;
    throw err;
  }
}

function requireCsrf(handler) {
  return async (req, res, next) => {
    try {
      verifyCsrf(req);
      await handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

async function createSessionForUser({ req, user }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const prisma = getPrismaClient();
  const ttlSeconds = getSessionTtlSeconds();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : null;
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt,
      ipHash,
      userAgent,
    },
  });
  return { token, session };
}

app.get('/api/auth/me', authLimiter, async (req, res, next) => {
  try {
    const ctx = await getAuthContext(req);
    if (!ctx) {
      res.json({ user: null });
      return;
    }
    res.json({ user: { id: ctx.user.id, email: ctx.user.email } });
  } catch (err) {
    next(err);
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    const prisma = getPrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get('/api/auth/csrf', authLimiter, async (req, res, next) => {
  try {
    const token = makeCsrfToken();
    setCsrfCookie(req, res, token, getCsrfTtlSeconds());
    res.status(200).setHeader('Cache-Control', 'no-store').json({ csrfToken: token });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/register', authLimiter, requireCsrf(async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email) {
      const err = new Error('Некорректный email');
      err.statusCode = 400;
      throw err;
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      const err = new Error('Пароль должен быть длиной от 8 до 200 символов');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) {
      const err = new Error('Пользователь уже существует');
      err.statusCode = 409;
      throw err;
    }

    const passwordHash = createPasswordHash(password);
    const user = await prisma.user.create({ data: { email, passwordHash } });
    const { token } = await createSessionForUser({ req, user });
    setSidCookie(req, res, token, getSessionTtlSeconds());
    const csrfToken = makeCsrfToken();
    setCsrfCookie(req, res, csrfToken, getCsrfTtlSeconds());
    res.json({ user: { id: user.id, email: user.email }, csrfToken });
  } catch (err) {
    next(err);
  }
}));

app.post('/api/auth/login', authLimiter, requireCsrf(async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email) {
      const err = new Error('Некорректный email');
      err.statusCode = 400;
      throw err;
    }
    if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
      const err = new Error('Некорректный пароль');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const user = await prisma.user.findUnique({ where: { email } });
    const ok = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, createPasswordHash('dummy_password_123'));
    if (!user || !ok) {
      const err = new Error('Неверный email или пароль');
      err.statusCode = 401;
      throw err;
    }

    const { token } = await createSessionForUser({ req, user });
    setSidCookie(req, res, token, getSessionTtlSeconds());
    const csrfToken = makeCsrfToken();
    setCsrfCookie(req, res, csrfToken, getCsrfTtlSeconds());
    res.json({ user: { id: user.id, email: user.email }, csrfToken });
  } catch (err) {
    next(err);
  }
}));

app.post('/api/auth/logout', authLimiter, requireCsrf(async (req, res, next) => {
  try {
    const ctx = await getAuthContext(req);
    if (ctx) {
      const prisma = getPrismaClient();
      await prisma.session.update({
        where: { id: ctx.session.id },
        data: { revokedAt: new Date() },
      });
    }
    clearSidCookie(req, res);
    const csrfToken = makeCsrfToken();
    setCsrfCookie(req, res, csrfToken, getCsrfTtlSeconds());
    res.json({ ok: true, csrfToken });
  } catch (err) {
    next(err);
  }
}));

app.get('/r/:token', async (req, res) => {
  const token = typeof req.params?.token === 'string' ? req.params.token.trim() : '';
  if (!token) {
    res.status(400).type('text/html; charset=utf-8').send('<h1>Некорректная ссылка</h1>');
    return;
  }

  const prisma = getPrismaClient();
  const scan = await findPublicScanByToken({ prisma, token });
  if (!scan || scan.isPublic !== true) {
    res.status(404).type('text/html; charset=utf-8').send('<h1>Отчёт не найден</h1>');
    return;
  }

  const verdict = normalizeVerdict(scan.result);
  const baseUrl = getBaseUrl(req);
  const shareUrl = `${baseUrl}/r/${encodeURIComponent(scan.shareId)}`;
  const openUrl = `${baseUrl}/?shareId=${encodeURIComponent(scan.shareId)}`;
  const ogImage = `${baseUrl}/api/og/scan/${encodeURIComponent(scan.shareId)}.svg?p=${scan.isPaid ? '1' : '0'}`;

  const title = `RedFlag Scanner — ${verdict.short_verdict}`;
  const description = `Рейтинг: ${verdict.rating}/100. ${verdict.teaser}`;

  res
    .status(200)
    .setHeader('Cache-Control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(`<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />

    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(shareUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
  </head>
  <body style="margin:0;background:#020617;color:#e2e8f0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial">
    <main style="max-width:920px;margin:0 auto;padding:48px 20px;display:grid;gap:18px">
      <div style="display:inline-flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);padding:10px 14px;border-radius:999px;width:max-content">
        <span style="width:8px;height:8px;border-radius:999px;background:#ef4444;box-shadow:0 0 18px rgba(239,68,68,0.55)"></span>
        <span style="font-size:12px;font-weight:800;letter-spacing:0.22em;text-transform:uppercase">RedFlag Scanner</span>
      </div>
      <h1 style="margin:0;font-size:40px;letter-spacing:-0.02em">${escapeHtml(verdict.short_verdict)}</h1>
      <p style="margin:0;color:rgba(226,232,240,0.78);font-size:18px;line-height:1.5">${escapeHtml(verdict.teaser)}</p>
      <p style="margin:0;color:rgba(148,163,184,0.9);font-weight:800;letter-spacing:0.18em;text-transform:uppercase">Рейтинг: ${escapeHtml(String(verdict.rating))} / 100</p>
      <a href="${escapeHtml(openUrl)}" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none;color:#fff;background:linear-gradient(90deg,#ef4444,#fb7185,#d946ef);padding:18px 22px;border-radius:18px;font-weight:900;letter-spacing:0.14em;text-transform:uppercase;width:max-content">
        Открыть отчёт
      </a>
      <p style="margin:0;color:rgba(148,163,184,0.85);font-size:14px">Если не открылось автоматически, нажми кнопку выше.</p>
    </main>
    <script>
      setTimeout(function () {
        try { window.location.replace(${JSON.stringify(openUrl)}); } catch {};
      }, 900);
    </script>
  </body>
</html>`);
});

app.get('/api/og/scan/:token.svg', async (req, res, next) => {
  try {
    const token = typeof req.params?.token === 'string' ? req.params.token.trim() : '';
    if (!token) {
      const err = new Error('Поле token обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const scan = await findPublicScanByToken({ prisma, token });
    if (!scan || scan.isPublic !== true) {
      const err = new Error('Скан не найден');
      err.statusCode = 404;
      throw err;
    }

    const verdict = normalizeVerdict(scan.result);
    const svg = renderOgSvg({
      rating: verdict.rating,
      shortVerdict: verdict.short_verdict,
      teaser: verdict.teaser,
    });

    res
      .status(200)
      .setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
      .setHeader('Cache-Control', 'public, max-age=300')
      .send(svg);
  } catch (err) {
    next(err);
  }
});

app.get('/api/og/scan/:token.png', async (req, res, next) => {
  try {
    const token = typeof req.params?.token === 'string' ? req.params.token.trim() : '';
    if (!token) {
      const err = new Error('Поле token обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const scan = await findPublicScanByToken({ prisma, token });
    if (!scan || scan.isPublic !== true) {
      const err = new Error('Скан не найден');
      err.statusCode = 404;
      throw err;
    }

    const verdict = normalizeVerdict(scan.result);
    const svg = renderOgSvg({
      rating: verdict.rating,
      shortVerdict: verdict.short_verdict,
      teaser: verdict.teaser,
    });

    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
    const png = resvg.render().asPng();

    res
      .status(200)
      .setHeader('Content-Type', 'image/png')
      .setHeader('Cache-Control', 'public, max-age=300')
      .send(png);
  } catch (err) {
    next(err);
  }
});

function sanitizePdfLine(value) {
  const s = typeof value === 'string' ? value : '';
  return s.replace(/\u0000/g, '').trim();
}

function writePdfSection(doc, title, body) {
  const t = sanitizePdfLine(title);
  const b = sanitizePdfLine(body);
  if (!t || !b) return;
  doc.fontSize(13).font('Helvetica-Bold').text(t);
  doc.moveDown(0.35);
  doc.fontSize(11).font('Helvetica').text(b, { lineGap: 2 });
  doc.moveDown(0.9);
}

function writePdfList(doc, title, items) {
  const t = sanitizePdfLine(title);
  if (!t || !Array.isArray(items) || items.length === 0) return;
  doc.fontSize(13).font('Helvetica-Bold').text(t);
  doc.moveDown(0.35);
  doc.fontSize(11).font('Helvetica');
  for (const item of items) {
    const line = sanitizePdfLine(item);
    if (!line) continue;
    doc.text(`• ${line}`, { indent: 12, lineGap: 2 });
  }
  doc.moveDown(0.9);
}

function extractFlagLines(result) {
  if (typeof result !== 'object' || result === null) return [];
  const flags = Array.isArray(result.flags) ? result.flags : [];
  const out = [];
  for (const f of flags) {
    if (typeof f !== 'object' || f === null) continue;
    const category = typeof f.category === 'string' ? f.category.trim() : '';
    const severity = Number(f.severity);
    const quote = typeof f.quote === 'string' ? f.quote.trim() : '';
    const pieces = [];
    if (category) pieces.push(category);
    if (Number.isFinite(severity)) pieces.push(`Серьёзность: ${Math.max(0, Math.min(100, Math.round(severity)))}/100`);
    if (quote) pieces.push(`Цитата: ${quote}`);
    if (pieces.length) out.push(pieces.join(' — '));
  }
  return out.slice(0, 40);
}

app.get('/api/scan/public/:token.pdf', async (req, res, next) => {
  try {
    const token = typeof req.params?.token === 'string' ? req.params.token.trim() : '';
    if (!token) {
      const err = new Error('Поле token обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const scan = await findPublicScanByToken({ prisma, token });
    if (!scan || scan.isPublic !== true) {
      const err = new Error('Скан не найден');
      err.statusCode = 404;
      throw err;
    }

    const safeResult = scan.isPaid ? scan.result : redactScanResultForUnpaid(scan.result);
    const verdict = normalizeVerdict(safeResult);
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/r/${encodeURIComponent(scan.shareId)}`;

    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="redflag-scan-${scan.shareId}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');

    const doc = new PDFDocument({ size: 'A4', margin: 54, info: { Title: 'RedFlag Scanner — отчёт' } });
    doc.pipe(res);

    const done = new Promise((resolve, reject) => {
      doc.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
    });

    doc.font('Helvetica-Bold').fontSize(18).text('RedFlag Scanner');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(11).text(`Ссылка: ${shareUrl}`);
    doc.moveDown(1.0);

    doc.font('Helvetica-Bold').fontSize(14).text(`Рейтинг: ${verdict.rating} / 100`);
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(16).text(verdict.short_verdict);
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).text(verdict.teaser, { lineGap: 2 });
    doc.moveDown(1.0);

    writePdfSection(doc, 'Полный разбор', safeResult?.full_analysis);
    writePdfSection(doc, 'Совет', safeResult?.advice);
    writePdfList(doc, 'Красные флаги', extractFlagLines(safeResult));

    doc.end();
    await done;
  } catch (err) {
    next(err);
  }
});

app.post(
  '/api/analyze',
  requireAuth(requireCsrf(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const consent = req.body?.consent === true;
    const anonymization = normalizeAnonymizationOptions(req.body?.anonymization);
    const retentionHours = getRetentionHoursFromRequestOrEnv({
      reqRetentionHours: req.body?.retentionHours ?? null,
      envName: 'ANALYSIS_RETENTION_HOURS',
    });
    if (!text) {
      res.status(400).json({ error: 'Поле text обязательно' });
      return;
    }

    if (!consent) {
      res.status(400).json({ error: 'Нужно согласие на обработку персональных данных' });
      return;
    }

    const textForAi = anonymizeText(text, anonymization);
    const result = await yandex.analyzeText(textForAi);

    const prisma = getPrismaClient();
    const analysis = await prisma.analysis.create({
      data: {
        originalText: textForAi,
        result,
        isPaid: false,
        consentGiven: true,
        consentAt: new Date(),
        autoDeleteAt: computeAutoDeleteAt({ retentionHours }),
        anonymization,
        userId: req.auth.userId,
      },
    });

    res.json({
      id: analysis.id,
      originalText: analysis.originalText,
      result: analysis.result,
      isPaid: analysis.isPaid,
      createdAt: analysis.createdAt,
      autoDeleteAt: analysis.autoDeleteAt,
      anonymization: analysis.anonymization,
      userId: analysis.userId,
    });
  })),
);

app.post(
  '/api/scan',
  scanLimiter,
  optionalAuth(requireCsrf(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const consent = req.body?.consent === true;
    const anonymization = normalizeAnonymizationOptions(req.body?.anonymization);
    const retentionHours = getRetentionHoursFromRequestOrEnv({
      reqRetentionHours: req.body?.retentionHours ?? null,
      envName: 'SCAN_RETENTION_HOURS',
    });
    if (!text) {
      const err = new Error('Поле text обязательно');
      err.statusCode = 400;
      throw err;
    }

    if (!consent) {
      const err = new Error('Нужно согласие на обработку персональных данных');
      err.statusCode = 400;
      throw err;
    }

    const textForAi = anonymizeText(text, anonymization);
    const result = await yandex.scan(textForAi);

    const prisma = getPrismaClient();
    const scan = await prisma.scan.create({
      data: {
        text: textForAi,
        result,
        isPaid: false,
        consentGiven: true,
        consentAt: new Date(),
        autoDeleteAt: computeAutoDeleteAt({ retentionHours }),
        anonymization,
        userId: req.auth?.userId ?? null,
        shareId: makeShareId(),
        isPublic: true,
      },
    });

    res.json({
      id: scan.id,
      shareId: scan.shareId,
      isPublic: scan.isPublic,
      text: scan.text,
      result: redactScanResultForUnpaid(scan.result),
      isPaid: scan.isPaid,
      createdAt: scan.createdAt,
      autoDeleteAt: scan.autoDeleteAt,
      anonymization: scan.anonymization,
      userId: scan.userId,
    });
  })),
);

app.get('/api/scan/public/:token', async (req, res, next) => {
  try {
    const token = typeof req.params?.token === 'string' ? req.params.token.trim() : '';
    if (!token) {
      const err = new Error('Поле token обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const scan = await findPublicScanByToken({ prisma, token });
    if (!scan || scan.isPublic !== true) {
      const err = new Error('Скан не найден');
      err.statusCode = 404;
      throw err;
    }

    res.json({
      id: scan.id,
      shareId: scan.shareId,
      isPublic: scan.isPublic,
      text: scan.text,
      result: scan.isPaid ? scan.result : redactScanResultForUnpaid(scan.result),
      isPaid: scan.isPaid,
      createdAt: scan.createdAt,
      autoDeleteAt: scan.autoDeleteAt,
      anonymization: scan.anonymization,
    });
  } catch (err) {
    next(err);
  }
});

app.delete(
  '/api/scan/:id',
  requireAuth(requireCsrf(async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      const err = new Error('Поле id обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const deleted = await prisma.scan.deleteMany({ where: { id, userId: req.auth.userId } });
    if ((deleted?.count ?? 0) === 0) {
      const notFound = new Error('Скан не найден');
      notFound.statusCode = 404;
      throw notFound;
    }
    res.json({ deleted: true });
  })),
);

app.delete(
  '/api/analysis/:id',
  requireAuth(requireCsrf(async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      const err = new Error('Поле id обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const deleted = await prisma.analysis.deleteMany({ where: { id, userId: req.auth.userId } });
    if ((deleted?.count ?? 0) === 0) {
      const notFound = new Error('Анализ не найден');
      notFound.statusCode = 404;
      throw notFound;
    }
    res.json({ deleted: true });
  })),
);

app.get(
  '/api/scan/:id',
  requireAuth(async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      const err = new Error('Поле id обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const scan = await prisma.scan.findFirst({ where: { id, userId: req.auth.userId } });
    if (!scan) {
      const err = new Error('Скан не найден');
      err.statusCode = 404;
      throw err;
    }

    res.json({
      id: scan.id,
      shareId: scan.shareId,
      isPublic: scan.isPublic,
      text: scan.text,
      result: scan.isPaid ? scan.result : redactScanResultForUnpaid(scan.result),
      isPaid: scan.isPaid,
      createdAt: scan.createdAt,
      autoDeleteAt: scan.autoDeleteAt,
      anonymization: scan.anonymization,
      userId: scan.userId,
    });
  }),
);

app.get(
  '/api/scan/:id.pdf',
  requireAuth(async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      const err = new Error('Поле id обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const scan = await prisma.scan.findFirst({ where: { id, userId: req.auth.userId } });
    if (!scan) {
      const err = new Error('Скан не найден');
      err.statusCode = 404;
      throw err;
    }

    const safeResult = scan.isPaid ? scan.result : redactScanResultForUnpaid(scan.result);
    const verdict = normalizeVerdict(safeResult);
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/r/${encodeURIComponent(scan.shareId)}`;

    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="redflag-scan-${scan.shareId}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');

    const doc = new PDFDocument({ size: 'A4', margin: 54, info: { Title: 'RedFlag Scanner — отчёт' } });
    doc.pipe(res);

    const done = new Promise((resolve, reject) => {
      doc.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
    });

    doc.font('Helvetica-Bold').fontSize(18).text('RedFlag Scanner');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(11).text(`Ссылка: ${shareUrl}`);
    doc.moveDown(1.0);

    doc.font('Helvetica-Bold').fontSize(14).text(`Рейтинг: ${verdict.rating} / 100`);
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(16).text(verdict.short_verdict);
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).text(verdict.teaser, { lineGap: 2 });
    doc.moveDown(1.0);

    writePdfSection(doc, 'Полный разбор', safeResult?.full_analysis);
    writePdfSection(doc, 'Совет', safeResult?.advice);
    writePdfList(doc, 'Красные флаги', extractFlagLines(safeResult));

    doc.end();
    await done;
  }),
);

async function runAutoDeleteOnce() {
  const prisma = getPrismaClient();
  const now = new Date();

  const [scans, analyses] = await Promise.all([
    prisma.scan.deleteMany({ where: { autoDeleteAt: { lte: now } } }),
    prisma.analysis.deleteMany({ where: { autoDeleteAt: { lte: now } } }),
  ]);

  const deleted = (scans?.count ?? 0) + (analyses?.count ?? 0);
  if (deleted > 0) {
    process.stdout.write(`Auto-delete removed ${deleted} records\n`);
  }
}

function startAutoDeleteLoop() {
  const enabled = toBoolean(process.env.AUTO_DELETE_ENABLED) ?? false;
  if (!enabled) return;

  const intervalMs = getEnvInt('AUTO_DELETE_INTERVAL_MS') ?? 60000;
  if (!Number.isFinite(intervalMs) || intervalMs < 5000) {
    throw new Error('AUTO_DELETE_INTERVAL_MS должен быть числом >= 5000');
  }

  const tick = async () => {
    try {
      await runAutoDeleteOnce();
    } catch (err) {
      process.stderr.write(`Auto-delete failed: ${err?.message ?? String(err)}\n`);
    }
  };

  void tick();
  setInterval(tick, intervalMs);
}

app.post(
  '/api/scan/:id/ask',
  askLimiter,
  requireAuth(requireCsrf(async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      const err = new Error('Поле id обязательно');
      err.statusCode = 400;
      throw err;
    }

    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) {
      const err = new Error('Поле question обязательно');
      err.statusCode = 400;
      throw err;
    }

    if (question.length > 800) {
      const err = new Error('Слишком длинный вопрос');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const scan = await prisma.scan.findFirst({ where: { id, userId: req.auth.userId } });
    if (!scan) {
      const err = new Error('Скан не найден');
      err.statusCode = 404;
      throw err;
    }

    const answer = await yandex.askAboutScan({ text: scan.text, result: scan.result, question });
    res.json({ answer: answer.answer });
  })),
);

app.post('/api/pay', requireAuth(requireCsrf(async (req, res) => {
  const scanId = typeof req.body?.scanId === 'string' ? req.body.scanId.trim() : '';
  const analysisId = typeof req.body?.analysisId === 'string' ? req.body.analysisId.trim() : '';

    if (!scanId && !analysisId) {
      const err = new Error('Нужно передать scanId или analysisId');
      err.statusCode = 400;
      throw err;
    }

  const prisma = getPrismaClient();
  let scanForPay = null;

  if (scanId) {
    const scan = await prisma.scan.findFirst({ where: { id: scanId, userId: req.auth.userId } });
    if (!scan) {
      const err = new Error('Скан не найден');
      err.statusCode = 404;
      throw err;
    }
    if (scan.isPaid) {
      const err = new Error('Этот скан уже оплачен');
      err.statusCode = 409;
      throw err;
    }
    scanForPay = scan;
  }

  if (analysisId) {
    const analysis = await prisma.analysis.findFirst({ where: { id: analysisId, userId: req.auth.userId } });
    if (!analysis) {
      const err = new Error('Анализ не найден');
      err.statusCode = 404;
      throw err;
    }
    if (analysis.isPaid) {
      const err = new Error('Этот анализ уже оплачен');
      err.statusCode = 409;
      throw err;
    }
  }

    const idempotenceKey = crypto.randomUUID();

    const metadata = {};
    if (scanId) metadata.scanId = scanId;
    if (analysisId) metadata.analysisId = analysisId;

    const payment = await yooKassaCreatePayment({
      payload: {
        amount: {
          value: '149.00',
          currency: 'RUB',
        },
        confirmation: {
          type: 'redirect',
          return_url: buildYooKassaReturnUrl({
            scanId,
            analysisId,
            shareId: scanForPay?.shareId ? String(scanForPay.shareId) : undefined,
          }),
        },
        capture: true,
        description: 'Оплата полного разбора',
        metadata,
      },
      idempotenceKey,
    });

    const confirmationUrl = payment?.confirmation?.confirmation_url;
    if (typeof confirmationUrl !== 'string' || !confirmationUrl) {
      const err = new Error('ЮKassa не вернула ссылку на оплату');
      err.statusCode = 502;
      throw err;
    }

  res.json({ confirmation_url: confirmationUrl });
})));

app.post(
  '/api/payment/create',
  requireAuth(requireCsrf(async (req, res) => {
    const analysisId = typeof req.body?.analysisId === 'string' ? req.body.analysisId.trim() : '';
    if (!analysisId) {
      const err = new Error('Поле analysisId обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const analysis = await prisma.analysis.findFirst({ where: { id: analysisId, userId: req.auth.userId } });
    if (!analysis) {
      const err = new Error('Анализ не найден');
      err.statusCode = 404;
      throw err;
    }

    if (analysis.isPaid) {
      const err = new Error('Этот анализ уже оплачен');
      err.statusCode = 409;
      throw err;
    }

    const idempotenceKey = crypto.randomUUID();

    const payment = await yooKassaCreatePayment({
      payload: {
        amount: {
          value: '149.00',
          currency: 'RUB',
        },
        confirmation: {
          type: 'redirect',
          return_url: buildYooKassaReturnUrl({ analysisId }),
        },
        capture: true,
        description: 'Оплата полного разбора',
        metadata: {
          analysisId,
        },
      },
      idempotenceKey,
    });

    const confirmationUrl = payment?.confirmation?.confirmation_url;
    if (typeof confirmationUrl !== 'string' || !confirmationUrl) {
      const err = new Error('ЮKassa не вернула ссылку на оплату');
      err.statusCode = 502;
      throw err;
    }

    res.json({ confirmationUrl, confirmation_url: confirmationUrl });
  })),
);

const paymentWebhookHandler = async (req, res, next) => {
  try {
    verifyWebhookRequest(req);

    const event = typeof req.body?.event === 'string' ? req.body.event : '';
    const object = typeof req.body?.object === 'object' && req.body.object !== null ? req.body.object : null;

    if (event !== 'payment.succeeded') {
      res.json({ received: true });
      return;
    }

    const paymentId = typeof object?.id === 'string' ? object.id : '';
    if (!paymentId) {
      const err = new Error('Не удалось определить paymentId');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const now = new Date();
    const webhook = await prisma.paymentWebhookEvent.upsert({
      where: { paymentId },
      create: {
        paymentId,
        event,
        payload: req.body ?? {},
        lastTriedAt: now,
        attempts: 1,
      },
      update: {
        event,
        payload: req.body ?? {},
        lastTriedAt: now,
        attempts: { increment: 1 },
      },
    });

    if (webhook?.processedAt) {
      res.json({ received: true });
      return;
    }

    const payment = await yooKassaGetPayment(paymentId);

    if (payment?.status !== 'succeeded' || payment?.paid !== true) {
      await prisma.paymentWebhookEvent.update({
        where: { paymentId },
        data: { lastError: 'payment_not_succeeded' },
      });
      res.json({ received: true });
      return;
    }

    const amountValue = typeof payment?.amount?.value === 'string' ? payment.amount.value : '';
    const amountCurrency = typeof payment?.amount?.currency === 'string' ? payment.amount.currency : '';
    if (amountValue !== '149.00' || amountCurrency !== 'RUB') {
      await prisma.paymentWebhookEvent.update({
        where: { paymentId },
        data: { lastError: 'amount_mismatch' },
      });
      res.json({ received: true });
      return;
    }

    const scanId = typeof payment?.metadata?.scanId === 'string' ? payment.metadata.scanId.trim() : '';
    const analysisId = typeof payment?.metadata?.analysisId === 'string' ? payment.metadata.analysisId.trim() : '';

    if (!scanId && !analysisId) {
      await prisma.paymentWebhookEvent.update({
        where: { paymentId },
        data: { processedAt: new Date(), lastError: 'missing_metadata' },
      });
      res.json({ received: true });
      return;
    }

    if (analysisId) {
      await prisma.analysis.updateMany({
        where: {
          id: analysisId,
          isPaid: false,
        },
        data: {
          isPaid: true,
        },
      });
    }

    if (scanId) {
      await prisma.scan.updateMany({
        where: {
          id: scanId,
          isPaid: false,
        },
        data: {
          isPaid: true,
        },
      });
    }

    await prisma.paymentWebhookEvent.update({
      where: { paymentId },
      data: { processedAt: new Date(), lastError: null },
    });

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
};

app.post('/api/payment/webhook', webhookLimiter, paymentWebhookHandler);

app.post('/api/payment/webhook/:token', webhookLimiter, paymentWebhookHandler);

app.use((err, _req, res, _next) => {
  const statusCode = Number(err?.statusCode ?? 500);
  const message = err?.message ?? 'Внутренняя ошибка сервера';
  res.status(statusCode).json({ error: message });
});

const port = Number(process.env.PORT ?? '5000');

app.listen(port, () => {
  process.stdout.write(`Server listening on port ${port}\n`);
  startAutoDeleteLoop();
});
