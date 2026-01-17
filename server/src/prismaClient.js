const { PrismaClient } = require('@prisma/client');

let prisma;

function getPrismaClient() {
  if (prisma) return prisma;
  prisma = new PrismaClient();
  return prisma;
}

module.exports = {
  getPrismaClient,
};

