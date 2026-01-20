require('dotenv').config();

const { execFile, execSync } = require('child_process');
const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Resvg } = require('@resvg/resvg-js');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { getPrismaClient } = require('./prismaClient');
const { YandexGPTService } = require('./services/YandexGPTService');

const FULL_ANALYSIS_PRICE_RUB = '149.00';

function md5Upper(value) {
  return crypto.createHash('md5').update(String(value), 'utf8').digest('hex').toUpperCase();
}

function getPaymentReturnUrl() {
  const url = typeof process.env.PAYMENT_RETURN_URL === 'string' ? process.env.PAYMENT_RETURN_URL.trim() : '';
  if (url) return url;
  const legacy = typeof process.env.YOOKASSA_RETURN_URL === 'string' ? process.env.YOOKASSA_RETURN_URL.trim() : '';
  if (legacy) return legacy;

  const err = new Error('PAYMENT_RETURN_URL не задан');
  err.statusCode = 500;
  throw err;
}

function buildPaymentReturnUrl(extraParams = {}) {
  try {
    const url = new URL(getPaymentReturnUrl());

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
    const err = new Error('PAYMENT_RETURN_URL должен быть валидным URL');
    err.statusCode = 500;
    throw err;
  }
}

function getPaymentProvider() {
  const raw = typeof process.env.PAYMENT_PROVIDER === 'string' ? process.env.PAYMENT_PROVIDER.trim().toLowerCase() : '';
  if (!raw) return 'yookassa';
  if (raw === 'yookassa' || raw === 'robokassa') return raw;
  const err = new Error('PAYMENT_PROVIDER должен быть yookassa или robokassa');
  err.statusCode = 500;
  throw err;
}

function getYooKassaConfig() {
  const shopId = typeof process.env.YOOKASSA_SHOP_ID === 'string' ? process.env.YOOKASSA_SHOP_ID.trim() : '';
  const secretKey = typeof process.env.YOOKASSA_SECRET_KEY === 'string' ? process.env.YOOKASSA_SECRET_KEY.trim() : '';
  const baseUrl =
    (typeof process.env.YOOKASSA_BASE_URL === 'string' ? process.env.YOOKASSA_BASE_URL.trim() : '') ||
    'https://api.yookassa.ru/v3';

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

  try {
    new URL(baseUrl);
  } catch {
    const err = new Error('YOOKASSA_BASE_URL должен быть валидным URL');
    err.statusCode = 500;
    throw err;
  }

  return { shopId, secretKey, baseUrl: baseUrl.replace(/\/+$/, '') };
}

function normalizeYooKassaAmount(value) {
  const raw = typeof value === 'string' ? value.trim().replace(',', '.') : String(value ?? '').trim().replace(',', '.');
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100000000) return '';
  return n.toFixed(2);
}

async function yookassaCreatePayment({ amountValue, description, returnUrl, metadata }) {
  const cfg = getYooKassaConfig();
  const amount = normalizeYooKassaAmount(amountValue);
  if (!amount) {
    const err = new Error('Некорректная сумма');
    err.statusCode = 500;
    throw err;
  }

  const idempotenceKey = crypto.randomUUID();
  const auth = Buffer.from(`${cfg.shopId}:${cfg.secretKey}`, 'utf8').toString('base64');
  const url = `${cfg.baseUrl}/payments`;

  const payload = {
    amount: { value: amount, currency: 'RUB' },
    capture: true,
    description: String(description ?? ''),
    confirmation: {
      type: 'redirect',
      return_url: String(returnUrl ?? ''),
    },
    metadata: isPlainObject(metadata) ? metadata : {},
  };

  let response;
  try {
    response = await axios.post(url, payload, {
      timeout: 20000,
      headers: {
        Authorization: `Basic ${auth}`,
        'Idempotence-Key': idempotenceKey,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });
  } catch {
    const err = new Error('Не удалось создать платёж в YooKassa');
    err.statusCode = 502;
    throw err;
  }

  if (!response || response.status < 200 || response.status >= 300) {
    const err = new Error('YooKassa вернула ошибку при создании платежа');
    err.statusCode = 502;
    throw err;
  }

  const data = response.data;
  const paymentId = typeof data?.id === 'string' ? data.id : '';
  const confirmationUrl = typeof data?.confirmation?.confirmation_url === 'string' ? data.confirmation.confirmation_url : '';

  if (!paymentId || !confirmationUrl) {
    const err = new Error('YooKassa вернула неожиданный ответ');
    err.statusCode = 502;
    throw err;
  }

  return { paymentId, confirmationUrl };
}

function getRobokassaConfig() {
  const merchantLogin = typeof process.env.ROBOKASSA_MERCHANT_LOGIN === 'string' ? process.env.ROBOKASSA_MERCHANT_LOGIN.trim() : '';
  const password1 = typeof process.env.ROBOKASSA_PASSWORD_1 === 'string' ? process.env.ROBOKASSA_PASSWORD_1.trim() : '';
  const password2 = typeof process.env.ROBOKASSA_PASSWORD_2 === 'string' ? process.env.ROBOKASSA_PASSWORD_2.trim() : '';
  const isTest = toBoolean(process.env.ROBOKASSA_TEST_MODE) ?? false;
  const baseUrl =
    (typeof process.env.ROBOKASSA_BASE_URL === 'string' ? process.env.ROBOKASSA_BASE_URL.trim() : '') ||
    'https://auth.robokassa.ru/Merchant/Index.aspx';

  if (!merchantLogin) {
    const err = new Error('ROBOKASSA_MERCHANT_LOGIN не задан');
    err.statusCode = 500;
    throw err;
  }

  if (!password1) {
    const err = new Error('ROBOKASSA_PASSWORD_1 не задан');
    err.statusCode = 500;
    throw err;
  }

  if (!password2) {
    const err = new Error('ROBOKASSA_PASSWORD_2 не задан');
    err.statusCode = 500;
    throw err;
  }

  return { merchantLogin, password1, password2, isTest, baseUrl };
}

function normalizeRobokassaOutSum(value) {
  const raw = typeof value === 'string' ? value.trim().replace(',', '.') : String(value ?? '').trim().replace(',', '.');
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100000000) return '';
  return n.toFixed(2);
}

function buildRobokassaSignatureBase({ parts, shpParams }) {
  const shpEntries = Object.entries(shpParams ?? {})
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => [String(k), String(v).trim()]);

  shpEntries.sort(([a], [b]) => a.localeCompare(b, 'en'));
  const tail = shpEntries.map(([k, v]) => `${k}=${v}`);
  return parts.concat(tail).join(':');
}

function buildRobokassaPaymentUrl({ invId, outSum, description, shpParams, email }) {
  const cfg = getRobokassaConfig();
  const sum = normalizeRobokassaOutSum(outSum);
  if (!sum) {
    const err = new Error('Некорректная сумма');
    err.statusCode = 500;
    throw err;
  }

  const signatureBase = buildRobokassaSignatureBase({
    parts: [cfg.merchantLogin, sum, String(invId), cfg.password1],
    shpParams,
  });
  const signatureValue = md5Upper(signatureBase);

  const url = new URL(cfg.baseUrl);
  url.searchParams.set('MerchantLogin', cfg.merchantLogin);
  url.searchParams.set('OutSum', sum);
  url.searchParams.set('InvId', String(invId));
  url.searchParams.set('Description', String(description ?? ''));
  url.searchParams.set('SignatureValue', signatureValue);
  url.searchParams.set('Culture', 'ru');
  url.searchParams.set('Encoding', 'utf-8');
  if (cfg.isTest) url.searchParams.set('IsTest', '1');
  if (typeof email === 'string' && email.trim()) url.searchParams.set('Email', email.trim());

  if (shpParams && typeof shpParams === 'object') {
    const shpEntries = Object.entries(shpParams)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => [String(k), String(v).trim()]);

    shpEntries.sort(([a], [b]) => a.localeCompare(b, 'en'));

    for (const [k, v] of shpEntries) {
      if (typeof v === 'string' && v.trim()) {
        url.searchParams.set(k, v.trim());
      }
    }
  }

  return url.toString();
}

