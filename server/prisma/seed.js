require('dotenv').config();

const { PrismaClient } = require('@prisma/client');

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

async function main() {
  ensureDatabaseUrl();

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL не задан (или не удалось собрать из POSTGRES_* и DB_*)');
  }

  const prisma = new PrismaClient();

  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    const now = await prisma.$queryRaw`SELECT NOW() as now`;

    const first = Array.isArray(now) ? now[0] : null;
    const dbNow =
      first && typeof first === 'object' && first !== null && 'now' in first
        ? String(first.now)
        : '';

    process.stdout.write(JSON.stringify({ ok: true, dbNow }) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write((err?.message ?? 'Seed упал с ошибкой') + '\n');
  process.exit(1);
});

