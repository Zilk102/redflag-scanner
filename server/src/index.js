require('dotenv').config();

const { execSync } = require('child_process');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const YooKassa = require('yookassa');
const { getPrismaClient } = require('./prismaClient');
const { YandexGPTService } = require('./services/YandexGPTService');

function createYooKassaClient() {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;

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

  return new YooKassa({ shopId, secretKey });
}

let cachedYooKassaClient = null;

function getYooKassaClient() {
  if (cachedYooKassaClient) return cachedYooKassaClient;
  cachedYooKassaClient = createYooKassaClient();
  return cachedYooKassaClient;
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

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    credentials: true,
  }),
);

app.use(defaultLimiter);

app.use(express.json({ limit: '2mb' }));

app.post('/api/analyze', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'Поле text обязательно' });
    return;
  }

  const yandex = new YandexGPTService();
  const result = await yandex.analyzeText(text);

  const prisma = getPrismaClient();
  const analysis = await prisma.analysis.create({
    data: {
      originalText: text,
      result,
      isPaid: false,
    },
  });

  res.json({
    id: analysis.id,
    originalText: analysis.originalText,
    result: analysis.result,
    isPaid: analysis.isPaid,
    createdAt: analysis.createdAt,
  });
});

app.post('/api/scan', scanLimiter, async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      const err = new Error('Поле text обязательно');
      err.statusCode = 400;
      throw err;
    }

    const yandex = new YandexGPTService();
    const result = await yandex.scan(text);

    const prisma = getPrismaClient();
    const scan = await prisma.scan.create({
      data: {
        text,
        result,
      },
    });

    res.json({
      id: scan.id,
      text: scan.text,
      result: scan.result,
      createdAt: scan.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/scan/:id', async (req, res, next) => {
  try {
    const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
    if (!id) {
      const err = new Error('Поле id обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const scan = await prisma.scan.findUnique({ where: { id } });
    if (!scan) {
      const err = new Error('Скан не найден');
      err.statusCode = 404;
      throw err;
    }

    res.json({
      id: scan.id,
      text: scan.text,
      result: scan.result,
      createdAt: scan.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/pay', async (req, res, next) => {
  try {
    const scanId = typeof req.body?.scanId === 'string' ? req.body.scanId.trim() : '';
    const analysisId = typeof req.body?.analysisId === 'string' ? req.body.analysisId.trim() : '';

    const idempotenceKey = crypto.randomUUID();

    const metadata = {};
    if (scanId) metadata.scanId = scanId;
    if (analysisId) metadata.analysisId = analysisId;

    const payment = await getYooKassaClient().createPayment(
      {
        amount: {
          value: '149.00',
          currency: 'RUB',
        },
        confirmation: {
          type: 'redirect',
          return_url: buildYooKassaReturnUrl({ scanId, analysisId }),
        },
        capture: true,
        description: 'Оплата полного разбора',
        metadata,
      },
      idempotenceKey,
    );

    const confirmationUrl = payment?.confirmation?.confirmation_url;
    if (typeof confirmationUrl !== 'string' || !confirmationUrl) {
      const err = new Error('ЮKassa не вернула ссылку на оплату');
      err.statusCode = 502;
      throw err;
    }

    res.json({ confirmation_url: confirmationUrl });
  } catch (err) {
    next(err);
  }
});

app.post('/api/payment/create', async (req, res, next) => {
  try {
    const analysisId = typeof req.body?.analysisId === 'string' ? req.body.analysisId.trim() : '';
    if (!analysisId) {
      const err = new Error('Поле analysisId обязательно');
      err.statusCode = 400;
      throw err;
    }

    const prisma = getPrismaClient();
    const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
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

    const payment = await getYooKassaClient().createPayment(
      {
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
    );

    const confirmationUrl = payment?.confirmation?.confirmation_url;
    if (typeof confirmationUrl !== 'string' || !confirmationUrl) {
      const err = new Error('ЮKassa не вернула ссылку на оплату');
      err.statusCode = 502;
      throw err;
    }

    res.json({ confirmationUrl, confirmation_url: confirmationUrl });
  } catch (err) {
    next(err);
  }
});

app.post('/api/payment/webhook', async (req, res, next) => {
  try {
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

    const payment = await getYooKassaClient().getPayment(paymentId);

    if (payment?.status !== 'succeeded' || payment?.paid !== true) {
      res.json({ received: true });
      return;
    }

    const analysisId = typeof payment?.metadata?.analysisId === 'string' ? payment.metadata.analysisId.trim() : '';
    if (!analysisId) {
      res.json({ received: true });
      return;
    }

    const prisma = getPrismaClient();
    await prisma.analysis.updateMany({
      where: {
        id: analysisId,
        isPaid: false,
      },
      data: {
        isPaid: true,
      },
    });

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  const statusCode = Number(err?.statusCode ?? 500);
  const message = err?.message ?? 'Внутренняя ошибка сервера';
  res.status(statusCode).json({ error: message });
});

const port = Number(process.env.PORT ?? '5000');

app.listen(port, () => {
  process.stdout.write(`Server listening on port ${port}\n`);
});
