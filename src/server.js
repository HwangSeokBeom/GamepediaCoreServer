const os = require('os');
const { app } = require('./app');
const { env } = require('./config/env');
const { connectDatabase, disconnectDatabase } = require('./config/prisma');
const { initializeFirebaseAdmin } = require('./config/firebase-admin');
const { probeRedisConnection } = require('./config/redis');
const {
  verifyCatalogNormalizationContract
} = require('./modules/catalog/catalog-normalization.service');
const {
  startProfileImageCleanupWorker,
  stopProfileImageCleanupWorker
} = require('./modules/user/profile-image-cleanup.service');
const {
  closeMailTransport,
  verifyMailStartupReadiness
} = require('./services/email.service');
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

// Startup sequence with injectable dependencies so bootstrap ordering (SMTP
// verification strictly before listen) is unit-testable without binding a
// port or contacting real infrastructure.
async function startServer(overrides = {}) {
  const deps = {
    connectDatabase,
    disconnectDatabase,
    verifyCatalogNormalizationContract,
    probeRedisConnection,
    initializeFirebaseAdmin,
    startProfileImageCleanupWorker,
    verifyMailStartupReadiness,
    closeMailTransport,
    listen: (onListening) => app.listen(env.port, env.host, onListening),
    exit: (code) => process.exit(code),
    logger,
    ...overrides
  };

  try {
    await deps.connectDatabase();
    await deps.verifyCatalogNormalizationContract();
    await deps.probeRedisConnection();
    const firebaseState = deps.initializeFirebaseAdmin();

    // Release policy: a production-like server must not report itself ready
    // for password-reset service while its SMTP transport is unusable, so a
    // failed verification aborts startup before the port is ever bound.
    const mailReadiness = await deps.verifyMailStartupReadiness();

    deps.startProfileImageCleanupWorker();

    server = deps.listen(() => {
      const { lanUrl, localhostUrl } = buildServerUrls();

      deps.logger.info('GamePedia auth server started', {
        host: env.host,
        port: env.port,
        localhostUrl,
        lanUrl,
        llmProvider: env.llmProvider,
        llmModel: env.llmModel,
        llmBaseUrl: env.llmBaseUrl,
        llmApiKeyConfigured: Boolean(env.llmApiKey),
        pushEnabled: firebaseState.enabled,
        pushDisabledReason: firebaseState.reason,
        mailMode: mailReadiness.mode,
        mailVerified: mailReadiness.verified
      });
    });

    return server;
  } catch (error) {
    deps.logger.error('GamePedia auth server failed to start', { error });
    deps.closeMailTransport();
    await deps.disconnectDatabase();
    deps.exit(1);
    return null;
  }
}

async function shutdown(signal) {
  logger.info('Shutdown signal received', { signal });

  stopProfileImageCleanupWorker();
  closeMailTransport();

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

if (require.main === module) {
  void startServer();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

module.exports = { startServer, shutdown };
