const express = require('express');
const path = require('path');
const { env } = require('./config/env');
const aiRoutes = require('./modules/ai/ai.routes');
const apiV1Routes = require('./routes/api-v1.routes');
const authRoutes = require('./routes/auth.routes');
const favoriteRoutes = require('./modules/favorite/favorite.routes');
const igdbRoutes = require('./modules/igdb/igdb.routes');
const libraryRoutes = require('./modules/library/library.routes');
const moderationRoutes = require('./modules/moderation/moderation.routes');
const reviewRoutes = require('./modules/review/review.routes');
const userRoutes = require('./modules/user/user.routes');
const { getFirebaseAdminState } = require('./config/firebase-admin');
const { getMailReadinessState } = require('./services/email.service');
const {
  errorHandler,
  notFoundHandler,
} = require('./middlewares/error.middleware');
const { logSafely } = require('./utils/logger');

const app = express();
const SOCIAL_AUTH_PROVIDERS = new Map([
  ['/auth/apple', 'apple'],
  ['/auth/google', 'google']
]);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads'), {
  fallthrough: true,
  index: false,
  maxAge: env.nodeEnv === 'production' ? '1h' : 0
}));

function logSocialAuthRequest(req, res, next) {
  const provider = SOCIAL_AUTH_PROVIDERS.get(req.path);

  if (req.method === 'POST' && provider) {
    logSafely('info', 'social-auth-request', {
      method: req.method,
      path: req.path,
      route: 'social-auth',
      provider,
      networkMetadataAvailable: Boolean(req.ip || req.socket.remoteAddress)
    });
  }

  next();
}

app.use(logSocialAuthRequest);

function getIgdbReadiness(runtimeEnv = env) {
  const configured = Boolean(runtimeEnv.twitchClientId && runtimeEnv.twitchClientSecret);

  return {
    required: !runtimeEnv.isDevelopmentLike,
    configured
  };
}

function createHealthHandler({
  runtimeEnv = env,
  getPushState = getFirebaseAdminState,
  getMailState = getMailReadinessState
} = {}) {
  return (req, res) => {
    const push = getPushState();
    const igdb = getIgdbReadiness(runtimeEnv);
    const ready = !igdb.required || igdb.configured;
    // Mail readiness reflects the startup verification result only; in SMTP
    // mode the server never listens before verification has succeeded.
    const mail = getMailState();

    res.status(ready ? 200 : 503).json({
      success: true,
      data: {
        status: ready ? 'ok' : 'degraded',
        igdb,
        mail: {
          mode: mail.mode,
          verified: mail.verified,
          skipped: mail.skipped
        },
        push: {
          enabled: push.enabled,
          initialized: push.initialized,
          projectId: push.projectId,
          source: push.source,
          reason: push.reason
        }
      }
    });
  };
}

app.get('/health', createHealthHandler());

app.use('/auth', authRoutes);
app.use(aiRoutes);
app.use(favoriteRoutes);
app.use(igdbRoutes);
app.use(libraryRoutes);
app.use(moderationRoutes);
app.use(reviewRoutes);
app.use(userRoutes);
// Product 2.2 is mounted last and only owns /api/v1, so it cannot shadow an
// existing unversioned route that a deployed client depends on.
app.use(apiV1Routes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = {
  app,
  createHealthHandler,
  getIgdbReadiness,
  logSocialAuthRequest
};
