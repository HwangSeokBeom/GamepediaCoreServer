const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { AppError } = require('../../utils/error-response');
const { asyncHandler } = require('../../utils/async-handler');
const { logger } = require('../../utils/logger');
const { FEATURE_FLAG_KEYS } = require('./product.constants');

// Kill switches are resolved from the database on every request rather than
// cached in the process: a process-local cache would let one instance keep
// serving a feature after an operator disabled it, so it cannot be the basis of
// a correctness or safety decision. A missing row falls back to the configured
// environment default, and a database failure falls back to the same defaults so
// a flag lookup can never take down an existing endpoint.

function buildDefaultFlags() {
  return { ...env.productFeatureFlagDefaults };
}

async function resolveFeatureFlags() {
  const flags = buildDefaultFlags();

  try {
    const overrides = await prisma.productFeatureFlag.findMany({
      where: { key: { in: [...FEATURE_FLAG_KEYS] } },
      select: { key: true, enabled: true }
    });

    for (const override of overrides) {
      if (Object.hasOwn(flags, override.key)) {
        flags[override.key] = override.enabled;
      }
    }

    return { flags, source: 'database' };
  } catch (error) {
    logger.warn('product-feature-flag-lookup-failed', {
      errorCategory: error?.code ?? error?.name ?? 'unknown',
      flagCount: FEATURE_FLAG_KEYS.length,
      fallback: 'environment_defaults'
    });

    return { flags, source: 'environment_defaults' };
  }
}

async function isFeatureEnabled(flagKey) {
  if (!FEATURE_FLAG_KEYS.includes(flagKey)) {
    throw new AppError(500, 'UNKNOWN_FEATURE_FLAG', `Unknown Product 2.2 feature flag: ${flagKey}`);
  }

  const { flags } = await resolveFeatureFlags();

  return flags[flagKey] === true;
}

/// Express guard for a Product 2.2 endpoint. 503 keeps the disabled feature
/// distinguishable from a genuinely missing route while still failing closed.
function requireFeature(flagKey) {
  return asyncHandler(async (req, res, next) => {
    if (!(await isFeatureEnabled(flagKey))) {
      throw new AppError(503, 'FEATURE_DISABLED', `The ${flagKey} feature is currently disabled`, [{
        field: 'feature',
        message: flagKey
      }]);
    }

    next();
  });
}

module.exports = {
  buildDefaultFlags,
  isFeatureEnabled,
  requireFeature,
  resolveFeatureFlags
};