function escapeHtmlAttribute(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function encodeRobokassaFormFieldValue(name, value) {
  const p = new URLSearchParams();
  p.set(String(name), String(value ?? ''));
  const s = p.toString();
  const prefix = `${String(name)}=`;
  return s.startsWith(prefix) ? s.slice(prefix.length) : encodeURIComponent(String(value ?? '')).replaceAll('%20', '+');
}

function encodeRobokassaReceiptForSignature(receiptJson) {
  const raw = typeof receiptJson === 'string' ? receiptJson : '';
  if (!raw.trim()) return '';
  return encodeURIComponent(raw);
}

function getRobokassaReceiptConfig() {
  const itemName =
    (typeof process.env.ROBOKASSA_RECEIPT_ITEM_NAME === 'string' ? process.env.ROBOKASSA_RECEIPT_ITEM_NAME.trim() : '') ||
    'Открыть полный отчёт';
  const tax = (typeof process.env.ROBOKASSA_RECEIPT_TAX === 'string' ? process.env.ROBOKASSA_RECEIPT_TAX.trim() : '') || 'none';
  const paymentMethod =
    (typeof process.env.ROBOKASSA_RECEIPT_PAYMENT_METHOD === 'string'
      ? process.env.ROBOKASSA_RECEIPT_PAYMENT_METHOD.trim()
      : '') || 'full_payment';
  const paymentObject =
    (typeof process.env.ROBOKASSA_RECEIPT_PAYMENT_OBJECT === 'string'
      ? process.env.ROBOKASSA_RECEIPT_PAYMENT_OBJECT.trim()
      : '') || 'service';
  const sno = typeof process.env.ROBOKASSA_RECEIPT_SNO === 'string' ? process.env.ROBOKASSA_RECEIPT_SNO.trim() : '';
  return { itemName, tax, paymentMethod, paymentObject, sno };
}

function buildRobokassaReceiptJson({ outSum }) {
  const sum = normalizeRobokassaOutSum(outSum);
  if (!sum) {
    const err = new Error('Некорректная сумма для чека');
    err.statusCode = 500;
    throw err;
  }

  const cfg = getRobokassaReceiptConfig();
  const sumNumber = Number(sum);

  const receipt = {
    items: [
      {
        name: cfg.itemName,
        quantity: 1,
        sum: sumNumber,
        cost: sumNumber,
        payment_method: cfg.paymentMethod,
        payment_object: cfg.paymentObject,
        tax: cfg.tax,
      },
    ],
  };

  if (cfg.sno) {
    receipt.sno = cfg.sno;
  }

  return JSON.stringify(receipt);
}

function buildRobokassaPaymentFormHtml({ invId, outSum, description, shpParams, email, receiptJson }) {
  const cfg = getRobokassaConfig();
  const sum = normalizeRobokassaOutSum(outSum);
  if (!sum) {
    const err = new Error('Некорректная сумма');
    err.statusCode = 500;
    throw err;
  }

  const receiptRaw = typeof receiptJson === 'string' ? receiptJson : '';
  const receiptEncodedForSignature = receiptRaw ? encodeRobokassaFormFieldValue('Receipt', receiptRaw) : '';

  const signatureBase = buildRobokassaSignatureBase({
    parts: receiptEncodedForSignature
      ? [cfg.merchantLogin, sum, String(invId), receiptEncodedForSignature, cfg.password1]
      : [cfg.merchantLogin, sum, String(invId), cfg.password1],
    shpParams,
  });
  const signatureValue = md5Upper(signatureBase);

  const fields = [
    ['MerchantLogin', cfg.merchantLogin],
    ['OutSum', sum],
    ['InvId', String(invId)],
    ['Description', String(description ?? '')],
    ['SignatureValue', signatureValue],
    ['Culture', 'ru'],
    ['Encoding', 'utf-8'],
  ];

  if (receiptEncodedForSignature) fields.push(['Receipt', receiptEncodedForSignature]);
  if (cfg.isTest) fields.push(['IsTest', '1']);
  if (typeof email === 'string' && email.trim()) fields.push(['Email', email.trim()]);

  if (shpParams && typeof shpParams === 'object') {
    const shpEntries = Object.entries(shpParams)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => [String(k), String(v).trim()]);

    shpEntries.sort(([a], [b]) => a.localeCompare(b, 'en'));

    for (const [k, v] of shpEntries) {
      fields.push([k, v]);
    }
  }

  const inputsHtml = fields
    .map(([k, v]) => `<input type="hidden" name="${escapeHtmlAttribute(k)}" value="${escapeHtmlAttribute(v)}" />`)
    .join('');

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Переадресация на оплату</title>
  </head>
  <body>
    <form id="pay" method="POST" accept-charset="utf-8" action="${escapeHtmlAttribute(cfg.baseUrl)}">
      ${inputsHtml}
      <noscript>
        <button type="submit">Перейти к оплате</button>
      </noscript>
    </form>
    <script>
      document.getElementById('pay').submit();
    </script>
  </body>
</html>`;
}

function verifyRobokassaResultSignature({ outSum, invId, signatureValue, shpParams, receipt }) {
  const cfg = getRobokassaConfig();
  const sum = normalizeRobokassaOutSum(outSum);
  if (!sum) return false;
  const got = typeof signatureValue === 'string' ? signatureValue.trim().toUpperCase() : '';
  if (!got) return false;

  const candidates = [];
  candidates.push(
    md5Upper(
      buildRobokassaSignatureBase({
        parts: [sum, String(invId), cfg.password2],
        shpParams,
      }),
    ),
  );
  if (typeof receipt === 'string' && receipt.trim()) {
    const receiptTrimmed = receipt.trim();
    candidates.push(
      md5Upper(
        buildRobokassaSignatureBase({
          parts: [sum, String(invId), receiptTrimmed, cfg.password2],
          shpParams,
        }),
      ),
    );

    const receiptAsSignatureEncoded = encodeRobokassaReceiptForSignature(receiptTrimmed);
    if (receiptAsSignatureEncoded && receiptAsSignatureEncoded !== receiptTrimmed) {
      candidates.push(
        md5Upper(
          buildRobokassaSignatureBase({
            parts: [sum, String(invId), receiptAsSignatureEncoded, cfg.password2],
            shpParams,
          }),
        ),
      );
    }

    const receiptAsEncoded = encodeRobokassaFormFieldValue('Receipt', receiptTrimmed);
    if (receiptAsEncoded && receiptAsEncoded !== receiptTrimmed) {
      candidates.push(
        md5Upper(
          buildRobokassaSignatureBase({
            parts: [sum, String(invId), receiptAsEncoded, cfg.password2],
            shpParams,
          }),
        ),
      );
    }
  }

  for (const expected of candidates) {
    try {
      const a = Buffer.from(got, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length) continue;
      if (crypto.timingSafeEqual(a, b)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function verifyRobokassaSuccessSignature({ outSum, invId, signatureValue, shpParams, receipt }) {
  const cfg = getRobokassaConfig();
  const sum = normalizeRobokassaOutSum(outSum);
  if (!sum) return false;
  const got = typeof signatureValue === 'string' ? signatureValue.trim().toUpperCase() : '';
  if (!got) return false;

  const candidates = [];
  candidates.push(
    md5Upper(
      buildRobokassaSignatureBase({
        parts: [sum, String(invId), cfg.password1],
        shpParams,
      }),
    ),
  );
  if (typeof receipt === 'string' && receipt.trim()) {
    const receiptTrimmed = receipt.trim();
    candidates.push(
      md5Upper(
        buildRobokassaSignatureBase({
          parts: [sum, String(invId), receiptTrimmed, cfg.password1],
          shpParams,
        }),
      ),
    );

    const receiptAsSignatureEncoded = encodeRobokassaReceiptForSignature(receiptTrimmed);
    if (receiptAsSignatureEncoded && receiptAsSignatureEncoded !== receiptTrimmed) {
      candidates.push(
        md5Upper(
          buildRobokassaSignatureBase({
            parts: [sum, String(invId), receiptAsSignatureEncoded, cfg.password1],
            shpParams,
          }),
        ),
      );
    }

    const receiptAsEncoded = encodeRobokassaFormFieldValue('Receipt', receiptTrimmed);
    if (receiptAsEncoded && receiptAsEncoded !== receiptTrimmed) {
      candidates.push(
        md5Upper(
          buildRobokassaSignatureBase({
            parts: [sum, String(invId), receiptAsEncoded, cfg.password1],
            shpParams,
          }),
        ),
      );
    }
  }

  for (const expected of candidates) {
    try {
      const a = Buffer.from(got, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length) continue;
      if (crypto.timingSafeEqual(a, b)) return true;
    } catch {
      continue;
    }
  }
  return false;
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

function sanitizeTextForAi(input) {
  const base = String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u200B\uFEFF]/g, '')
    .replace(/[\t\f\v\u00A0]+/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!base) return '';

  const lines = base.split('\n');
  const out = [];

  for (const line of lines) {
    const t = String(line ?? '').trim();
    if (!t) {
      out.push('');
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(t) && t.length <= 2) continue;
    out.push(t.replace(/\s{2,}/g, ' '));
  }

  const normalized = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const maxChars = getEnvInt('AI_TEXT_MAX_CHARS') ?? 12000;
  if (!Number.isFinite(maxChars) || maxChars < 2000) return normalized;
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(normalized.length - maxChars).trim();
}

function sanitizeTextForUi(input) {
  const base = String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u200B\uFEFF]/g, '')
    .replace(/[\t\f\v\u00A0]+/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!base) return '';

  const lines = base.split('\n');
  const out = [];

  for (const line of lines) {
    const t = String(line ?? '').trim();
    if (!t) {
      out.push('');
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(t) && t.length <= 2) continue;
    out.push(t.replace(/\s{2,}/g, ' '));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeTranscriptForAi(input) {
  const cleaned = sanitizeTextForAi(input);
  if (!cleaned) return '';

  function parseTelegramTextExport(text) {
    const lines = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => String(l ?? '').trim());

    const headerRe =
      /^(.{1,120}?)\s*,\s*\[\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})(?:,\s*|\s+)(\d{1,2}:\d{2})(?::\d{2})?\s*\]\s*$/u;

    const parsed = [];
    let current = null;
    let matchedHeaders = 0;

    for (const line of lines) {
      if (!line) continue;
      const m = line.match(headerRe);
      if (m) {
        matchedHeaders += 1;
        if (current && String(current.message ?? '').trim()) parsed.push(current);
        current = { name: String(m[1] ?? '').trim(), message: '' };
        continue;
      }

      if (!current) current = { name: '', message: '' };
      const prev = String(current.message ?? '').trim();
      current.message = prev ? `${prev} ${line}` : line;
    }

    if (current && String(current.message ?? '').trim()) parsed.push(current);

    if (matchedHeaders < 2 || parsed.length < 2) return null;

    const uniqueNames = new Set(parsed.map((x) => String(x?.name ?? '').trim()).filter(Boolean));
    if (uniqueNames.size < 2) return null;

    return parsed
      .map((x) => ({
        name: String(x?.name ?? '').trim(),
        message: String(x?.message ?? '')
          .replace(/\s+/g, ' ')
          .trim(),
      }))
      .filter((x) => x.message);
  }

  function compactSpeakers(lines) {
    const map = new Map();
    let nextIndex = 0;
    const out = [];

    for (const item of lines) {
      const name = String(item?.name ?? '').trim();
      const message = String(item?.message ?? '').trim();
      if (!message) continue;

      let label = '';
      if (name) {
        const existing = map.get(name);
        if (existing) {
          label = existing;
        } else {
          nextIndex += 1;
          label = nextIndex <= 26 ? String.fromCharCode(64 + nextIndex) : `U${nextIndex}`;
          map.set(name, label);
        }
      }

      out.push(label ? `${label}: ${message}` : message);
    }

    return sanitizeTextForAi(out.join('\n'));
  }

  const telegramExport = parseTelegramTextExport(cleaned);
  if (telegramExport) {
    const compact = compactSpeakers(telegramExport);
    if (compact) return compact;
    return sanitizeTextForAi(
      telegramExport
        .map((x) => {
          const name = String(x?.name ?? '').trim();
          const message = String(x?.message ?? '').trim();
          if (!message) return '';
          return name ? `${name}: ${message}` : message;
        })
        .filter(Boolean)
        .join('\n'),
    );
  }

  const asDialogue = sanitizeTextForAi(formatOcrDialogue(cleaned, 'auto'));
  if (asDialogue) {
    const asDialogueLines = asDialogue
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed = [];
    let matchedCount = 0;
    for (const line of asDialogueLines) {
      const m = line.match(/^(?:\d{1,2}:\d{2}|\?\?:\?\?)\s*-\s*([^:]{1,60}):\s*(.+)$/u);
      if (m) {
        matchedCount += 1;
        parsed.push({ name: m[1], message: m[2] });
        continue;
      }
      if (parsed.length > 0) {
        parsed[parsed.length - 1].message = `${String(parsed[parsed.length - 1].message ?? '').trim()} ${line}`.trim();
      } else {
        parsed.push({ name: '', message: line });
      }
    }

    if (matchedCount >= 2) {
      const compact = compactSpeakers(parsed);
      if (compact) return compact;
      return sanitizeTextForAi(
        parsed
          .map((x) => {
            const name = String(x?.name ?? '').trim();
            const message = String(x?.message ?? '').trim();
            if (!message) return '';
            return name ? `${name}: ${message}` : message;
          })
          .filter(Boolean)
          .join('\n'),
      );
    }
  }

  const baseLines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const nameColonLines = baseLines.filter((l) => /^[\p{L}][\p{L}\p{M}\p{N} _.'’-]{1,39}:\s*\S/iu.test(l));
  if (nameColonLines.length >= 2) {
    const parsed = [];
    for (const line of nameColonLines) {
      const m = line.match(/^([^:]{1,60}):\s*(.+)$/u);
      if (!m) continue;
      parsed.push({ name: m[1], message: m[2] });
    }
    const compact = compactSpeakers(parsed);
    if (compact) return compact;
    return sanitizeTextForAi(nameColonLines.join('\n'));
  }

  const noisy = [
    'закрепл',
    'закреплённое',
    'закрепленное',
    'закреплено',
    'был(а) недавно',
    'был(а) в сети',
    'в сети',
    'online',
    'last seen',
    'печатает',
    'typing',
    'сообщения и звонки защищены',
    'end-to-end encrypted',
    'наберите сообщение',
    'message',
  ];

  const filtered = baseLines.filter((line) => {
    const low = line.toLowerCase();
    if (noisy.some((p) => low.includes(p))) return false;
    if (low === 'сегодня' || low === 'вчера' || low === 'today' || low === 'yesterday') return false;
    if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/u.test(line)) return false;
    if (/^\d{1,2}\s+[\p{L}]{3,}\s+\d{4}$/u.test(line)) return false;
    if (/^\d{1,2}\s+[\p{L}]{3,}$/u.test(line)) return false;
    if (/^\d{1,2}:\d{2}$/u.test(line)) return false;
    return true;
  });

  if (filtered.length >= 2) return sanitizeTextForAi(filtered.join('\n'));
  return cleaned;
}

function normalizeOcrLines(raw) {
  const base = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u200B\uFEFF]/g, '')
    .replace(/[\t\f\v\u00A0]+/g, ' ');

  const noisyPhrases = [
    'закрепл',
    'закреплённое',
    'закрепленное',
    'закреплено',
    'был(а) недавно',
    'был(а) в сети',
    'в сети',
    'online',
    'last seen',
    'печатает',
    'typing',
    'позвонить',
    'видеозвонок',
    'сообщения и звонки защищены',
    'end-to-end encrypted',
    'наберите сообщение',
    'напишите сообщение',
  ];

  return base
    .split('\n')
    .map((l) => String(l ?? '').trim())
    .filter(Boolean)
    .filter((line) => {
      const low = line.toLowerCase();
      return !noisyPhrases.some((p) => low.includes(p));
    })
    .map((line) => line.replace(/\s{2,}/g, ' ').trim());
}

function detectChatApp({ raw, lines }) {
  const rawLow = String(raw ?? '').toLowerCase();
  const startTimeCount = lines.filter((l) => /^(?:\d{1,2}\s*[:.]\s*\d{2}|\d{3,4})\b/u.test(l)).length;
  const endTimeCount = lines.filter((l) =>
    /\b(?:\d{1,2}\s*[:.]\s*\d{2}|\d{3,4})(?:[^\p{L}\p{N}]{0,6}|[^\p{L}\p{N}]{0,4}\p{L}[^\p{L}\p{N}]{0,2})$/u.test(l),
  ).length;
  const total = Math.max(1, lines.length);

  if (startTimeCount >= 2 && startTimeCount >= endTimeCount) return 'telegram';
  if (endTimeCount >= 2 && endTimeCount >= startTimeCount) return 'whatsapp';

  if (rawLow.includes('закрепл')) return 'telegram';
  if (rawLow.includes('сообщения и звонки защищены') || rawLow.includes('end-to-end encrypted')) return 'whatsapp';

  if (startTimeCount / total >= 0.18) return 'telegram';
  if (endTimeCount / total >= 0.18) return 'whatsapp';
  return 'telegram';
}

function formatOcrDialogue(raw, mode = 'auto', options = {}) {
  const noisyPhrases = [
    'закрепл',
    'закреплённое',
    'закрепленное',
    'закреплено',
    'был(а) недавно',
    'был(а) в сети',
    'в сети',
    'online',
    'last seen',
    'печатает',
    'typing',
    'позвонить',
    'видеозвонок',
    'сообщения и звонки защищены',
    'end-to-end encrypted',
    'наберите сообщение',
    'напишите сообщение',
  ];

  function normalizeOcrRichLines(items) {
    const base = Array.isArray(items) ? items : [];
    const out = [];
    for (const item of base) {
      const t0 = String(item?.text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u0000/g, '')
        .replace(/[\u200B\uFEFF]/g, '')
        .replace(/[\t\f\v\u00A0]+/g, ' ')
        .trim();
      if (!t0) continue;
      const low = t0.toLowerCase();
      if (noisyPhrases.some((p) => low.includes(p))) continue;
      out.push({
        text: t0.replace(/\s{2,}/g, ' ').trim(),
        side: item?.side === 'left' || item?.side === 'right' ? item.side : null,
        top: Number.isFinite(item?.top) ? item.top : null,
        bottom: Number.isFinite(item?.bottom) ? item.bottom : null,
        left: Number.isFinite(item?.left) ? item.left : null,
        right: Number.isFinite(item?.right) ? item.right : null,
      });
    }
    return out;
  }

  const richLines = Array.isArray(options?.ocrLines)
    ? normalizeOcrRichLines(options.ocrLines)
    : normalizeOcrLines(raw).map((text) => ({ text, side: null, top: null, bottom: null, left: null, right: null }));

  const lines = richLines.map((x) => x.text);
  if (lines.length === 0) return '';

  const effectiveMode = mode === 'auto' ? detectChatApp({ raw, lines }) : mode;

  const hasSideInfo = richLines.some((l) => l?.side === 'left' || l?.side === 'right');

  function speakerFromSide(side) {
    if (side === 'right') return 'Я';
    if (side === 'left') return 'Собеседник';
    return '';
  }

  function pickDominantSide(items) {
    let left = 0;
    let right = 0;
    for (const x of items) {
      if (x?.side === 'left') left += 1;
      if (x?.side === 'right') right += 1;
    }
    if (left === 0 && right === 0) return null;
    return right >= left ? 'right' : 'left';
  }

  function countLetters(value) {
    return (String(value).match(/[\p{L}]/gu) ?? []).length;
  }

  function countDigits(value) {
    return (String(value).match(/[\p{N}]/gu) ?? []).length;
  }

  function lettersRatio(value) {
    const compact = String(value).replace(/\s+/g, '');
    if (!compact) return 0;
    return countLetters(compact) / compact.length;
  }

  function looksLikeName(value) {
    const v = String(value ?? '').trim();
    if (!v) return false;
    if (v.length > 40) return false;
    const low = v.toLowerCase();
    if (low.includes('http')) return false;
    if (countLetters(v) < 4) return false;
    if (countDigits(v) > 0) return false;
    if (lettersRatio(v) < 0.62) return false;
    const words = v.split(/\s+/).filter(Boolean);
    if (words.length > 4) return false;
    if (!/^[\p{Lu}]/u.test(v)) return false;
    if (words.length >= 2) {
      if (words.some((w) => !/^[\p{Lu}]/u.test(w))) return false;
    }
    if (/[^\p{L}\p{M}\p{N} _.'’-]/u.test(v)) return false;
    return true;
  }

  function isDaySeparator(value) {
    const v = String(value ?? '').trim();
    if (!v) return false;
    const low = v.toLowerCase();
    if (low === 'сегодня' || low === 'вчера' || low === 'today' || low === 'yesterday') return true;
    if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/u.test(v)) return true;
    if (/^\d{1,2}\s+[\p{L}]{3,}\s+\d{4}$/u.test(v)) return true;
    if (/^\d{1,2}\s+[\p{L}]{3,}$/u.test(v)) return true;
    return false;
  }

  function parseTimeFromDigits(value, lastTimeMinutes) {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (digits.length !== 3 && digits.length !== 4) return null;

    let h = 0;
    let m = 0;
    if (digits.length === 3) {
      h = Number(digits.slice(0, 1));
      m = Number(digits.slice(1));
      if (lastTimeMinutes !== null) {
        const lastH = Math.floor(lastTimeMinutes / 60);
        if (lastH >= 10) return null;
      }
    } else {
      h = Number(digits.slice(0, 2));
      m = Number(digits.slice(2));
    }
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
    if (h < 0 || h > 23) return null;
    if (m < 0 || m > 59) return null;
    return { time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, minutes: h * 60 + m };
  }

  function extractTimeFromEnd(line, lastTimeMinutes) {
    const v = String(line ?? '').trim();
    if (!v) return null;

    const m1 = v.match(/^(.*?)(\b\d{1,2})\s*[:.]\s*(\d{2})(?:[^\p{L}\p{N}]{0,6}|[^\p{L}\p{N}]{0,4}\p{L}[^\p{L}\p{N}]{0,2})$/u);
    if (m1) {
      const h = Number(m1[2]);
      const mm = Number(m1[3]);
      if (Number.isInteger(h) && Number.isInteger(mm) && h >= 0 && h <= 23 && mm >= 0 && mm <= 59) {
        return {
          time: `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
          minutes: h * 60 + mm,
          before: String(m1[1] ?? '').trim(),
        };
      }
    }

    const m2 = v.match(/^(.*?)(\b\d{3,4})(?:[^\p{L}\p{N}]{0,6}|[^\p{L}\p{N}]{0,4}\p{L}[^\p{L}\p{N}]{0,2})$/u);
    if (m2) {
      const parsed = parseTimeFromDigits(m2[2], lastTimeMinutes);
      if (parsed) {
        return { time: parsed.time, minutes: parsed.minutes, before: String(m2[1] ?? '').trim() };
      }
    }

    return null;
  }

  function looksLikeHeaderNoise(value) {
    const v = String(value ?? '').trim();
    if (!v) return true;
    if (/^\d{1,2}:\d{2}\b/u.test(v)) {
      const symbols = String(v).replace(/[\p{L}\p{N}\s]/gu, '').length;
      if (countLetters(v) < 10 && lettersRatio(v) < 0.42 && symbols >= 4) return true;
    }
    if (lettersRatio(v) < 0.15 && countLetters(v) < 4 && v.length <= 24) return true;
    if (/^[›»«—|()\[\]{}'`-]+$/u.test(v)) return true;
    return false;
  }

  function isProbablyNoiseLine(value) {
    const v = String(value ?? '').trim();
    if (!v) return true;
    const low = v.toLowerCase();
    const letters = countLetters(v);
    const digits = countDigits(v);
    if (letters === 0 && digits === 0) return true;
    if (letters === 0 && digits <= 2 && v.length <= 4) return true;
    if (letters < 3 && digits > 0 && v.length <= 5) return true;
    if (letters < 4 && lettersRatio(v) < 0.25 && v.length <= 14) return true;
    if ((low.includes('сообщен') || low.includes('ообщен') || low.includes('наберите') || low.includes('напишите')) && v.length <= 30) {
      return true;
    }
    return false;
  }

  function cleanupMessageText(text, timeMinutes) {
    const v0 = String(text ?? '')
      .replace(/[|`]+/g, ' ')
      .replace(/[\u200B\uFEFF]/g, '')
      .replace(/[ \t\f\v\u00A0]+/g, ' ')
      .replace(/\bMHe\b/g, 'Мне')
      .replace(/\bH[уy]\b/gu, 'Ну')
      .trim();
    if (!v0) return '';

    const overallLetters = countLetters(v0);
    const overallDigits = countDigits(v0);
    const overallRatio = lettersRatio(v0);
    const latin = (v0.match(/[A-Za-z]/g) ?? []).length;
    const cyr = (v0.match(/[\p{Script=Cyrillic}]/gu) ?? []).length;
    const shouldPickTail =
      (overallRatio < 0.52 && (overallDigits >= 6 || v0.length >= 90)) ||
      (overallDigits >= 10 && v0.length >= 70) ||
      (latin >= 6 && cyr >= 12 && v0.length >= 60) ||
      /\b\p{L}{2,}\s+\d{1,2}:\s*\p{L}{2,}\b/iu.test(v0);

    let baseCandidate = v0;
    if (shouldPickTail) {
      const low = v0.toLowerCase();
      const starters = ['что', 'как', 'почему', 'когда', 'где', 'кто', 'ну', 'я', 'мы', 'ты', 'вы', 'он', 'она', 'они', 'да', 'нет'];
      const re = new RegExp(`(?:^|\\s)(${starters.join('|')})\\s+`, 'giu');
      let last = null;
      for (const m of low.matchAll(re)) {
        last = m;
      }
      if (last && typeof last.index === 'number') {
        const start = last.index + (String(last[0]).startsWith(' ') ? 1 : 0);
        const cut = String(v0).slice(start).trim();
        if (cut.length >= 8 && lettersRatio(cut) >= 0.42) {
          baseCandidate = cut;
        }
      }

      const parts = v0
        .split(/(?:\s[—-]\s|[|/]|\s{2,})/u)
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
      for (let i = parts.length - 1; i >= 0 && parts.length - i <= 7; i -= 1) {
        const p = parts[i];
        const letters = countLetters(p);
        if (letters >= 7 && lettersRatio(p) >= 0.48) {
          baseCandidate = p;
          break;
        }
        if (letters >= 5 && /[?!]/u.test(p)) {
          baseCandidate = p;
          break;
        }
      }
    }

    const base = baseCandidate
      .replace(/^[›»«—\-\s]+/u, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!base) return '';

    const tokens = base.split(/\s+/u).filter(Boolean);
    const totalLetters = countLetters(base);
    const out = [];

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      const t = token
        .replace(/^[“”"'()\[\]{}]+|[“”"'()\[\]{}]+$/gu, '')
        .replace(/[.,;:]+$/gu, '');
      if (!t) continue;
      if (/^\d+\/\d*$/u.test(t)) continue;
      if (/^\d+[\\/]+$/u.test(t)) continue;
      if (/^\d+\)$/u.test(t)) continue;
      if (/^[^\p{L}\p{N}]+$/u.test(t)) continue;

      if (/^\d$/u.test(t) && totalLetters >= 18) continue;

      if (/^\d{3}$/u.test(t) && totalLetters >= 18) {
        const nextRaw = typeof tokens[i + 1] === 'string' ? tokens[i + 1] : '';
        const next = String(nextRaw)
          .replace(/^[“”"'()\[\]{}]+|[“”"'()\[\]{}]+$/gu, '')
          .replace(/[.,;:]+$/gu, '')
          .toLowerCase();
        if (next !== 'руб' && next !== 'р' && next !== '₽') continue;
      }

      if (/^\d{3,4}$/u.test(t) && typeof timeMinutes === 'number') {
        const parsed = parseTimeFromDigits(t, timeMinutes) ?? parseTimeFromDigits(t, null);
        if (parsed && Math.abs(parsed.minutes - timeMinutes) <= 2) continue;
      }

      if (/^[A-Za-z]$/u.test(t) && totalLetters >= 18) continue;
      if (/^[\p{L}]$/u.test(t) && totalLetters >= 18) continue;
      if (/^[\p{Lu}]{2,4}$/u.test(t) && i <= 1 && tokens.length >= 4) continue;

      out.push(t);
    }

    let cleaned = out.join(' ').replace(/\s{2,}/g, ' ').trim();
    if (!cleaned) return '';

    const dateLike = cleaned.match(/^(\d{1,2})\s+([\p{L}]{3,})(?:\s+(\d{4}))?\s+(\S[\s\S]*)$/u);
    if (dateLike) {
      const rest = String(dateLike[4] ?? '').trim();
      const restLow = rest.toLowerCase();
      const starters = ['что', 'как', 'почему', 'когда', 'где', 'кто', 'ну', 'я', 'мы', 'ты', 'вы', 'он', 'она', 'они', 'да', 'нет'];
      const re = new RegExp(`(?:^|\\s)(${starters.join('|')})\\s+`, 'iu');
      const m0 = restLow.match(re);
      if (rest.length >= 10 && m0 && typeof m0.index === 'number') {
        const start = m0.index + (String(m0[0]).startsWith(' ') ? 1 : 0);
        const cut = rest.slice(start).trim();
        if (cut.length >= 6) cleaned = cut;
      }
    }

    const m = cleaned.match(/^(\p{Lu}[\p{L}\p{M}]|\p{Lu}[\p{L}\p{M}]{2,})\s+(\S[\s\S]*)$/u);
    if (m) {
      const first = String(m[1] ?? '').trim();
      const rest = String(m[2] ?? '').trim();
      const restLow = rest.toLowerCase();
      const starters = ['что', 'как', 'почему', 'когда', 'где', 'кто', 'ну', 'я', 'мы', 'ты', 'вы', 'он', 'она', 'они', 'да', 'нет'];
      if (first.length <= 5 && starters.some((s) => restLow.startsWith(s + ' ') || restLow === s || restLow.startsWith(s + '\u00A0'))) {
        cleaned = rest;
      }
    }

    return cleaned
      .replace(/\s+([?!.,:;])/g, '$1')
      .replace(/([?!]){2,}/g, '$1')
      .replace(/\.{3,}/g, '..')
      .trim();
  }

  const endTimeLikeCount = lines.filter((l) => extractTimeFromEnd(l, null)).length;
  const shouldUseEndTimeParser = endTimeLikeCount >= 2;

  if (shouldUseEndTimeParser) {
    if (hasSideInfo && richLines.some((l) => typeof l?.top === 'number' && typeof l?.bottom === 'number')) {
      const formatted = [];
      let lastTimeMinutes = null;

      const heights = richLines
        .map((l) => (typeof l?.top === 'number' && typeof l?.bottom === 'number' ? Math.max(1, l.bottom - l.top) : null))
        .filter((x) => typeof x === 'number');
      heights.sort((a, b) => a - b);
      const medianHeight = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 18;
      const gapThreshold = Math.max(18, Math.min(34, Math.round(medianHeight * 1.15)));

      const firstTimeIndex = richLines.findIndex((l) => Boolean(extractTimeFromEnd(l?.text ?? '', null)));
      const startIndex = firstTimeIndex >= 0 ? firstTimeIndex : 0;

      const bubbles = [];
      let current = null;

      function endsWithTimeToken(text) {
        const v = String(text ?? '').trim();
        if (!v) return false;
        return Boolean(extractTimeFromEnd(v, null));
      }

      for (let i = startIndex; i < richLines.length; i += 1) {
        const item = richLines[i];
        const line = item?.text ?? '';
        if (!line) continue;
        if (isDaySeparator(line)) continue;
        if (looksLikeHeaderNoise(line)) continue;
        if (isProbablyNoiseLine(line)) continue;

        const top = typeof item.top === 'number' ? item.top : null;
        const bottom = typeof item.bottom === 'number' ? item.bottom : null;
        const side = item.side;

        const lineEndsWithTime = endsWithTimeToken(line);

        const canJoin =
          current &&
          current.side &&
          side &&
          current.side === side &&
          current.endsWithTime !== true &&
          typeof top === 'number' &&
          typeof current.bottom === 'number' &&
          top - current.bottom <= gapThreshold;

        if (!current || !canJoin) {
          if (current) bubbles.push(current);
          current = { side, top, bottom, lines: [item], endsWithTime: lineEndsWithTime };
        } else {
          current.lines.push(item);
          if (typeof bottom === 'number') current.bottom = typeof current.bottom === 'number' ? Math.max(current.bottom, bottom) : bottom;
          current.endsWithTime = lineEndsWithTime;
        }
      }
      if (current) bubbles.push(current);

      for (const bubble of bubbles) {
        const joined = Array.isArray(bubble?.lines)
          ? bubble.lines
              .map((x) => String(x?.text ?? '').trim())
              .filter(Boolean)
              .join(' ')
              .replace(/\s{2,}/g, ' ')
              .trim()
          : '';
        if (!joined) continue;

        const extracted = extractTimeFromEnd(joined, lastTimeMinutes);
        if (!extracted && lastTimeMinutes === null) continue;
        const time = extracted?.time ? String(extracted.time) : lastTimeMinutes !== null ? `${String(Math.floor(lastTimeMinutes / 60)).padStart(2, '0')}:${String(lastTimeMinutes % 60).padStart(2, '0')}` : '??:??';
        if (typeof extracted?.minutes === 'number') lastTimeMinutes = extracted.minutes;

        const before = extracted?.before ? String(extracted.before).trim() : joined;
        const inline = before.match(/^([^:]{1,60}):\s*(.+)$/u);
        let name = '';
        let msg = before;
        if (inline && looksLikeName(inline[1])) {
          name = String(inline[1]).trim();
          msg = String(inline[2]).trim();
        }

        const sidePicked = bubble?.side || pickDominantSide(bubble?.lines);
        if (!name) name = speakerFromSide(sidePicked) || 'Собеседник';

        const cleanedMessage = cleanupMessageText(msg, lastTimeMinutes);
        if (!cleanedMessage) continue;
        formatted.push(`${time} - ${name}: ${cleanedMessage}`);
      }

      return formatted.join('\n').trim();
    }

    const formatted = [];
    let buffer = [];
    let lastPossibleName = '';
    let lastTimeMinutes = null;

    const firstTimeIndex = lines.findIndex((l) => Boolean(extractTimeFromEnd(l, null)));
    const startIndex = firstTimeIndex >= 0 ? firstTimeIndex : 0;

    for (let i = startIndex; i < lines.length; i += 1) {
      const line = lines[i];
      if (isDaySeparator(line)) continue;
      if (looksLikeHeaderNoise(line)) continue;

      const extracted = extractTimeFromEnd(line, lastTimeMinutes);
      if (!extracted) {
        if (!hasSideInfo && looksLikeName(line)) {
          lastPossibleName = line;
          continue;
        }
        buffer.push(line);
        continue;
      }

      const before = String(extracted.before ?? '').trim();
      const time = String(extracted.time ?? '').trim();
      lastTimeMinutes = typeof extracted.minutes === 'number' ? extracted.minutes : lastTimeMinutes;

      const collected = buffer
        .concat(before)
        .map((x) => String(x).trim())
        .filter(Boolean)
        .filter((x) => !isProbablyNoiseLine(x));
      buffer = [];

      if (!time) continue;
      if (collected.length === 0) {
        lastPossibleName = '';
        continue;
      }

      let name = '';
      let message = '';

      const first = collected[0] ?? '';
      const inline = first.match(/^([^:]{1,60}):\s*(.+)$/);
      if (inline && looksLikeName(inline[1])) {
        name = String(inline[1]).trim();
        const rest = [String(inline[2]).trim()].concat(collected.slice(1));
        message = rest.join(' ').replace(/\s{2,}/g, ' ').trim();
      } else {
        const candidateName = lastPossibleName && looksLikeName(lastPossibleName) ? lastPossibleName : '';
        name = candidateName;
        message = collected.join(' ').replace(/\s{2,}/g, ' ').trim();
      }

      lastPossibleName = '';
      const cleanedMessage = cleanupMessageText(message, lastTimeMinutes);
      if (!cleanedMessage) continue;
      formatted.push(`${time} - ${name || 'Собеседник'}: ${cleanedMessage}`);
    }

    return formatted.join('\n').trim();
  }

  if (effectiveMode === 'whatsapp') {
    const formatted = [];
    let buffer = [];
    let lastPossibleName = '';

    for (let i = 0; i < richLines.length; i += 1) {
      const item = richLines[i];
      const line = item?.text ?? '';
      if (!line) continue;
      if (isDaySeparator(line)) continue;

      const m = String(line).match(/^(.*?)(\b\d{1,2}:\d{2})$/u);
      if (!m) {
        if (!hasSideInfo && looksLikeName(line)) {
          lastPossibleName = line;
          continue;
        }
        buffer.push(item);
        continue;
      }

      const before = String(m[1] ?? '').trim();
      const time = String(m[2] ?? '').trim();
      const collected = buffer
        .concat([{ text: before, side: item?.side ?? null }])
        .map((x) => ({ text: String(x?.text ?? x ?? '').trim(), side: x?.side ?? null }))
        .filter((x) => Boolean(x.text));
      buffer = [];

      if (!time) continue;
      if (collected.length === 0) continue;

      let name = '';
      let message = '';

      const first = collected[0]?.text ?? '';
      const inline = String(first).match(/^([^:]{2,40}):\s*(.+)$/);
      if (inline && looksLikeName(inline[1])) {
        name = String(inline[1]).trim();
        const rest = [String(inline[2]).trim()].concat(collected.slice(1).map((x) => x.text));
        message = rest.join(' ').replace(/\s{2,}/g, ' ').trim();
      } else {
        const candidateName = lastPossibleName && looksLikeName(lastPossibleName) ? lastPossibleName : '';
        name = candidateName;
        message = collected.map((x) => x.text).join(' ').replace(/\s{2,}/g, ' ').trim();
      }

      lastPossibleName = '';
      const t = String(time).replace(/\D/g, '');
      const h = Number(t.slice(0, 2));
      const mm = Number(t.slice(2));
      const minutes = Number.isInteger(h) && Number.isInteger(mm) ? h * 60 + mm : null;
      const cleanedMessage = cleanupMessageText(message, typeof minutes === 'number' ? minutes : null);
      if (!cleanedMessage) continue;
      const sidePicked = item?.side || pickDominantSide(collected);
      const fallbackName = hasSideInfo ? speakerFromSide(sidePicked) : '';
      formatted.push(`${time} - ${name || fallbackName || 'Собеседник'}: ${cleanedMessage}`);
    }

    return formatted.join('\n').trim();
  }

  const blocks = [];
  let current = null;

  for (let i = 0; i < richLines.length; i += 1) {
    const item = richLines[i];
    const line = item?.text ?? '';
    if (!line) continue;
    const m = String(line).match(/^(\d{1,2}:\d{2})\b\s*(.*)$/);
    if (m) {
      if (current) blocks.push(current);
      const time = m[1];
      const restRaw = String(m[2] ?? '').trim();
      const letters = (restRaw.match(/[\p{L}]/gu) ?? []).length;
      const digits = (restRaw.match(/[\p{N}]/gu) ?? []).length;
      const keepRest = letters >= 4 || (letters >= 3 && digits >= 2);
      const rest = keepRest ? restRaw : '';
      current = { time, items: rest ? [{ text: rest, side: item?.side ?? null }] : [] };
      continue;
    }
    if (!current) continue;
    current.items.push({ text: String(line).trim(), side: item?.side ?? null });
  }
  if (current) blocks.push(current);

  const formatted = [];
  for (const block of blocks) {
    const time = String(block.time ?? '').trim();
    if (!time) continue;
    const rawLines = Array.isArray(block.items)
      ? block.items
          .map((l) => ({ text: String(l?.text ?? '').trim(), side: l?.side ?? null }))
          .filter((x) => Boolean(x.text))
      : [];
    if (rawLines.length === 0) continue;

    let name = '';
    const msgLines = [];
    const first = rawLines[0]?.text ?? '';
    const inline = String(first).match(/^([^:]{2,40}):\s*(.+)$/);
    if (inline && looksLikeName(inline[1])) {
      name = String(inline[1]).trim();
      msgLines.push(String(inline[2]).trim());
      msgLines.push(...rawLines.slice(1).map((x) => x.text));
    } else if (!hasSideInfo && looksLikeName(first) && rawLines.length >= 2) {
      name = first;
      msgLines.push(...rawLines.slice(1).map((x) => x.text));
    } else {
      msgLines.push(...rawLines.map((x) => x.text));
    }

    const message = msgLines
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const t = String(time).replace(/\D/g, '');
    const h = Number(t.slice(0, 2));
    const mm = Number(t.slice(2));
    const minutes = Number.isInteger(h) && Number.isInteger(mm) ? h * 60 + mm : null;
    const cleanedMessage = cleanupMessageText(message, typeof minutes === 'number' ? minutes : null);
    if (!cleanedMessage) continue;
    const sidePicked = pickDominantSide(rawLines);
    const fallbackName = hasSideInfo ? speakerFromSide(sidePicked) : '';
    formatted.push(`${time} - ${name || fallbackName || 'Собеседник'}: ${cleanedMessage}`);
  }

  return formatted.join('\n').trim();
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
  const primary = typeof process.env.SESSION_SECRET === 'string' ? process.env.SESSION_SECRET.trim() : '';
  const fallback = typeof process.env.JWT_SECRET === 'string' ? process.env.JWT_SECRET.trim() : '';
  const secret = primary || fallback;
  if (!secret) {
    const err = new Error('SESSION_SECRET не задан (можно также задать JWT_SECRET для совместимости)');
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
  const expectedToken = typeof process.env.PAYMENT_WEBHOOK_TOKEN === 'string' ? process.env.PAYMENT_WEBHOOK_TOKEN.trim() : '';
  const allowedCidrs = parseAllowedCidrs(process.env.PAYMENT_WEBHOOK_ALLOWED_CIDRS);

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

function verifyWebhookRequestOptionalToken(req) {
  const expectedToken = typeof process.env.PAYMENT_WEBHOOK_TOKEN === 'string' ? process.env.PAYMENT_WEBHOOK_TOKEN.trim() : '';
  const allowedCidrs = parseAllowedCidrs(process.env.PAYMENT_WEBHOOK_ALLOWED_CIDRS);

  if (expectedToken) {
    const tokenFromPath = typeof req.params?.token === 'string' ? req.params.token.trim() : '';
    if (tokenFromPath && tokenFromPath !== expectedToken) {
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

function getTelegramBotToken() {
  const token = typeof process.env.TELEGRAM_BOT_TOKEN === 'string' ? process.env.TELEGRAM_BOT_TOKEN.trim() : '';
  if (!token) {
    const err = new Error('TELEGRAM_BOT_TOKEN не задан');
    err.statusCode = 500;
    throw err;
  }
  return token;
}

function getTelegramAuthMaxAgeSeconds() {
  const raw = typeof process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS === 'string' ? process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS.trim() : '';
  if (!raw) return 300;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 30 || n > 86400) {
    const err = new Error('TELEGRAM_AUTH_MAX_AGE_SECONDS должен быть числом от 30 до 86400');
    err.statusCode = 500;
    throw err;
  }
  return Math.trunc(n);
}

function timingSafeEqualHex(a, b) {
  const ax = typeof a === 'string' ? a.trim().toLowerCase() : '';
  const bx = typeof b === 'string' ? b.trim().toLowerCase() : '';
  if (!ax || !bx) return false;
  if (!/^[0-9a-f]+$/.test(ax) || !/^[0-9a-f]+$/.test(bx)) return false;
  if (ax.length !== bx.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(ax, 'hex'), Buffer.from(bx, 'hex'));
  } catch {
    return false;
  }
}

function verifyTelegramLoginPayload(query) {
  const q = query && typeof query === 'object' ? query : {};
  const fields = {};
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === 'string' || typeof v === 'number') fields[k] = String(v);
    else if (Array.isArray(v) && (typeof v[0] === 'string' || typeof v[0] === 'number')) fields[k] = String(v[0]);
  }

  const hash = typeof fields.hash === 'string' ? fields.hash : '';
  const id = typeof fields.id === 'string' ? fields.id : '';
  const authDateRaw = typeof fields.auth_date === 'string' ? fields.auth_date : '';
  const authDate = Number(authDateRaw);
  if (!hash || !id || !Number.isFinite(authDate)) {
    const err = new Error('Telegram: некорректные данные авторизации');
    err.statusCode = 400;
    throw err;
  }

  const maxAge = getTelegramAuthMaxAgeSeconds();
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (authDate < nowSeconds - maxAge || authDate > nowSeconds + 60) {
    const err = new Error('Telegram: данные авторизации устарели');
    err.statusCode = 401;
    throw err;
  }

  const pairs = Object.entries(fields)
    .filter(([k]) => k !== 'hash')
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const botToken = getTelegramBotToken();
  const secretKey = crypto.createHash('sha256').update(botToken, 'utf8').digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString, 'utf8').digest('hex');
  if (!timingSafeEqualHex(computed, hash)) {
    const err = new Error('Telegram: подпись не совпадает');
    err.statusCode = 401;
    throw err;
  }

  const telegramId = String(id).trim();
  if (!telegramId) {
    const err = new Error('Telegram: не удалось определить пользователя');
    err.statusCode = 400;
    throw err;
  }

  const username = typeof fields.username === 'string' ? fields.username.trim() : '';
  const firstName = typeof fields.first_name === 'string' ? fields.first_name.trim() : '';
  const lastName = typeof fields.last_name === 'string' ? fields.last_name.trim() : '';
  const photoUrl = typeof fields.photo_url === 'string' ? fields.photo_url.trim() : '';

  return {
    telegramId,
    telegramUsername: username || null,
    telegramFirstName: firstName || null,
    telegramLastName: lastName || null,
    telegramPhotoUrl: photoUrl || null,
  };
}

function buildUserLabel(user) {
  const username = typeof user.telegramUsername === 'string' ? user.telegramUsername.trim() : '';
  if (username) return `@${username}`;
  const firstName = typeof user.telegramFirstName === 'string' ? user.telegramFirstName.trim() : '';
  const lastName = typeof user.telegramLastName === 'string' ? user.telegramLastName.trim() : '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  if (email) return email;
  const tid = typeof user.telegramId === 'string' ? user.telegramId.trim() : '';
  if (tid) return `tg:${tid}`;
  return 'пользователь';
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
  const fullAnalysis = typeof (r.full_analysis ?? r.analysis) === 'string' ? String(r.full_analysis ?? r.analysis) : '';

  const baseRating = Number.isFinite(rating) ? Math.max(0, Math.min(100, Math.round(rating))) : 50;

  const combinedText = `${shortVerdict} ${teaser} ${fullAnalysis}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const positiveMarkers = [
    'всё хорошо',
    'все хорошо',
    'токсичности нет',
    'нет токсичности',
    'красных флагов нет',
    'ред флагов нет',
    'в порядке',
    'всё ок',
    'все ок',
    'похоже норм',
  ];

  const negativeMarkers = [
    'срочно беги',
    'беги',
    'опасно',
    'токсично',
    'токсичн',
    'абьюз',
    'газлайтинг',
    'манипуля',
    'шантаж',
    'контроль',
    'обесценив',
    'ревност',
    'давлен',
  ];

  const hasPositive = positiveMarkers.some((m) => combinedText.includes(m));
  const hasNegative = negativeMarkers.some((m) => combinedText.includes(m));

  const fixedRating = (() => {
    if (hasPositive && !hasNegative && baseRating >= 70) return 100 - baseRating;
    if (hasNegative && !hasPositive && baseRating <= 30) return 100 - baseRating;
    return baseRating;
  })();

  return {
    rating: fixedRating,
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

function normalizeOgText(value) {
  const s = typeof value === 'string' ? value : '';
  return s.replace(/\s+/g, ' ').trim();
}

function wrapOgText(value, maxChars) {
  const text = normalizeOgText(value);
  if (!text) return [];
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const rawWord of words) {
    const word = rawWord.trim();
    if (!word) continue;

    if (!current) {
      if (word.length <= maxChars) {
        current = word;
      } else {
        lines.push(`${word.slice(0, Math.max(1, maxChars - 1))}…`);
      }
      continue;
    }

    if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`;
      continue;
    }

    lines.push(current);
    if (word.length <= maxChars) {
      current = word;
    } else {
      current = '';
      lines.push(`${word.slice(0, Math.max(1, maxChars - 1))}…`);
    }
  }

  if (current) lines.push(current);
  return lines;
}

function clampOgLines(lines, maxLines) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  if (lines.length <= maxLines) return lines;

  const sliced = lines.slice(0, maxLines);
  const last = sliced[maxLines - 1] ?? '';
  if (!last.endsWith('…')) sliced[maxLines - 1] = `${last.replace(/\s+$/g, '')}…`;
  return sliced;
}

function estimateMaxCharsForFont(fontSizePx) {
  const availableWidth = 1040;
  const perChar = Math.max(12, Math.floor(availableWidth / (fontSizePx * 0.62)));
  return perChar;
}

function renderOgSvg({ rating, shortVerdict, teaser }) {
  const palette = pickOgPalette(rating);
  const rawTitle = normalizeOgText(shortVerdict);
  const rawSubtitle = normalizeOgText(teaser.length > 240 ? `${teaser.slice(0, 239).trim()}…` : teaser);
  const label = escapeXml(palette.label);
  const family = 'DejaVu Sans,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial';

  const subtitleFontSize = 28;
  const subtitleLineHeight = Math.round(subtitleFontSize * 1.28);
  const maxSubtitleChars = estimateMaxCharsForFont(subtitleFontSize);
  const subtitleLinesBase = clampOgLines(wrapOgText(rawSubtitle, maxSubtitleChars), 2);

  const titleFontCandidates = [58, 54, 50, 46, 42];
  let titleFontSize = 58;
  let titleLineHeight = Math.round(titleFontSize * 1.08);
  let titleLines = [];
  let subtitleLines = subtitleLinesBase;

  let titleTranslateY = 410;
  let subtitleTranslateY = 520;
  let ctaTranslateY = 600;

  for (const candidate of titleFontCandidates) {
    const maxTitleChars = estimateMaxCharsForFont(candidate);
    const candidateLines = clampOgLines(wrapOgText(rawTitle, maxTitleChars), 2);
    const candidateTitleLineHeight = Math.round(candidate * 1.08);

    const titleLastBaselineY = candidateLines.length === 0 ? candidate : candidate + (candidateLines.length - 1) * candidateTitleLineHeight;
    const candidateTitleTranslateY = 410;
    const candidateSubtitleTranslateY = candidateTitleTranslateY + titleLastBaselineY + 28;
    const subtitleLineCount = subtitleLinesBase.length;
    const subtitleLastBaselineY = subtitleLineCount === 0 ? subtitleFontSize : subtitleFontSize + (subtitleLineCount - 1) * subtitleLineHeight;
    const candidateCtaTranslateY = candidateSubtitleTranslateY + subtitleLastBaselineY + 34;

    if (candidateCtaTranslateY + 22 <= 610) {
      titleFontSize = candidate;
      titleLineHeight = candidateTitleLineHeight;
      titleLines = candidateLines;
      subtitleLines = subtitleLinesBase;
      titleTranslateY = candidateTitleTranslateY;
      subtitleTranslateY = candidateSubtitleTranslateY;
      ctaTranslateY = candidateCtaTranslateY;
      break;
    }

    const subtitleSingle = clampOgLines(subtitleLinesBase, 1);
    const subtitleSingleLastBaselineY =
      subtitleSingle.length === 0 ? subtitleFontSize : subtitleFontSize + (subtitleSingle.length - 1) * subtitleLineHeight;
    const candidateCtaTranslateY2 = candidateSubtitleTranslateY + subtitleSingleLastBaselineY + 34;
    if (candidateCtaTranslateY2 + 22 <= 610) {
      titleFontSize = candidate;
      titleLineHeight = candidateTitleLineHeight;
      titleLines = candidateLines;
      subtitleLines = subtitleSingle;
      titleTranslateY = candidateTitleTranslateY;
      subtitleTranslateY = candidateSubtitleTranslateY;
      ctaTranslateY = candidateCtaTranslateY2;
      break;
    }

    titleFontSize = candidate;
    titleLineHeight = candidateTitleLineHeight;
    titleLines = candidateLines;
    subtitleLines = subtitleSingle;
    titleTranslateY = candidateTitleTranslateY;
    subtitleTranslateY = candidateSubtitleTranslateY;
    ctaTranslateY = candidateCtaTranslateY2;
  }

  const safeTitleLines = titleLines.length > 0 ? titleLines : clampOgLines(wrapOgText(rawTitle, 28), 2);
  const safeSubtitleLines = subtitleLines.length > 0 ? subtitleLines : clampOgLines(wrapOgText(rawSubtitle, 56), 2);

  const titleSvg = safeTitleLines
    .map((line, index) => {
      const y = titleFontSize + index * titleLineHeight;
      return `<text x="0" y="${y}" fill="#ffffff" font-size="${titleFontSize}" font-weight="900">${escapeXml(line)}</text>`;
    })
    .join('\n      ');

  const subtitleSvg = safeSubtitleLines
    .map((line, index) => {
      const y = subtitleFontSize + index * subtitleLineHeight;
      return `<text x="0" y="${y}" fill="#cbd5e1" font-size="${subtitleFontSize}" font-weight="600">${escapeXml(line)}</text>`;
    })
    .join('\n      ');

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

  <g font-family="${family}">
    <text x="80" y="110" fill="#e2e8f0" font-size="28" font-weight="800" letter-spacing="6">REDFLAG SCANNER</text>

    <g transform="translate(80 170)">
      <rect x="0" y="0" width="220" height="54" rx="27" fill="${palette.accent}" fill-opacity="0.18" stroke="${palette.accent}" stroke-opacity="0.35" />
      <text x="110" y="36" text-anchor="middle" fill="#ffffff" font-size="16" font-weight="900" letter-spacing="4">${label}</text>
    </g>

    <g transform="translate(80 260)">
      <text x="0" y="92" fill="#ffffff" font-size="92" font-weight="900">${rating}</text>
      <text x="168" y="80" fill="#94a3b8" font-size="24" font-weight="800" letter-spacing="4">/ 100</text>
      <text x="0" y="132" fill="#94a3b8" font-size="18" font-weight="800" letter-spacing="6">РЕЙТИНГ</text>
    </g>

    <g transform="translate(80 ${titleTranslateY})">
      ${titleSvg}
    </g>

    <g transform="translate(80 ${subtitleTranslateY})">
      ${subtitleSvg}
    </g>

    <g transform="translate(80 ${ctaTranslateY})">
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
  skip: (req) => {
    const p = typeof req?.path === 'string' ? req.path : '';
    if (p === '/api/health') return true;
    if (p === '/api/auth/csrf') return true;
    if (p.startsWith('/api/payment/webhook')) return true;
    return false;
  },
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

const ocrLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Слишком много распознаваний. Попробуй позже.' });
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

const csrfLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  limit: 200,
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
    res.json({ user: { id: ctx.user.id, label: buildUserLabel(ctx.user), email: ctx.user.email ?? null } });
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

app.get('/robots.txt', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const body = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /*?shareId=
Disallow: /*&shareId=
Disallow: /*?analysisId=
Disallow: /*&analysisId=
Disallow: /*?payment=
Disallow: /*&payment=

Sitemap: ${baseUrl}/sitemap.xml
`;

  res
    .status(200)
    .setHeader('Cache-Control', 'public, max-age=3600')
    .type('text/plain; charset=utf-8')
    .send(body);
});

app.get('/sitemap.xml', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${baseUrl}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${baseUrl}/lp`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl}/lp/toxic-relationship`, changefreq: 'weekly', priority: '0.8' },
    { loc: `${baseUrl}/lp/gaslighting`, changefreq: 'weekly', priority: '0.8' },
    { loc: `${baseUrl}/lp/manipulation`, changefreq: 'weekly', priority: '0.8' },
    { loc: `${baseUrl}/lp/red-flags`, changefreq: 'weekly', priority: '0.8' },
    { loc: `${baseUrl}/lp/abuser-check`, changefreq: 'weekly', priority: '0.8' },
    { loc: `${baseUrl}/lp/control`, changefreq: 'weekly', priority: '0.8' },
    { loc: `${baseUrl}/lp/silent-treatment`, changefreq: 'weekly', priority: '0.8' },
    { loc: `${baseUrl}/lp/boundaries`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl}/lp/jealousy`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl}/lp/devaluation`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl}/lp/ultimatums`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl}/lp/love-bombing`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl}/lp/passive-aggression`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl}/lp/blame-shifting`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl}/lp/blackmail`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${baseUrl}/lp/ghosting`, changefreq: 'weekly', priority: '0.7' },
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (item) => `  <url>
    <loc>${escapeXml(item.loc)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${escapeXml(item.changefreq)}</changefreq>
    <priority>${escapeXml(item.priority)}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`;

  res
    .status(200)
    .setHeader('Cache-Control', 'public, max-age=3600')
    .type('application/xml; charset=utf-8')
    .send(xml);
});

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getOcrMaxBytes() {
  const fromEnv = getEnvInt('OCR_MAX_BYTES');
  if (fromEnv && Number.isFinite(fromEnv) && fromEnv >= 1024 * 1024 && fromEnv <= 30 * 1024 * 1024) {
    return Math.trunc(fromEnv);
  }
  return 8 * 1024 * 1024;
}

