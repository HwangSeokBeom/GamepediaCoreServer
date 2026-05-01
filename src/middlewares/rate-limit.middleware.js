const { AppError } = require('../utils/error-response');

function createInMemoryRateLimit({ windowMs, max, keyPrefix }) {
  const hits = new Map();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const userKey = req.auth?.userId ?? req.ip ?? 'anonymous';
    const key = `${keyPrefix}:${userKey}`;
    const current = hits.get(key);

    if (!current || current.resetAt <= now) {
      hits.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      next();
      return;
    }

    current.count += 1;

    if (current.count > max) {
      next(new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Please try again later.'));
      return;
    }

    next();
  };
}

module.exports = {
  createInMemoryRateLimit
};
