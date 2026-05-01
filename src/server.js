const os = require('os');
const { app } = require('./app');
const { env } = require('./config/env');
const { connectDatabase, disconnectDatabase } = require('./config/prisma');
const { initializeFirebaseAdmin } = require('./config/firebase-admin');
const { probeRedisConnection } = require('./config/redis');
const { logger } = require('./utils/logger');

function getLanIpv4Address() {
  const networkInterfaces = os.networkInterfaces();

  for (const addresses of Object.values(networkInterfaces)) {
    for (const address of addresses ?? []) {
      if (address && address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  return null;
}

function buildServerUrls() {
  const lanIpv4Address = getLanIpv4Address();
  const localhostUrl = `http://localhost:${env.port}`;
  const lanUrl = lanIpv4Address ? `http://${lanIpv4Address}:${env.port}` : null;

  return {
    lanIpv4Address,
    lanUrl,
    localhostUrl
  };
}

let server = null;

async function startServer() {
  try {
    await connectDatabase();
    await probeRedisConnection();
    const firebaseState = initializeFirebaseAdmin();

    server = app.listen(env.port, env.host, () => {
      const { lanUrl, localhostUrl } = buildServerUrls();

      logger.info('GamePedia auth server started', {
        host: env.host,
        port: env.port,
        localhostUrl,
        lanUrl,
        llmProvider: env.llmProvider,
        llmModel: env.llmModel,
        llmBaseUrl: env.llmBaseUrl,
        llmApiKeyConfigured: Boolean(env.llmApiKey),
        pushEnabled: firebaseState.enabled,
        pushDisabledReason: firebaseState.reason
      });
    });
  } catch (error) {
    logger.error('GamePedia auth server failed to start', { error });
    await disconnectDatabase();
    process.exit(1);
  }
}

async function shutdown(signal) {
  logger.info('Shutdown signal received', { signal });

  if (!server) {
    await disconnectDatabase();
    process.exit(0);
    return;
  }

  server.close(async () => {
    await disconnectDatabase();
    process.exit(0);
  });
}

void startServer();

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