async function runTesseractOcr({ buffer }) {
  const lang = (typeof process.env.OCR_LANG === 'string' ? process.env.OCR_LANG.trim() : '') || 'rus+eng';
  const psm = getEnvInt('OCR_PSM') ?? 6;
  const timeoutMs = getEnvInt('OCR_TIMEOUT_MS') ?? 20000;

  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rfs-ocr-'));
  const inputPath = path.join(tmpBase, 'input.png');
  try {
    await fs.promises.writeFile(inputPath, buffer);
    const { stdout } = await execFileAsync(
      'tesseract',
      [inputPath, 'stdout', '-l', lang, '--psm', String(psm), '-c', 'preserve_interword_spaces=1'],
      {
        timeout: Math.max(3000, Math.min(90000, timeoutMs)),
        maxBuffer: 6 * 1024 * 1024,
      },
    );
    return String(stdout ?? '');
  } finally {
    try {
      await fs.promises.rm(tmpBase, { recursive: true, force: true });
    } catch {
      return;
    }
  }
}

async function runTesseractOcrTsv({ buffer }) {
  const lang = (typeof process.env.OCR_LANG === 'string' ? process.env.OCR_LANG.trim() : '') || 'rus+eng';
  const psm = getEnvInt('OCR_PSM') ?? 6;
  const timeoutMs = getEnvInt('OCR_TIMEOUT_MS') ?? 20000;

  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rfs-ocr-'));
  const inputPath = path.join(tmpBase, 'input.png');
  try {
    await fs.promises.writeFile(inputPath, buffer);
    const { stdout } = await execFileAsync(
      'tesseract',
      [inputPath, 'stdout', '-l', lang, '--psm', String(psm), '-c', 'preserve_interword_spaces=1', 'tsv'],
      {
        timeout: Math.max(3000, Math.min(90000, timeoutMs)),
        maxBuffer: 18 * 1024 * 1024,
      },
    );
    return String(stdout ?? '');
  } finally {
    try {
      await fs.promises.rm(tmpBase, { recursive: true, force: true });
    } catch {
      return;
    }
  }
}

