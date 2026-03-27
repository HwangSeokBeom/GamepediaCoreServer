const { PrismaClient } = require('@prisma/client');
const { env } = require('./env');

const prisma = new PrismaClient({
  log: env.nodeEnv === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error']
});

module.exports = { prisma };
