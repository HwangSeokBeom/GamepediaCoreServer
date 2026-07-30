const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { AppError } = require('../../utils/error-response');
const { asyncHandler } = require('../../utils/async-handler');
const { logger } = require('../../utils/logger');
const { FEATURE_FLAG_KEYS } = require('./product.constants');

// Kill switches are resolved from the database on every request rather than
// cached in the process: a process-local cache would let one instance keep
// serving a feature after an operator disabled it, so it cannot be the basis of
// a correctness or safety decision.
//
// FAIL CLOSED. An environment default may only be applied when the lookup
// *succeeded* and simply had no row for that key. If the lookup itself fails the
// current kill-switch state is unknown, and since every environment default is
// `true`, falling back to them would silently re-enable a feature an operator had
// disabled. So a lookup failure reports every gated Product 2.2 feature as false
// and marks the source `database_unavailable`. Pre-existing unversioned endpoints
// are unaffected: nothing outside /api/v1 consults these flags.

function buildDefaultFlags() {
  return { ...env.productFeatureFlagDefaults };
}

function buildClosedFlags() {
  return Object.fromEntries(FEATURE_FLAG_KEYS.map((flagKey) => [flagKey, false]));
}

async function resolveFeatureFlags() {
  try {
    const overrides = await prisma.productFeatureFlag.findMany({
      where: { key: { in: [...FEATURE_FLAG_KEYS] } },
      select: { key: true, enabled: true }
    });

    // The lookup succeeded, so a key with no row genuinely has no override and
    // the configured default is the operator's intent.
    const flags = buildDefaultFlags();

    for (const override of overrides) {
      if (Object.hasOwn(flags, override.key)) {
        flags[override.key] = override.enabled;
      }
    }

    return { flags, source: 'database', degraded: false };
  } catch (error) {
    logger.warn('product-feature-flag-lookup-failed', {
      // Reason code only; never a raw database error string.
      errorCategory: error?.code ?? error?.name ?? 'unknown',
      flagCount: FEATURE_FLAG_KEYS.length,
      fallback: 'fail_closed'
    });

    return { flags: buildClosedFlags(), source: 'database_unavailable', degraded: true };
  }
}

async function isFeatureEnabled(flagKey) {
  if (!FEATURE_FLAG_KEYS.includes(flagKey)) {
    throw new AppError(500, 'UNKNOWN_FEATURE_FLAG', `Unknown Product 2.2 feature flag: ${flagKey}`);
  }

  const { flags, degraded } = await resolveFeatureFlags();

  return { enabled: flags[flagKey] === true, degraded };
}

/// Express guard for a Product 2.2 endpoint.
///
/// 503 keeps a disabled feature distinguishable from a missing route while still
/// failing closed. An unreadable flag state is reported distinctly as
/// FEATURE_STATE_UNAVAILABLE, so an operator can tell "turned off" from "we could
/// not find out", and a client can retry the latter.
function requireFeature(flagKey) {
  return asyncHandler(async (req, res, next) => {
    const { enabled, degraded } = await isFeatureEnabled(flagKey);

    if (degraded) {
      throw new AppError(503, 'FEATURE_STATE_UNAVAILABLE',
        `The ${flagKey} feature state could not be read and is treated as disabled`, [{
          field: 'feature',
          message: flagKey
        }]);
    }

    if (!enabled) {
      throw new AppError(503, 'FEATURE_DISABLED', `The ${flagKey} feature is currently disabled`, [{
        field: 'feature',
        message: flagKey
      }]);
    }

    next();
  });
}

module.exports = {
  buildClosedFlags,
  buildDefaultFlags,
  isFeatureEnabled,
  requireFeature,
  resolveFeatureFlags
};