function parseTesseractTsvToRichLines(tsv) {
  const rows = String(tsv ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (rows.length < 2) return null;

  const header = rows[0].split('\t');
  const idx = new Map();
  for (let i = 0; i < header.length; i += 1) idx.set(header[i], i);
  const required = ['page_num', 'block_num', 'par_num', 'line_num', 'word_num', 'left', 'top', 'width', 'height', 'conf', 'text'];
  if (!required.every((k) => idx.has(k))) return null;

  function get(row, name) {
    const i = idx.get(name);
    if (typeof i !== 'number') return '';
    return row[i] ?? '';
  }

  const groups = new Map();
  let pageMaxRight = 0;

  for (let r = 1; r < rows.length; r += 1) {
    const cols = rows[r].split('\t');
    if (cols.length < header.length) continue;

    const text = String(get(cols, 'text') ?? '').trim();
    if (!text) continue;

    const left = Number(get(cols, 'left'));
    const top = Number(get(cols, 'top'));
    const width = Number(get(cols, 'width'));
    const height = Number(get(cols, 'height'));
    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) continue;

    const right = left + width;
    const bottom = top + height;
    if (right > pageMaxRight) pageMaxRight = right;

    const key = [get(cols, 'page_num'), get(cols, 'block_num'), get(cols, 'par_num'), get(cols, 'line_num')].join(':');
    const existing = groups.get(key);
    const word = {
      text,
      left,
      top,
      right,
      bottom,
      conf: Number(get(cols, 'conf')),
      wordNum: Number(get(cols, 'word_num')),
    };
    if (!existing) {
      groups.set(key, { words: [word] });
    } else {
      existing.words.push(word);
    }
  }

  if (!Number.isFinite(pageMaxRight) || pageMaxRight <= 0) return null;

  const out = [];
  for (const group of groups.values()) {
    const words = Array.isArray(group?.words) ? group.words : [];
    if (words.length === 0) continue;
    words.sort((a, b) => {
      if (Number.isFinite(a.wordNum) && Number.isFinite(b.wordNum) && a.wordNum !== b.wordNum) return a.wordNum - b.wordNum;
      if (a.left !== b.left) return a.left - b.left;
      return a.top - b.top;
    });

    let leftMin = Infinity;
    let rightMax = -Infinity;
    let topMin = Infinity;
    let bottomMax = -Infinity;
    const parts = [];
    for (const w of words) {
      leftMin = Math.min(leftMin, w.left);
      rightMax = Math.max(rightMax, w.right);
      topMin = Math.min(topMin, w.top);
      bottomMax = Math.max(bottomMax, w.bottom);
      parts.push(String(w.text));
    }
    const text = parts.join(' ').replace(/\s{2,}/g, ' ').trim();
    if (!text) continue;

    const lineWidth = Math.max(0, rightMax - leftMin);
    const mid = (leftMin + rightMax) / 2;
    const wideRatio = pageMaxRight > 0 ? lineWidth / pageMaxRight : 0;
    const marginLeft = pageMaxRight > 0 ? leftMin / pageMaxRight : 0;
    const marginRight = pageMaxRight > 0 ? (pageMaxRight - rightMax) / pageMaxRight : 0;
    let side = null;
    if (wideRatio < 0.82) {
      if (mid >= pageMaxRight * 0.58) side = 'right';
      else if (mid <= pageMaxRight * 0.42) side = 'left';
    } else {
      if (marginRight <= 0.08 && marginLeft >= 0.18) side = 'right';
      else if (marginLeft <= 0.08 && marginRight >= 0.18) side = 'left';
    }

    out.push({ text, left: leftMin, right: rightMax, top: topMin, bottom: bottomMax, side });
  }

  out.sort((a, b) => {
    if (a.top !== b.top) return a.top - b.top;
    return a.left - b.left;
  });

  return out;
}

