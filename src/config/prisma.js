const { PrismaClient } = require('@prisma/client');
const { env } = require('./env');
const { logger } = require('../utils/logger');

const prisma = new PrismaClient({
  log: env.nodeEnv === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error']
});

function describeDatabaseConnection(databaseUrl) {
  try {
    const parsedUrl = new URL(databaseUrl);

    return {
      host: parsedUrl.hostname,
      port: parsedUrl.port ? Number(parsedUrl.port) : 5432,
      database: parsedUrl.pathname.replace(/^\//, '')
    };
  } catch (error) {
    return {};
  }
}

async function connectDatabase() {
  await prisma.$connect();
  logger.info('Database connection established', describeDatabaseConnection(env.databaseUrl));
}

async function disconnectDatabase() {
  try {
    await prisma.$disconnect();
    logger.info('Database connection closed');
  } catch (error) {
    logger.error('Database disconnect failed', { error });
  }
}

module.exports = { prisma, connectDatabase, disconnectDatabase };
