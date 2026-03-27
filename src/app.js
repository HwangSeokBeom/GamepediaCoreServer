const express = require('express');
const path = require('path');
const { env } = require('./config/env');
const authRoutes = require('./routes/auth.routes');
const favoriteRoutes = require('./modules/favorite/favorite.routes');
const igdbRoutes = require('./modules/igdb/igdb.routes');
const moderationRoutes = require('./modules/moderation/moderation.routes');
const reviewRoutes = require('./modules/review/review.routes');
const userRoutes = require('./modules/user/user.routes');
const {
  errorHandler,
  notFoundHandler,
} = require('./middlewares/error.middleware');

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
    console.log(
      `[social-auth] ${new Date().toISOString()} ${req.method} ${req.originalUrl} ip=${req.ip} remote=${req.socket.remoteAddress ?? 'unknown'}`
    );
  }

  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
    },
  });
});

app.use('/auth', authRoutes);
app.use(favoriteRoutes);
app.use(igdbRoutes);
app.use(moderationRoutes);
app.use(reviewRoutes);
app.use(userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = { app };