app.post(
  '/api/ocr',
  ocrLimiter,
  express.raw({ type: ['image/png', 'image/jpeg'], limit: getOcrMaxBytes() }),
  requireCsrf(async (req, res) => {
    const consent = toBoolean(req.headers['x-consent']);
    if (consent !== true) {
      const err = new Error('Нужно согласие на обработку персональных данных');
      err.statusCode = 400;
      throw err;
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      const err = new Error('Нужно передать изображение');
      err.statusCode = 400;
      throw err;
    }

    try {
      let richLines = null;
      try {
        const tsv = await runTesseractOcrTsv({ buffer: body });
        richLines = parseTesseractTsvToRichLines(tsv);
      } catch {
        richLines = null;
      }

      const raw = Array.isArray(richLines) && richLines.length > 0 ? richLines.map((x) => x.text).join('\n') : await runTesseractOcr({ buffer: body });
      const formatted = Array.isArray(richLines) && richLines.length > 0 ? formatOcrDialogue(raw, 'auto', { ocrLines: richLines }) : formatOcrDialogue(raw);
      const text = sanitizeTextForUi(formatted || raw);
      res.status(200).json({ text });
    } catch {
      const err = new Error('Не удалось распознать текст');
      err.statusCode = 502;
      throw err;
    }
  }),
);

app.get('/api/auth/csrf', csrfLimiter, async (req, res, next) => {
  try {
    const token = makeCsrfToken();
    setCsrfCookie(req, res, token, getCsrfTtlSeconds());
    res.status(200).setHeader('Cache-Control', 'no-store').json({ csrfToken: token });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/telegram/login', authLimiter, requireCsrf(async (req, res, next) => {
  try {
    const payload = verifyTelegramLoginPayload(req.body);
    const prisma = getPrismaClient();
    const existing = await prisma.user.findUnique({ where: { telegramId: payload.telegramId } });
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            telegramId: payload.telegramId,
            telegramUsername: payload.telegramUsername,
            telegramFirstName: payload.telegramFirstName,
            telegramLastName: payload.telegramLastName,
            telegramPhotoUrl: payload.telegramPhotoUrl,
          },
        })
      : await prisma.user.create({
          data: {
            telegramId: payload.telegramId,
            telegramUsername: payload.telegramUsername,
            telegramFirstName: payload.telegramFirstName,
            telegramLastName: payload.telegramLastName,
            telegramPhotoUrl: payload.telegramPhotoUrl,
          },
        });

    const { token } = await createSessionForUser({ req, user });
    setSidCookie(req, res, token, getSessionTtlSeconds());
    const csrfToken = makeCsrfToken();
    setCsrfCookie(req, res, csrfToken, getCsrfTtlSeconds());

    res.status(200).json({ ok: true, user: { id: user.id, label: buildUserLabel(user) }, csrfToken });
  } catch (err) {
    next(err);
  }
}));

app.post('/api/auth/register', authLimiter, requireCsrf(async (req, res, next) => {
  try {
    const err = new Error('Регистрация через email отключена. Используй вход через Telegram.');
    err.statusCode = 410;
    throw err;
  } catch (err) {
    next(err);
  }
}));

app.post('/api/auth/login', authLimiter, requireCsrf(async (req, res, next) => {
  try {
    const err = new Error('Вход через email отключен. Используй вход через Telegram.');
    err.statusCode = 410;
    throw err;
  } catch (err) {
    next(err);
  }
}));

app.get('/api/auth/telegram/callback', authLimiter, async (req, res, next) => {
  try {
    const payload = verifyTelegramLoginPayload(req.query);
    const prisma = getPrismaClient();
    const existing = await prisma.user.findUnique({ where: { telegramId: payload.telegramId } });
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            telegramId: payload.telegramId,
            telegramUsername: payload.telegramUsername,
            telegramFirstName: payload.telegramFirstName,
            telegramLastName: payload.telegramLastName,
            telegramPhotoUrl: payload.telegramPhotoUrl,
          },
        })
      : await prisma.user.create({
          data: {
            telegramId: payload.telegramId,
            telegramUsername: payload.telegramUsername,
            telegramFirstName: payload.telegramFirstName,
            telegramLastName: payload.telegramLastName,
            telegramPhotoUrl: payload.telegramPhotoUrl,
          },
        });

    const { token } = await createSessionForUser({ req, user });
    setSidCookie(req, res, token, getSessionTtlSeconds());
    const csrfToken = makeCsrfToken();
    setCsrfCookie(req, res, csrfToken, getCsrfTtlSeconds());
    res.status(302).setHeader('Location', '/').end();
  } catch (err) {
    next(err);
  }
});

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
  const ogImage = `${baseUrl}/api/og/scan/${encodeURIComponent(scan.shareId)}.png?p=${scan.isPaid ? '1' : '0'}`;

  const title = `RedFlag Scanner — ${verdict.short_verdict}`;
  const description = `Рейтинг: ${verdict.rating}/100. ${verdict.teaser}`;
  const schemaJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    description,
    url: shareUrl,
    inLanguage: 'ru',
    primaryImageOfPage: { '@type': 'ImageObject', url: ogImage },
  }).replaceAll('</', '<\\/');

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

    <script type="application/ld+json">${schemaJson}</script>
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

app.get('/api/og/landing.svg', async (_req, res) => {
  const svg = renderOgSvg({
    rating: 86,
    shortVerdict: 'Проверь переписку на токсичность',
    teaser: 'Нейросеть находит красные флаги, манипуляции и газлайтинг в чатах.',
  });

  res
    .status(200)
    .setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
    .setHeader('Cache-Control', 'public, max-age=3600')
    .send(svg);
});

app.get('/api/og/landing.png', async (_req, res) => {
  const svg = renderOgSvg({
    rating: 86,
    shortVerdict: 'Проверь переписку на токсичность',
    teaser: 'Нейросеть находит красные флаги, манипуляции и газлайтинг в чатах.',
  });

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
  const png = resvg.render().asPng();

  res
    .status(200)
    .setHeader('Content-Type', 'image/png')
    .setHeader('Cache-Control', 'public, max-age=3600')
    .send(png);
});

function getLpOgData(slug) {
  const s = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
  const map = {
    lp: {
      rating: 72,
      shortVerdict: 'Проверь переписку на красные флаги',
      teaser: 'Гайды: газлайтинг, манипуляции, контроль, игнор и границы.',
    },
    'red-flags': {
      rating: 86,
      shortVerdict: 'Красные флаги в отношениях',
      teaser: 'Чеклист по переписке и быстрый анализ риска.',
    },
    gaslighting: {
      rating: 86,
      shortVerdict: 'Газлайтинг в переписке',
      teaser: 'Примеры фраз и признаки: «тебе показалось», «ты придумал(а)».',
    },
    manipulation: {
      rating: 86,
      shortVerdict: 'Манипуляции в переписке',
      teaser: 'Ультиматумы, давление, игнор как наказание и шантаж.',
    },
    control: {
      rating: 78,
      shortVerdict: 'Контроль и ревность',
      teaser: 'Проверки, запреты и требования отчёта — где начинается токсичность.',
    },
    'silent-treatment': {
      rating: 78,
      shortVerdict: 'Игнор как наказание',
      teaser: 'Когда молчание используют как давление — это красный флаг.',
    },
    boundaries: {
      rating: 64,
      shortVerdict: 'Границы в переписке',
      teaser: 'Короткие формулировки, чтобы остановить давление без оправданий.',
    },
    'toxic-relationship': {
      rating: 86,
      shortVerdict: 'Токсичные отношения',
      teaser: 'Обесценивание, контроль, шантаж: признаки в сообщениях.',
    },
    'abuser-check': {
      rating: 86,
      shortVerdict: 'Абьюзер ли он(а)?',
      teaser: 'Маркеры риска в переписке и почему «случайность» становится системой.',
    },
  };

  return map[s] ?? null;
}

app.get('/api/og/lp/:slug.svg', async (req, res) => {
  const data = getLpOgData(req.params?.slug);
  if (!data) {
    res.status(404).type('text/plain; charset=utf-8').send('Not found');
    return;
  }

  const svg = renderOgSvg(data);
  res
    .status(200)
    .setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
    .setHeader('Cache-Control', 'public, max-age=3600')
    .send(svg);
});

