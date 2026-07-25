const express = require('express');
const path = require('path');
const { env } = require('./config/env');
const aiRoutes = require('./modules/ai/ai.routes');
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
const { logger } = require('./utils/logger');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads'), {
  fallthrough: true,
  index: false,
  maxAge: env.nodeEnv === 'production' ? '1h' : 0
}));

app.use((req, res, next) => {
  if (req.method === 'POST' && (req.path === '/auth/apple' || req.path === '/auth/google')) {
    logger.info('social-auth-request', {
      method: req.method,
      path: req.path,
      networkMetadataAvailable: Boolean(req.ip || req.socket.remoteAddress)
    });
  }

  next();
});

app.get('/health', (req, res) => {
  const push = getFirebaseAdminState();
  // Mail readiness reflects the startup verification result only; in SMTP
  // mode the server never listens before verification has succeeded.
  const mail = getMailReadinessState();

  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
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
    },
  });
});

app.use('/auth', authRoutes);
app.use(aiRoutes);
app.use(favoriteRoutes);
app.use(igdbRoutes);
app.use(libraryRoutes);
app.use(moderationRoutes);
app.use(reviewRoutes);
app.use(userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = { app };