app.get('/api/og/lp/:slug.png', async (req, res) => {
  const data = getLpOgData(req.params?.slug);
  if (!data) {
    res.status(404).type('text/plain; charset=utf-8').send('Not found');
    return;
  }

  const svg = renderOgSvg(data);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
  const png = resvg.render().asPng();

  res
    .status(200)
    .setHeader('Content-Type', 'image/png')
    .setHeader('Cache-Control', 'public, max-age=3600')
    .send(png);
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

function registerPdfFonts(doc) {
  const envRegular = typeof process.env.PDF_FONT_REGULAR === 'string' ? process.env.PDF_FONT_REGULAR.trim() : '';
  const envBold = typeof process.env.PDF_FONT_BOLD === 'string' ? process.env.PDF_FONT_BOLD.trim() : '';

  function firstExisting(paths) {
    for (const p of paths) {
      if (typeof p !== 'string') continue;
      const s = p.trim();
      if (!s) continue;
      if (fs.existsSync(s)) return s;
    }
    return '';
  }

  function fcMatchFile(pattern) {
    try {
      const out = execSync(`fc-match -f "%{file}" "${pattern}"`, { encoding: 'utf8' });
      const file = String(out || '').trim();
      if (file && fs.existsSync(file)) return file;
    } catch {
      return '';
    }
    return '';
  }

  const regularPath =
    firstExisting([
      envRegular,
      '/usr/share/fonts/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',
    ]) || fcMatchFile('DejaVu Sans');
  const boldPath =
    firstExisting([
      envBold,
      '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf',
    ]) || fcMatchFile('DejaVu Sans:style=Bold');

  const hasRegular = Boolean(regularPath);
  const hasBold = Boolean(boldPath);

  if (hasRegular) doc.registerFont('ui', regularPath);
  if (hasBold) doc.registerFont('ui-bold', boldPath);

  return {
    regular: hasRegular ? 'ui' : 'Helvetica',
    bold: hasBold ? 'ui-bold' : 'Helvetica-Bold',
  };
}

function splitTextToSvgLines(text, maxCharsPerLine) {
  const raw = typeof text === 'string' ? text : '';
  const normalized = raw.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const paragraphs = normalized.split('\n');
  const out = [];

  for (const p of paragraphs) {
    const words = p.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const w of words) {
      if (!line) {
        line = w;
        continue;
      }
      if (line.length + 1 + w.length <= maxCharsPerLine) {
        line = `${line} ${w}`;
        continue;
      }
      out.push(line);
      line = w;
    }
    if (line) out.push(line);
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function clampSvgLines(lines, maxLines) {
  if (!Array.isArray(lines)) return [];
  const limit = Number.isFinite(maxLines) ? Math.max(1, Math.trunc(maxLines)) : 1;
  const cleaned = lines
    .map((x) => String(x || '').trim())
    .filter((x) => x.length > 0);
  if (cleaned.length <= limit) return cleaned;
  const out = cleaned.slice(0, limit);
  const last = out[out.length - 1] || '';
  const trimmed = last.length > 1 ? last.replace(/[.\s]+$/g, '').trim() : last;
  out[out.length - 1] = `${trimmed}…`;
  return out;
}

function renderSvgMultilineText({ x, y, lines, lineHeight, attrs }) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const lh = Number.isFinite(lineHeight) ? Math.max(1, Number(lineHeight)) : 20;
  const a = typeof attrs === 'string' ? attrs : '';
  if (safeLines.length === 0) return '';

  const tspan = [];
  for (let i = 0; i < safeLines.length; i += 1) {
    const dy = i === 0 ? 0 : lh;
    tspan.push(`<tspan x="${x}" dy="${dy}">${escapeXml(safeLines[i])}</tspan>`);
  }
  return `<text x="${x}" y="${y}" dominant-baseline="hanging" ${a}>${tspan.join('')}</text>`;
}

function renderShareCardSvg({ shareUrl, verdict, result }) {
  const width = 1200;
  const height = 630;
  const rating = Number.isFinite(Number(verdict?.rating)) ? Math.max(0, Math.min(100, Math.round(Number(verdict.rating)))) : 50;
  const palette = pickOgPalette(rating);

  const family = 'DejaVu Sans,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial';
  const titleRaw = String(verdict?.short_verdict || '').trim();
  const teaserRaw = String(verdict?.teaser || '').trim();
  const titleLines = clampSvgLines(splitTextToSvgLines(titleRaw, 22), 2);
  const subtitleLines = clampSvgLines(splitTextToSvgLines(teaserRaw, 48), 2);

  const label = escapeXml(palette.label);

  const shareDisplay = (() => {
    const raw = String(shareUrl || '').trim();
    if (!raw) return '';
    let s = '';
    try {
      const u = new URL(raw);
      s = `${u.host}${u.pathname || '/'}`;
    } catch {
      s = raw.replace(/^https?:\/\//i, '');
    }
    s = s.replace(/\/+$/g, '').replace(/\/{2,}/g, '/');
    if (s.length > 42) s = `${s.slice(0, 41).trim()}…`;
    return escapeXml(s);
  })();

  const signalPills = (() => {
    const items = [];
    const flags = typeof result === 'object' && result !== null && Array.isArray(result.flags) ? result.flags : [];
    for (const f of flags) {
      if (typeof f !== 'object' || f === null) continue;
      const category = typeof f.category === 'string' ? f.category.trim() : '';
      const quote = typeof f.quote === 'string' ? f.quote.trim().replace(/\s+/g, ' ') : '';
      if (!category && !quote) continue;

      let text = category;
      if (quote) {
        const q = quote.length > 64 ? `${quote.slice(0, 63).trim()}…` : quote;
        text = category ? `${category}: «${q}»` : `«${q}»`;
      }

      text = text.replace(/\u0000/g, '').trim();
      if (text.length > 72) text = `${text.slice(0, 71).trim()}…`;
      if (!text) continue;
      if (items.includes(text)) continue;
      items.push(text);
      if (items.length >= 3) break;
    }
    if (items.length === 0) items.push('Сигналов не найдено');
    return items.map((x) => escapeXml(x));
  })();

  const cardX = 70;
  const cardY = 110;
  const cardW = 1060;
  const cardH = 440;
  const leftX = cardX + 54;
  const rightX = cardX + 420;
  const rightW = cardX + cardW - rightX - 54;

  const chipX = rightX;
  const chipW = rightW;
  const chipH = 52;
  const chipGap = 12;

  const titleY = cardY + 106;
  const subtitleY = titleY + titleLines.length * 54 + 14;
  const signalsTitleY = subtitleY + subtitleLines.length * 30 + 18;
  const chipsY = signalsTitleY + 26;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#020617" />
      <stop offset="0.55" stop-color="#0b1226" />
      <stop offset="1" stop-color="#020617" />
    </linearGradient>
    <radialGradient id="g1" cx="24%" cy="18%" r="70%">
      <stop offset="0" stop-color="${palette.accent}" stop-opacity="0.42" />
      <stop offset="1" stop-color="${palette.accent}" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="g2" cx="84%" cy="28%" r="70%">
      <stop offset="0" stop-color="${palette.accent2}" stop-opacity="0.34" />
      <stop offset="1" stop-color="${palette.accent2}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${palette.accent}" />
      <stop offset="1" stop-color="${palette.accent2}" />
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1226" stop-opacity="0.78" />
      <stop offset="1" stop-color="#0b1226" stop-opacity="0.40" />
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000000" flood-opacity="0.55" />
    </filter>
    <clipPath id="clipCard">
      <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="34" />
    </clipPath>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#bg)" />
  <rect width="${width}" height="${height}" fill="url(#g1)" />
  <rect width="${width}" height="${height}" fill="url(#g2)" />

  <g font-family="${family}">
    <g transform="translate(70 62)">
      <text x="0" y="0" fill="#e2e8f0" font-size="22" font-weight="950" letter-spacing="6">REDFLAG SCANNER</text>
      ${shareDisplay ? `<text x="0" y="28" fill="#94a3b8" font-size="13" font-weight="700">${shareDisplay}</text>` : ''}
    </g>

    <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="34" fill="url(#glass)" stroke="#ffffff" stroke-opacity="0.10" filter="url(#shadow)" />
    <g>
      <rect x="${cardX}" y="${cardY}" width="${cardW}" height="7" rx="3.5" fill="url(#accent)" />
    </g>

    <g clip-path="url(#clipCard)">
      <g transform="translate(${leftX} ${cardY + 44})">
        <rect x="0" y="0" width="260" height="44" rx="22" fill="url(#accent)" fill-opacity="0.16" stroke="url(#accent)" stroke-opacity="0.55" />
        <text x="130" y="22" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-size="13" font-weight="950" letter-spacing="4">${label}</text>

        <g transform="translate(0 74)">
          <circle cx="130" cy="98" r="92" fill="#0b1226" fill-opacity="0.40" stroke="url(#accent)" stroke-opacity="0.85" stroke-width="6" />
          <circle cx="130" cy="98" r="74" fill="#0b1226" fill-opacity="0.55" />
          <text x="130" y="88" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-size="78" font-weight="950">${rating}</text>
          <text x="130" y="134" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14" font-weight="900" letter-spacing="3">ИЗ 100</text>
          <text x="130" y="158" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="12" font-weight="900" letter-spacing="4">РЕЙТИНГ</text>
        </g>
      </g>

      <g transform="translate(${rightX} ${titleY})">
        ${renderSvgMultilineText({
          x: 0,
          y: 0,
          lines: titleLines,
          lineHeight: 54,
          attrs: 'fill="#ffffff" font-size="52" font-weight="950"',
        })}
      </g>

      <g transform="translate(${rightX} ${subtitleY})">
        ${renderSvgMultilineText({
          x: 0,
          y: 0,
          lines: subtitleLines,
          lineHeight: 30,
          attrs: 'fill="#cbd5e1" font-size="22" font-weight="650"',
        })}
      </g>

      <g transform="translate(${rightX} ${signalsTitleY})">
        <text x="0" y="0" fill="#94a3b8" font-size="13" font-weight="950" letter-spacing="6">КЛЮЧЕВЫЕ СИГНАЛЫ</text>
      </g>

      <g>
        ${signalPills
          .slice(0, 3)
          .map((t, idx) => {
            const y = chipsY + idx * (chipH + chipGap);
            const textLines = clampSvgLines(splitTextToSvgLines(t, 60), 1);
            const labelText = textLines[0] ? escapeXml(textLines[0]) : '';
            return `
        <g transform="translate(${chipX} ${y})">
          <rect x="0" y="0" width="${chipW}" height="${chipH}" rx="18" fill="#ffffff" fill-opacity="0.06" stroke="#ffffff" stroke-opacity="0.10" />
          <rect x="0" y="0" width="${chipW}" height="${chipH}" rx="18" fill="none" stroke="url(#accent)" stroke-opacity="0.18" />
          <circle cx="22" cy="${chipH / 2}" r="6" fill="url(#accent)" />
          <text x="40" y="${chipH / 2}" dominant-baseline="middle" fill="#e2e8f0" font-size="18" font-weight="700">${labelText}</text>
        </g>`;
          })
          .join('')}
      </g>
    </g>

    <g transform="translate(70 602)">
      <text x="0" y="0" fill="#94a3b8" font-size="14" font-weight="700">Анализ переписки с помощью AI • toxiscan.ru</text>
    </g>
  </g>
</svg>`;
}

function renderReportSvg({ shareUrl, verdict, result }) {
  const width = 1200;
  const rating = Number.isFinite(Number(verdict?.rating)) ? Math.max(0, Math.min(100, Math.round(Number(verdict.rating)))) : 50;
  const palette = pickOgPalette(rating);

  const family = 'DejaVu Sans,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial';
  const shareDisplay = (() => {
    const raw = String(shareUrl || '').trim();
    if (!raw) return '';
    let s = '';
    try {
      const u = new URL(raw);
      s = `${u.host}${u.pathname || '/'}`;
    } catch {
      s = raw.replace(/^https?:\/\//i, '');
    }
    s = s.replace(/\/+$/g, '').replace(/\/{2,}/g, '/');
    if (s.length > 56) s = `${s.slice(0, 55).trim()}…`;
    return escapeXml(s);
  })();

  const safe = typeof result === 'object' && result !== null ? result : {};
  const fullAnalysisRaw = typeof safe.full_analysis === 'string' ? safe.full_analysis : typeof safe.analysis === 'string' ? safe.analysis : '';
  const adviceRaw = typeof safe.advice === 'string' ? safe.advice : '';
  const flagsLinesRaw = extractFlagLines(safe);

  const titleLines = clampSvgLines(splitTextToSvgLines(String(verdict?.short_verdict || '').trim(), 22), 2);
  const subtitleLines = clampSvgLines(splitTextToSvgLines(String(verdict?.teaser || '').trim(), 52), 3);

  function normalizeBodyLines(lines) {
    const out = [];
    let lastBlank = false;
    for (const l of Array.isArray(lines) ? lines : []) {
      const s = String(l ?? '').replace(/\u0000/g, '').trim();
      const isBlank = !s;
      if (isBlank) {
        if (!lastBlank && out.length > 0) out.push('');
        lastBlank = true;
        continue;
      }
      out.push(s);
      lastBlank = false;
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }

  function limitLines(lines, max) {
    const lim = Number.isFinite(max) ? Math.max(1, Math.trunc(max)) : 1;
    const src = Array.isArray(lines) ? lines : [];
    if (src.length <= lim) return src;
    const out = src.slice(0, lim);
    const last = String(out[out.length - 1] || '').trim();
    out[out.length - 1] = last ? `${last.replace(/[.\s]+$/g, '').trim()}…` : '…';
    return out;
  }

  const sectionPad = 26;
  const sectionTitleSize = 20;
  const sectionTitleLine = 26;
  const sectionBodySize = 16;
  const sectionBodyLine = 24;
  const maxBodyLines = 220;

  const fullAnalysisLines = limitLines(
    normalizeBodyLines(splitTextToSvgLines(String(fullAnalysisRaw || '').trim(), 74)),
    maxBodyLines,
  );
  const adviceLines = limitLines(normalizeBodyLines(splitTextToSvgLines(String(adviceRaw || '').trim(), 74)), 80);
  const flagsLines = limitLines(
    normalizeBodyLines(flagsLinesRaw.flatMap((x) => splitTextToSvgLines(`• ${String(x || '').trim()}`, 82))),
    120,
  );

  const cardX = 70;
  const cardW = 1060;

  const heroPad = 54;
  const heroTitleSize = 52;
  const heroTitleLine = 54;
  const heroSubtitleSize = 22;
  const heroSubtitleLine = 30;
  const heroSignalsTitleSize = 13;
  const heroSignalsTitleLine = 18;
  const heroChipH = 52;
  const heroChipGap = 12;

  const heroTitleH = titleLines.length * heroTitleLine;
  const heroSubtitleH = subtitleLines.length * heroSubtitleLine;
  const heroSignalsTitleH = heroSignalsTitleLine;
  const heroChipsH = 3 * heroChipH + 2 * heroChipGap;
  const heroContentH = 44 + 74 + 196;

  const heroRightTop = 44;
  const heroRightH = heroTitleH + 14 + heroSubtitleH + 18 + heroSignalsTitleH + 26 + heroChipsH;
  const heroLeftH = heroContentH;
  const heroInnerH = Math.max(heroLeftH, heroRightH + heroRightTop);
  const heroH = heroPad + heroInnerH + heroPad;

  function measureSection(lines) {
    const textH = (Array.isArray(lines) ? lines.length : 0) * sectionBodyLine;
    return sectionPad + sectionTitleLine + 14 + textH + sectionPad;
  }

  const sectionGap = 26;
  const headerTop = 62;
  const startY = 110;

  const fullH = measureSection(fullAnalysisLines);
  const adviceH = measureSection(adviceLines);
  const flagsH = measureSection(flagsLines);

  const totalH = startY + heroH + sectionGap + fullH + sectionGap + adviceH + sectionGap + flagsH + 78;

  const label = escapeXml(palette.label);

  const signalPills = (() => {
    const items = [];
    const flags = typeof result === 'object' && result !== null && Array.isArray(result.flags) ? result.flags : [];
    for (const f of flags) {
      if (typeof f !== 'object' || f === null) continue;
      const category = typeof f.category === 'string' ? f.category.trim() : '';
      const quote = typeof f.quote === 'string' ? f.quote.trim().replace(/\s+/g, ' ') : '';
      if (!category && !quote) continue;

      let text = category;
      if (quote) {
        const q = quote.length > 64 ? `${quote.slice(0, 63).trim()}…` : quote;
        text = category ? `${category}: «${q}»` : `«${q}»`;
      }

      text = text.replace(/\u0000/g, '').trim();
      if (text.length > 72) text = `${text.slice(0, 71).trim()}…`;
      if (!text) continue;
      if (items.includes(text)) continue;
      items.push(text);
      if (items.length >= 3) break;
    }
    if (items.length === 0) items.push('Сигналов не найдено');
    return items.map((x) => escapeXml(x));
  })();

  const heroCardY = startY;
  const heroCardH = heroH;
  const leftX = cardX + heroPad;
  const rightX = cardX + 420;
  const rightW = cardX + cardW - rightX - heroPad;

  const titleY = heroCardY + heroPad + heroRightTop;
  const subtitleY = titleY + heroTitleH + 14;
  const signalsTitleY = subtitleY + heroSubtitleH + 18;
  const chipsY = signalsTitleY + 26;

  function renderSectionCard({ y, title, lines }) {
    const cardH = measureSection(lines);
    const bandH = 7;
    const titleY = y + sectionPad;
    const bodyY = titleY + sectionTitleLine + 14;
    return {
      h: cardH,
      svg: `
    <g>
      <rect x="${cardX}" y="${y}" width="${cardW}" height="${cardH}" rx="28" fill="#ffffff" fill-opacity="0.96" stroke="#0f172a" stroke-opacity="0.08" filter="url(#shadow)" />
      <rect x="${cardX}" y="${y}" width="${cardW}" height="${bandH}" rx="${bandH / 2}" fill="url(#accent)" />
      <text x="${cardX + sectionPad}" y="${titleY}" dominant-baseline="hanging" fill="#0f172a" font-size="${sectionTitleSize}" font-weight="950" letter-spacing="0.5">${escapeXml(title)}</text>
      ${renderSvgMultilineText({
        x: cardX + sectionPad,
        y: bodyY,
        lines,
        lineHeight: sectionBodyLine,
        attrs: `fill="#0f172a" font-size="${sectionBodySize}" font-weight="600"`,
      })}
    </g>`,
    };
  }

  const fullCard = renderSectionCard({ y: heroCardY + heroCardH + sectionGap, title: 'Полный разбор', lines: fullAnalysisLines });
  const adviceCard = renderSectionCard({
    y: heroCardY + heroCardH + sectionGap + fullCard.h + sectionGap,
    title: 'Совет',
    lines: adviceLines,
  });
  const flagsCard = renderSectionCard({
    y: heroCardY + heroCardH + sectionGap + fullCard.h + sectionGap + adviceCard.h + sectionGap,
    title: 'Красные флаги',
    lines: flagsLines,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalH}" viewBox="0 0 ${width} ${totalH}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#020617" />
      <stop offset="0.55" stop-color="#0b1226" />
      <stop offset="1" stop-color="#020617" />
    </linearGradient>
    <radialGradient id="g1" cx="24%" cy="12%" r="70%">
      <stop offset="0" stop-color="${palette.accent}" stop-opacity="0.42" />
      <stop offset="1" stop-color="${palette.accent}" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="g2" cx="84%" cy="16%" r="70%">
      <stop offset="0" stop-color="${palette.accent2}" stop-opacity="0.34" />
      <stop offset="1" stop-color="${palette.accent2}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${palette.accent}" />
      <stop offset="1" stop-color="${palette.accent2}" />
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1226" stop-opacity="0.78" />
      <stop offset="1" stop-color="#0b1226" stop-opacity="0.40" />
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000000" flood-opacity="0.40" />
    </filter>
    <clipPath id="clipHero">
      <rect x="${cardX}" y="${heroCardY}" width="${cardW}" height="${heroCardH}" rx="34" />
    </clipPath>
  </defs>

  <rect width="${width}" height="${totalH}" fill="url(#bg)" />
  <rect width="${width}" height="${totalH}" fill="url(#g1)" />
  <rect width="${width}" height="${totalH}" fill="url(#g2)" />

  <g font-family="${family}">
    <g transform="translate(70 ${headerTop})">
      <text x="0" y="0" fill="#e2e8f0" font-size="22" font-weight="950" letter-spacing="6">REDFLAG SCANNER</text>
      ${shareDisplay ? `<text x="0" y="28" fill="#94a3b8" font-size="13" font-weight="700">${shareDisplay}</text>` : ''}
    </g>

    <rect x="${cardX}" y="${heroCardY}" width="${cardW}" height="${heroCardH}" rx="34" fill="url(#glass)" stroke="#ffffff" stroke-opacity="0.10" filter="url(#shadow)" />
    <rect x="${cardX}" y="${heroCardY}" width="${cardW}" height="7" rx="3.5" fill="url(#accent)" />

    <g clip-path="url(#clipHero)">
      <g transform="translate(${leftX} ${heroCardY + heroPad})">
        <rect x="0" y="0" width="260" height="44" rx="22" fill="url(#accent)" fill-opacity="0.16" stroke="url(#accent)" stroke-opacity="0.40" />
        <text x="130" y="22" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-size="13" font-weight="950" letter-spacing="4">${label}</text>

        <g transform="translate(0 74)">
          <circle cx="130" cy="98" r="92" fill="#0b1226" fill-opacity="0.40" stroke="url(#accent)" stroke-opacity="0.85" stroke-width="6" />
          <circle cx="130" cy="98" r="74" fill="#0b1226" fill-opacity="0.55" />
          <text x="130" y="88" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-size="78" font-weight="950">${rating}</text>
          <text x="130" y="134" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="14" font-weight="900" letter-spacing="3">ИЗ 100</text>
          <text x="130" y="158" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="12" font-weight="900" letter-spacing="4">РЕЙТИНГ</text>
        </g>
      </g>

      <g transform="translate(${rightX} ${titleY})">
        ${renderSvgMultilineText({
          x: 0,
          y: 0,
          lines: titleLines,
          lineHeight: heroTitleLine,
          attrs: `fill="#ffffff" font-size="${heroTitleSize}" font-weight="950"`,
        })}
      </g>

      <g transform="translate(${rightX} ${subtitleY})">
        ${renderSvgMultilineText({
          x: 0,
          y: 0,
          lines: subtitleLines,
          lineHeight: heroSubtitleLine,
          attrs: `fill="#cbd5e1" font-size="${heroSubtitleSize}" font-weight="650"`,
        })}
      </g>

      <g transform="translate(${rightX} ${signalsTitleY})">
        <text x="0" y="0" fill="#94a3b8" font-size="${heroSignalsTitleSize}" font-weight="950" letter-spacing="6">КЛЮЧЕВЫЕ СИГНАЛЫ</text>
      </g>

      <g>
        ${signalPills
          .slice(0, 3)
          .map((t, idx) => {
            const y = chipsY + idx * (heroChipH + heroChipGap);
            const textLines = clampSvgLines(splitTextToSvgLines(t, 60), 1);
            const labelText = textLines[0] ? escapeXml(textLines[0]) : '';
            return `
        <g transform="translate(${rightX} ${y})">
          <rect x="0" y="0" width="${rightW}" height="${heroChipH}" rx="18" fill="#ffffff" fill-opacity="0.06" stroke="#ffffff" stroke-opacity="0.10" />
          <rect x="0" y="0" width="${rightW}" height="${heroChipH}" rx="18" fill="none" stroke="url(#accent)" stroke-opacity="0.18" />
          <circle cx="22" cy="${heroChipH / 2}" r="6" fill="url(#accent)" />
          <text x="40" y="${heroChipH / 2}" dominant-baseline="middle" fill="#e2e8f0" font-size="18" font-weight="700">${labelText}</text>
        </g>`;
          })
          .join('')}
      </g>
    </g>

    ${fullCard.svg}
    ${adviceCard.svg}
    ${flagsCard.svg}

    <g transform="translate(70 ${totalH - 38})">
      <text x="0" y="0" fill="#94a3b8" font-size="14" font-weight="700">Анализ переписки с помощью AI • toxiscan.ru</text>
    </g>
  </g>
</svg>`;
}

function writePdfSection(doc, title, body, fonts) {
  const t = sanitizePdfLine(title);
  const b = sanitizePdfLine(body);
  if (!t || !b) return;
  doc.fontSize(13).font(fonts.bold).text(t);
  doc.moveDown(0.35);
  doc.fontSize(11).font(fonts.regular).text(b, { lineGap: 2 });
  doc.moveDown(0.9);
}

function writePdfList(doc, title, items, fonts) {
  const t = sanitizePdfLine(title);
  if (!t || !Array.isArray(items) || items.length === 0) return;
  doc.fontSize(13).font(fonts.bold).text(t);
  doc.moveDown(0.35);
  doc.fontSize(11).font(fonts.regular);
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

function parseHexColor(hex) {
  const raw = typeof hex === 'string' ? hex.trim() : '';
  if (!/^#?[0-9a-fA-F]{6}$/.test(raw)) return null;
  const clean = raw.startsWith('#') ? raw.slice(1) : raw;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b };
}

function mixHex(a, b, t) {
  const ca = parseHexColor(a);
  const cb = parseHexColor(b);
  if (!ca || !cb) return '#000000';
  const k = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const r = Math.round(ca.r + (cb.r - ca.r) * k);
  const g = Math.round(ca.g + (cb.g - ca.g) * k);
  const bl = Math.round(ca.b + (cb.b - ca.b) * k);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

function drawVerticalGradient(doc, x, y, w, h, top, bottom, steps) {
  const s = Number.isFinite(steps) ? Math.max(8, Math.min(240, Math.trunc(steps))) : 80;
  const band = h / s;
  for (let i = 0; i < s; i += 1) {
    const t = s === 1 ? 0 : i / (s - 1);
    const c = mixHex(top, bottom, t);
    doc.rect(x, y + i * band, w, band + 0.6).fill(c);
  }
}

function drawHorizontalGradient(doc, x, y, w, h, left, right, steps) {
  const s = Number.isFinite(steps) ? Math.max(8, Math.min(240, Math.trunc(steps))) : 120;
  const band = w / s;
  for (let i = 0; i < s; i += 1) {
    const t = s === 1 ? 0 : i / (s - 1);
    const c = mixHex(left, right, t);
    doc.rect(x + i * band, y, band + 0.6, h).fill(c);
  }
}

function drawPdfCover({ doc, fonts, verdict, shareUrl, safeResult }) {
  const rating = Number.isFinite(Number(verdict?.rating)) ? Math.max(0, Math.min(100, Math.round(Number(verdict.rating)))) : 50;
  const palette = pickOgPalette(rating);
  const w = doc.page.width;
  const h = doc.page.height;
  const margin = doc.page.margins.left;
  const innerW = w - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  drawVerticalGradient(doc, 0, 0, w, h, '#020617', '#0b1226', 140);
  doc.restore();

  doc.save();
  doc.fillOpacity(0.22).fill(palette.accent).circle(w * 0.28, h * 0.18, 220).fill();
  doc.fillOpacity(0.18).fill(palette.accent2).circle(w * 0.78, h * 0.22, 250).fill();
  doc.fillOpacity(0.10).fill(palette.accent).circle(w * 0.62, h * 0.78, 280).fill();
  doc.restore();

  doc.fillColor('#e2e8f0').font(fonts.bold).fontSize(22);
  doc.text('REDFLAG SCANNER', margin, 76, { width: innerW, characterSpacing: 4 });

  const label = palette.label;
  const labelW = Math.min(260, Math.max(160, doc.widthOfString(label, { font: fonts.bold, size: 12 }) + 46));
  const labelX = margin;
  const labelY = 128;
  doc.save();
  doc.fillOpacity(0.18).fill(palette.accent).roundedRect(labelX, labelY, labelW, 42, 21).fill();
  doc.fillOpacity(0.45).stroke(palette.accent2).lineWidth(1.2).roundedRect(labelX, labelY, labelW, 42, 21).stroke();
  doc.restore();
  doc.fillColor('#ffffff').font(fonts.bold).fontSize(12);
  doc.text(label, labelX, labelY + 14, { width: labelW, align: 'center', characterSpacing: 3 });

  doc.fillColor('#ffffff').font(fonts.bold).fontSize(92);
  doc.text(String(rating), margin, 208, { width: innerW, align: 'left' });
  doc.fillColor('#94a3b8').font(fonts.bold).fontSize(24);
  doc.text('/ 100', margin + 165, 216, { width: 140, align: 'left', characterSpacing: 2 });
  doc.fillColor('#94a3b8').font(fonts.bold).fontSize(14);
  doc.text('РЕЙТИНГ', margin, 300, { width: 240, align: 'left', characterSpacing: 4 });

  doc.fillColor('#ffffff').font(fonts.bold).fontSize(36);
  doc.text(String(verdict?.short_verdict || '').trim(), margin, 338, { width: innerW, lineGap: 2 });
  doc.moveDown(0.6);
  doc.fillColor('#cbd5e1').font(fonts.regular).fontSize(16);
  doc.text(String(verdict?.teaser || '').trim(), { width: innerW, lineGap: 3 });

  const topFlags = extractFlagLines(safeResult).slice(0, 3);
  if (Array.isArray(topFlags) && topFlags.length > 0) {
    doc.moveDown(1.2);
    doc.fillColor('#94a3b8').font(fonts.bold).fontSize(12);
    doc.text('ТОП СИГНАЛЫ', margin, doc.y, { width: innerW, characterSpacing: 4 });
    doc.moveDown(0.6);
    doc.fillColor('#e2e8f0').font(fonts.regular).fontSize(12);
    for (const line of topFlags) {
      const t = String(line || '').trim();
      if (!t) continue;
      doc.text(`• ${t}`, { width: innerW, lineGap: 2 });
    }
  }

  doc.fillColor('#94a3b8').font(fonts.regular).fontSize(10);
  doc.text(String(shareUrl || ''), margin, h - 72, { width: innerW });

  doc.addPage();
  return { palette, rating };
}

function ensureSpace(doc, neededHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  const y = doc.y;
  if (y + neededHeight <= bottom) return;
  doc.addPage();
}

function writePdfBoxSection(doc, title, body, fonts, palette) {
  const t = sanitizePdfLine(title);
  const b = sanitizePdfLine(body);
  if (!t || !b) return;

  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pad = 16;
  const innerW = w - pad * 2;

  doc.font(fonts.bold).fontSize(13);
  const titleH = doc.heightOfString(t, { width: innerW });
  doc.font(fonts.regular).fontSize(11);
  const bodyH = doc.heightOfString(b, { width: innerW, lineGap: 2 });
  const total = pad + titleH + 10 + bodyH + pad;
  ensureSpace(doc, total + 14);

  const y = doc.y;
  const bandH = 7;
  doc.save();
  doc.fillColor('#ffffff').roundedRect(x, y, w, total, 16).fill();
  doc.strokeColor(palette.accent2).opacity(0.20).lineWidth(1).roundedRect(x, y, w, total, 16).stroke();
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.roundedRect(x, y, w, bandH, Math.floor(bandH / 2)).clip();
  drawHorizontalGradient(doc, x, y, w, bandH, palette.accent, palette.accent2, 120);
  doc.restore();

  doc.fillColor('#0f172a').font(fonts.bold).fontSize(13);
  doc.text(t, x + pad, y + pad, { width: innerW });
  doc.fillColor('#0f172a').font(fonts.regular).fontSize(11);
  doc.text(b, x + pad, y + pad + titleH + 10, { width: innerW, lineGap: 2 });
  doc.y = y + total + 14;
}

function writePdfBoxList(doc, title, items, fonts, palette) {
  const t = sanitizePdfLine(title);
  if (!t || !Array.isArray(items) || items.length === 0) return;

  const lines = items.map((x) => sanitizePdfLine(x)).filter(Boolean);
  if (lines.length === 0) return;

  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pad = 16;
  const innerW = w - pad * 2;

  doc.font(fonts.bold).fontSize(13);
  const titleH = doc.heightOfString(t, { width: innerW });
  doc.font(fonts.regular).fontSize(11);
  let listH = 0;
  for (const line of lines) {
    listH += doc.heightOfString(`• ${line}`, { width: innerW, lineGap: 2 });
  }
  const total = pad + titleH + 10 + listH + pad;
  ensureSpace(doc, total + 14);

  const y = doc.y;
  const bandH = 7;
  doc.save();
  doc.fillColor('#ffffff').roundedRect(x, y, w, total, 16).fill();
  doc.strokeColor(palette.accent2).opacity(0.20).lineWidth(1).roundedRect(x, y, w, total, 16).stroke();
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.roundedRect(x, y, w, bandH, Math.floor(bandH / 2)).clip();
  drawHorizontalGradient(doc, x, y, w, bandH, palette.accent, palette.accent2, 120);
  doc.restore();

  doc.fillColor('#0f172a').font(fonts.bold).fontSize(13);
  doc.text(t, x + pad, y + pad, { width: innerW });
  doc.fillColor('#0f172a').font(fonts.regular).fontSize(11);
  let yy = y + pad + titleH + 10;
  for (const line of lines) {
    doc.text(`• ${line}`, x + pad, yy, { width: innerW, lineGap: 2 });
    yy = doc.y;
  }
  doc.y = y + total + 14;
}

function startPdfContentPage(doc, fonts, palette, shareUrl) {
  const w = doc.page.width;
  const h = doc.page.height;
  const headerH = 66;

  doc.save();
  drawVerticalGradient(doc, 0, 0, w, headerH, palette.accent, palette.accent2, 60);
  doc.restore();

  doc.fillColor('#ffffff').font(fonts.bold).fontSize(16);
  doc.text('RedFlag Scanner — отчёт', doc.page.margins.left, 26, { width: w - doc.page.margins.left - doc.page.margins.right });
  doc.fillColor('#ffffff').font(fonts.regular).fontSize(10);
  doc.text(String(shareUrl || ''), doc.page.margins.left, 46, { width: w - doc.page.margins.left - doc.page.margins.right });

  doc.y = headerH + 18;

  doc.save();
  doc.rect(0, headerH, w, h - headerH).fill('#f8fafc');
  doc.restore();
}

app.get('/api/scan/public/:token.png', async (req, res, next) => {
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

    if (scan.isPaid !== true) {
      const err = new Error('Экспорт доступен только после оплаты');
      err.statusCode = 402;
      throw err;
    }

    const verdict = normalizeVerdict(scan.result);
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/r/${encodeURIComponent(scan.shareId)}`;
    const mode = typeof req.query?.mode === 'string' ? req.query.mode.trim().toLowerCase() : '';
    const full = mode === 'full' || mode === 'report' || (typeof req.query?.full === 'string' && req.query.full.trim() === '1');
    const svg = full
      ? renderReportSvg({ shareUrl, verdict, result: scan.result })
      : renderShareCardSvg({ shareUrl, verdict, result: scan.result });
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
    const png = resvg.render().asPng();

    res
      .status(200)
      .setHeader('Content-Type', 'image/png')
      .setHeader('Content-Disposition', `attachment; filename="${full ? 'redflag-report' : 'redflag-card'}-${scan.shareId}.png"`)
      .setHeader('Cache-Control', 'no-store')
      .send(png);
  } catch (err) {
    next(err);
  }
});

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

    if (scan.isPaid !== true) {
      const err = new Error('Экспорт доступен только после оплаты');
      err.statusCode = 402;
      throw err;
    }

    const safeResult = scan.result;
    const verdict = normalizeVerdict(safeResult);
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/r/${encodeURIComponent(scan.shareId)}`;

    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="redflag-scan-${scan.shareId}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');

    const doc = new PDFDocument({ size: 'A4', margin: 54, info: { Title: 'RedFlag Scanner — отчёт' } });
    doc.pipe(res);
    const fonts = registerPdfFonts(doc);

    const done = new Promise((resolve, reject) => {
      doc.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
    });

    const { palette } = drawPdfCover({ doc, fonts, verdict, shareUrl, safeResult });
    startPdfContentPage(doc, fonts, palette, shareUrl);
    writePdfBoxSection(doc, 'Рейтинг', `Рейтинг: ${verdict.rating} / 100\n${verdict.short_verdict}\n\n${verdict.teaser}`, fonts, palette);
    writePdfBoxSection(doc, 'Полный разбор', safeResult?.full_analysis, fonts, palette);
    writePdfBoxSection(doc, 'Совет', safeResult?.advice, fonts, palette);
    writePdfBoxList(doc, 'Красные флаги', extractFlagLines(safeResult), fonts, palette);

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

    const textForAi = anonymizeText(normalizeTranscriptForAi(text), anonymization);
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

    const textForAi = anonymizeText(normalizeTranscriptForAi(text), anonymization);
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
    const fonts = registerPdfFonts(doc);

    const done = new Promise((resolve, reject) => {
      doc.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
    });

    doc.font(fonts.bold).fontSize(18).text('RedFlag Scanner');
    doc.moveDown(0.4);
    doc.font(fonts.regular).fontSize(11).text(`Ссылка: ${shareUrl}`);
    doc.moveDown(1.0);

    doc.font(fonts.bold).fontSize(14).text(`Рейтинг: ${verdict.rating} / 100`);
    doc.moveDown(0.4);
    doc.font(fonts.bold).fontSize(16).text(verdict.short_verdict);
    doc.moveDown(0.5);
    doc.font(fonts.regular).fontSize(11).text(verdict.teaser, { lineGap: 2 });
    doc.moveDown(1.0);

    writePdfSection(doc, 'Полный разбор', safeResult?.full_analysis, fonts);
    writePdfSection(doc, 'Совет', safeResult?.advice, fonts);
    writePdfList(doc, 'Красные флаги', extractFlagLines(safeResult), fonts);

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
  const emailRaw = typeof req.body?.email === 'string' ? req.body.email : '';
  const email = emailRaw ? normalizeEmail(emailRaw) : '';

  const emailFromAuth = typeof req.auth?.email === 'string' ? normalizeEmail(req.auth.email) : '';
  const effectiveEmail = email || emailFromAuth;

    if (!scanId && !analysisId) {
      const err = new Error('Нужно передать scanId или analysisId');
      err.statusCode = 400;
      throw err;
    }

  if (emailRaw && !email) {
    const err = new Error('Некорректный email');
    err.statusCode = 400;
    throw err;
  }

  const prisma = getPrismaClient();
  let scanForPay = null;

  if (email) {
    try {
      await prisma.user.update({
        where: { id: req.auth.userId },
        data: { email },
      });
    } catch (e) {
      const msg = String(e?.message ?? '');
      if (msg.includes('Unique constraint') || msg.includes('users_email_key') || msg.includes('email')) {
        const err = new Error('Этот email уже используется');
        err.statusCode = 409;
        throw err;
      }
      throw e;
    }
  }

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
  const now = new Date();
  const description = 'Оплата полного разбора';
  const returnUrl = buildPaymentReturnUrl({
    scanId,
    analysisId,
    shareId: scanForPay?.shareId ? String(scanForPay.shareId) : undefined,
  });

  const provider = getPaymentProvider();

  if (provider === 'robokassa') {
    if (!effectiveEmail) {
      const err = new Error('Нужен email для отправки чека');
      err.statusCode = 428;
      throw err;
    }
    let invId = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = crypto.randomInt(1, 2147483647);
      const paymentId = `robokassa:${candidate}`;
      try {
        await prisma.paymentWebhookEvent.create({
          data: {
            paymentId,
            event: 'payment.created',
            payload: {
              provider: 'robokassa',
              invId: candidate,
              outSum: FULL_ANALYSIS_PRICE_RUB,
              scanId: scanId || null,
              analysisId: analysisId || null,
              userId: req.auth.userId,
              email: effectiveEmail || null,
              returnUrl,
            },
            lastTriedAt: now,
            attempts: 0,
          },
        });
        invId = candidate;
        break;
      } catch {
        continue;
      }
    }

    if (!invId) {
      const err = new Error('Не удалось создать счёт для оплаты');
      err.statusCode = 502;
      throw err;
    }

    res.json({ confirmation_url: `/api/payment/robokassa/pay/${invId}` });
    return;
  }

  const yk = await yookassaCreatePayment({
    amountValue: FULL_ANALYSIS_PRICE_RUB,
    description,
    returnUrl,
    metadata: {
      scanId: scanId || null,
      analysisId: analysisId || null,
      shareId: scanForPay?.shareId ? String(scanForPay.shareId) : null,
      userId: String(req.auth.userId),
    },
  });

  const paymentId = `yookassa:${yk.paymentId}`;
  await prisma.paymentWebhookEvent.upsert({
    where: { paymentId },
    create: {
      paymentId,
      event: 'payment.created',
      payload: {
        provider: 'yookassa',
        yookassaPaymentId: yk.paymentId,
        outSum: FULL_ANALYSIS_PRICE_RUB,
        scanId: scanId || null,
        analysisId: analysisId || null,
        userId: req.auth.userId,
        returnUrl,
      },
      lastTriedAt: now,
      attempts: 0,
    },
    update: {
      event: 'payment.created',
      payload: {
        provider: 'yookassa',
        yookassaPaymentId: yk.paymentId,
        outSum: FULL_ANALYSIS_PRICE_RUB,
        scanId: scanId || null,
        analysisId: analysisId || null,
        userId: req.auth.userId,
        returnUrl,
      },
      lastTriedAt: now,
    },
  });

  res.json({ confirmation_url: yk.confirmationUrl });
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

    const emailRaw = typeof req.body?.email === 'string' ? req.body.email : '';
    const email = emailRaw ? normalizeEmail(emailRaw) : '';
    if (emailRaw && !email) {
      const err = new Error('Некорректный email');
      err.statusCode = 400;
      throw err;
    }

    const emailFromAuth = typeof req.auth?.email === 'string' ? normalizeEmail(req.auth.email) : '';
    const effectiveEmail = email || emailFromAuth;

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
    const now = new Date();
    const description = 'Оплата полного разбора';
    const returnUrl = buildPaymentReturnUrl({ analysisId });

    const provider = getPaymentProvider();

    if (provider === 'robokassa') {
      if (email) {
        try {
          await prisma.user.update({
            where: { id: req.auth.userId },
            data: { email },
          });
        } catch (e) {
          const msg = String(e?.message ?? '');
          if (msg.includes('Unique constraint') || msg.includes('users_email_key') || msg.includes('email')) {
            const err = new Error('Этот email уже используется');
            err.statusCode = 409;
            throw err;
          }
          throw e;
        }
      }

      if (!effectiveEmail) {
        const err = new Error('Нужен email для отправки чека');
        err.statusCode = 428;
        throw err;
      }
      let invId = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = crypto.randomInt(1, 2147483647);
        const paymentId = `robokassa:${candidate}`;
        try {
          await prisma.paymentWebhookEvent.create({
            data: {
              paymentId,
              event: 'payment.created',
              payload: {
                provider: 'robokassa',
                invId: candidate,
                outSum: FULL_ANALYSIS_PRICE_RUB,
                analysisId,
                userId: req.auth.userId,
                email: effectiveEmail || null,
                returnUrl,
              },
              lastTriedAt: now,
              attempts: 0,
            },
          });
          invId = candidate;
          break;
        } catch {
          continue;
        }
      }

      if (!invId) {
        const err = new Error('Не удалось создать счёт для оплаты');
        err.statusCode = 502;
        throw err;
      }

      const confirmationUrl = `/api/payment/robokassa/pay/${invId}`;
      res.json({ confirmationUrl, confirmation_url: confirmationUrl });
      return;
    }

    const yk = await yookassaCreatePayment({
      amountValue: FULL_ANALYSIS_PRICE_RUB,
      description,
      returnUrl,
      metadata: {
        analysisId,
        userId: String(req.auth.userId),
      },
    });

    const paymentId = `yookassa:${yk.paymentId}`;
    await prisma.paymentWebhookEvent.upsert({
      where: { paymentId },
      create: {
        paymentId,
        event: 'payment.created',
        payload: {
          provider: 'yookassa',
          yookassaPaymentId: yk.paymentId,
          outSum: FULL_ANALYSIS_PRICE_RUB,
          analysisId,
          userId: req.auth.userId,
          returnUrl,
        },
        lastTriedAt: now,
        attempts: 0,
      },
      update: {
        event: 'payment.created',
        payload: {
          provider: 'yookassa',
          yookassaPaymentId: yk.paymentId,
          outSum: FULL_ANALYSIS_PRICE_RUB,
          analysisId,
          userId: req.auth.userId,
          returnUrl,
        },
        lastTriedAt: now,
      },
    });

    res.json({ confirmationUrl: yk.confirmationUrl, confirmation_url: yk.confirmationUrl });
  })),
);

const yookassaWebhookHandler = async (req, res, next) => {
  try {
    verifyWebhookRequest(req);

    const payload = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const event = typeof payload.event === 'string' ? payload.event : '';
    const obj = typeof payload.object === 'object' && payload.object !== null ? payload.object : {};
    const paymentIdRaw = typeof obj.id === 'string' ? obj.id.trim() : '';

    if (!paymentIdRaw) {
      const err = new Error('Webhook: не удалось определить payment id');
      err.statusCode = 400;
      throw err;
    }

    const status = typeof obj.status === 'string' ? obj.status : '';
    if (event && event !== 'payment.succeeded' && status !== 'succeeded') {
      res.json({ ok: true });
      return;
    }

    const amountValue = typeof obj.amount?.value === 'string' ? obj.amount.value : '';
    const normalizedSum = normalizeYooKassaAmount(amountValue);
    if (!normalizedSum || normalizedSum !== FULL_ANALYSIS_PRICE_RUB) {
      const err = new Error('Webhook: неподходящая сумма');
      err.statusCode = 400;
      throw err;
    }

    const metadata = typeof obj.metadata === 'object' && obj.metadata !== null ? obj.metadata : {};
    const scanId = typeof metadata.scanId === 'string' ? metadata.scanId.trim() : '';
    const analysisId = typeof metadata.analysisId === 'string' ? metadata.analysisId.trim() : '';

    const prisma = getPrismaClient();
    const now = new Date();
    const paymentId = `yookassa:${paymentIdRaw}`;
    const webhook = await prisma.paymentWebhookEvent.upsert({
      where: { paymentId },
      create: {
        paymentId,
        event: 'payment.succeeded',
        payload,
        lastTriedAt: now,
        attempts: 1,
      },
      update: {
        event: 'payment.succeeded',
        payload,
        lastTriedAt: now,
        attempts: { increment: 1 },
      },
    });

    if (webhook?.processedAt) {
      res.json({ ok: true });
      return;
    }

    if (!scanId && !analysisId) {
      await prisma.paymentWebhookEvent.update({
        where: { paymentId },
        data: { processedAt: new Date(), lastError: 'missing_metadata' },
      });
      res.json({ ok: true });
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

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

const robokassaResultHandler = async (req, res, next) => {
  try {
    verifyWebhookRequestOptionalToken(req);

    const payload = {
      ...(typeof req.query === 'object' && req.query !== null ? req.query : {}),
      ...(typeof req.body === 'object' && req.body !== null ? req.body : {}),
    };

    const outSum = typeof payload.OutSum === 'string' ? payload.OutSum : typeof payload.outSum === 'string' ? payload.outSum : '';
    const invId = typeof payload.InvId === 'string' ? payload.InvId : typeof payload.invId === 'string' ? payload.invId : '';
    const signatureValue = typeof payload.SignatureValue === 'string' ? payload.SignatureValue : '';

    const scanId = typeof payload.Shp_scanId === 'string' ? payload.Shp_scanId.trim() : '';
    const analysisId = typeof payload.Shp_analysisId === 'string' ? payload.Shp_analysisId.trim() : '';

    const invIdNum = /^\d+$/.test(invId) ? Number(invId) : NaN;

    if (!Number.isFinite(invIdNum) || invIdNum < 0) {
      const err = new Error('Не удалось определить InvId');
      err.statusCode = 400;
      throw err;
    }

    if (!verifyRobokassaResultSignature({
      outSum,
      invId: invIdNum,
      signatureValue,
      receipt: typeof payload.Receipt === 'string' ? payload.Receipt : '',
      shpParams: {
        Shp_analysisId: analysisId || '',
        Shp_scanId: scanId || '',
        Shp_shareId: typeof payload.Shp_shareId === 'string' ? payload.Shp_shareId : '',
        Shp_userId: typeof payload.Shp_userId === 'string' ? payload.Shp_userId : '',
      },
    })) {
      const err = new Error('Webhook: неверная подпись');
      err.statusCode = 403;
      throw err;
    }

    const normalizedSum = normalizeRobokassaOutSum(outSum);
    if (!normalizedSum || normalizedSum !== FULL_ANALYSIS_PRICE_RUB) {
      const err = new Error('Webhook: неподходящая сумма');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const now = new Date();
    const paymentId = `robokassa:${invIdNum}`;
    const webhook = await prisma.paymentWebhookEvent.upsert({
      where: { paymentId },
      create: {
        paymentId,
        event: 'payment.succeeded',
        payload,
        lastTriedAt: now,
        attempts: 1,
      },
      update: {
        event: 'payment.succeeded',
        payload,
        lastTriedAt: now,
        attempts: { increment: 1 },
      },
    });

    if (webhook?.processedAt) {
      res.type('text/plain').send(`OK${invIdNum}`);
      return;
    }

    if (!scanId && !analysisId) {
      await prisma.paymentWebhookEvent.update({
        where: { paymentId },
        data: { processedAt: new Date(), lastError: 'missing_shp' },
      });
      res.type('text/plain').send(`OK${invIdNum}`);
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

    res.type('text/plain').send(`OK${invIdNum}`);
  } catch (err) {
    next(err);
  }
};

const yookassaWebhookMiddleware = [webhookLimiter, yookassaWebhookHandler];

app.post('/api/payment/webhook', ...yookassaWebhookMiddleware);
app.post('/api/payment/webhook/:token', ...yookassaWebhookMiddleware);
app.post('/api/payment/webhook/yookassa', ...yookassaWebhookMiddleware);
app.post('/api/payment/webhook/yookassa/:token', ...yookassaWebhookMiddleware);

const robokassaWebhookMiddleware = [express.urlencoded({ extended: false }), webhookLimiter, robokassaResultHandler];

app.get('/api/payment/webhook/robokassa', ...robokassaWebhookMiddleware);
app.post('/api/payment/webhook/robokassa', ...robokassaWebhookMiddleware);
app.get('/api/payment/webhook/robokassa/:token', ...robokassaWebhookMiddleware);
app.post('/api/payment/webhook/robokassa/:token', ...robokassaWebhookMiddleware);

app.get('/api/payment/robokassa/pay/:invId', requireAuth(async (req, res, next) => {
  try {
    const invIdRaw = typeof req.params?.invId === 'string' ? req.params.invId.trim() : '';
    const invIdNum = /^\d+$/.test(invIdRaw) ? Number(invIdRaw) : NaN;
    if (!Number.isFinite(invIdNum) || invIdNum < 0) {
      const err = new Error('Не удалось определить InvId');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const paymentId = `robokassa:${invIdNum}`;
    const evt = await prisma.paymentWebhookEvent.findUnique({ where: { paymentId } });
    if (!evt) {
      const err = new Error('Платёж не найден');
      err.statusCode = 404;
      throw err;
    }

    const payload = typeof evt.payload === 'object' && evt.payload !== null ? evt.payload : {};
    const provider = typeof payload.provider === 'string' ? payload.provider : '';
    if (provider !== 'robokassa') {
      const err = new Error('Платёж не найден');
      err.statusCode = 404;
      throw err;
    }

    const userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
    if (!userId || userId !== String(req.auth.userId)) {
      const err = new Error('Платёж не найден');
      err.statusCode = 404;
      throw err;
    }

    const returnUrl = typeof payload.returnUrl === 'string' ? payload.returnUrl.trim() : '';
    if (evt.event !== 'payment.created') {
      res.redirect(302, returnUrl || getPaymentReturnUrl());
      return;
    }

    const outSum = typeof payload.outSum === 'string' ? payload.outSum.trim() : FULL_ANALYSIS_PRICE_RUB;
    const normalizedSum = normalizeRobokassaOutSum(outSum);
    if (!normalizedSum || normalizedSum !== FULL_ANALYSIS_PRICE_RUB) {
      const err = new Error('Некорректная сумма');
      err.statusCode = 400;
      throw err;
    }

    const scanId = typeof payload.scanId === 'string' ? payload.scanId.trim() : '';
    const analysisId = typeof payload.analysisId === 'string' ? payload.analysisId.trim() : '';

    const emailFromPayload = typeof payload.email === 'string' ? payload.email.trim() : '';
    let email = emailFromPayload ? normalizeEmail(emailFromPayload) : '';
    if (!email) {
      const user = await prisma.user.findUnique({ where: { id: req.auth.userId } });
      const emailFromUser = typeof user?.email === 'string' ? user.email : '';
      email = emailFromUser ? normalizeEmail(emailFromUser) : '';
    }

    let shareId = '';
    if (scanId) {
      const scan = await prisma.scan.findFirst({ where: { id: scanId, userId: req.auth.userId } });
      shareId = scan?.shareId ? String(scan.shareId) : '';
    }

    const receiptJson = buildRobokassaReceiptJson({ outSum: normalizedSum });
    const description = 'Оплата полного разбора';
    const shpParams = {
      Shp_scanId: scanId || '',
      Shp_analysisId: analysisId || '',
      Shp_shareId: shareId || '',
      Shp_userId: String(req.auth.userId),
    };
    const html = buildRobokassaPaymentFormHtml({
      invId: invIdNum,
      outSum: normalizedSum,
      description,
      shpParams,
      email: email || undefined,
      receiptJson,
    });

    res.status(200).setHeader('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(html);
  } catch (err) {
    next(err);
  }
}));

app.get('/api/payment/robokassa/success', async (req, res, next) => {
  try {
    const q = typeof req.query === 'object' && req.query !== null ? req.query : {};
    const outSum = typeof q.OutSum === 'string' ? q.OutSum : '';
    const invId = typeof q.InvId === 'string' ? q.InvId : '';
    const signatureValue = typeof q.SignatureValue === 'string' ? q.SignatureValue : '';
    const scanId = typeof q.Shp_scanId === 'string' ? q.Shp_scanId.trim() : '';
    const analysisId = typeof q.Shp_analysisId === 'string' ? q.Shp_analysisId.trim() : '';
    const shareId = typeof q.Shp_shareId === 'string' ? q.Shp_shareId.trim() : '';

    const invIdNum = /^\d+$/.test(invId) ? Number(invId) : NaN;
    if (!Number.isFinite(invIdNum) || invIdNum < 0) {
      const err = new Error('Не удалось определить InvId');
      err.statusCode = 400;
      throw err;
    }

    if (!verifyRobokassaSuccessSignature({
      outSum,
      invId: invIdNum,
      signatureValue,
      receipt: typeof q.Receipt === 'string' ? q.Receipt : '',
      shpParams: {
        Shp_analysisId: analysisId || '',
        Shp_scanId: scanId || '',
        Shp_shareId: shareId || '',
        Shp_userId: typeof q.Shp_userId === 'string' ? q.Shp_userId : '',
      },
    })) {
      const err = new Error('Redirect: неверная подпись');
      err.statusCode = 403;
      throw err;
    }

    const normalizedSum = normalizeRobokassaOutSum(outSum);
    if (!normalizedSum || normalizedSum !== FULL_ANALYSIS_PRICE_RUB) {
      const err = new Error('Redirect: неподходящая сумма');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const now = new Date();
    const paymentId = `robokassa:${invIdNum}`;

    const webhook = await prisma.paymentWebhookEvent.upsert({
      where: { paymentId },
      create: {
        paymentId,
        event: 'payment.succeeded',
        payload: q,
        lastTriedAt: now,
        attempts: 1,
      },
      update: {
        event: 'payment.succeeded',
        payload: q,
        lastTriedAt: now,
        attempts: { increment: 1 },
      },
    });

    if (!webhook?.processedAt) {
      if (analysisId) {
        await prisma.analysis.updateMany({
          where: {
            id: analysisId,
            isPaid: false,
          },
          data: { isPaid: true },
        });
      }

      if (scanId) {
        await prisma.scan.updateMany({
          where: {
            id: scanId,
            isPaid: false,
          },
          data: { isPaid: true },
        });
      }

      await prisma.paymentWebhookEvent.update({
        where: { paymentId },
        data: { processedAt: new Date(), lastError: null },
      });
    }

    const redirectUrl = buildPaymentReturnUrl({
      scanId: scanId || undefined,
      analysisId: analysisId || undefined,
      shareId: shareId || undefined,
    });
    res.redirect(302, redirectUrl);
  } catch (err) {
    next(err);
  }
});

app.get('/api/payment/robokassa/fail', (_req, res) => {
  res.redirect(302, getPaymentReturnUrl());
});

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
