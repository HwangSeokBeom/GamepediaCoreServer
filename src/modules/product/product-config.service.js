const { env } = require('../../config/env');
const { resolveFeatureFlags } = require('./feature-flag.service');
const {
  ARTICLE_ACTION_CODES,
  FEATURE_FLAG_KEYS,
  PLACEMENT_CODES,
  PRODUCT_EVENT_CODES
} = require('./product.constants');
const { PLAY_COMPASS_MAX_RESULTS, PLAY_COMPASS_REASON_CODES } = require('../play/play.constants');
const { CATALOG_PREVIEW_MAX_CANDIDATES } = require('../catalog/catalog.constants');

// Versioned client contract for Product 2.2. Clients read `version` to decide
// whether they understand the payload; unknown keys are additive by design.
const PRODUCT_CONFIG_DTO_VERSION = 1;

async function getProductConfig({ now = new Date() } = {}) {
  const { flags, source, degraded } = await resolveFeatureFlags();

  return {
    dtoVersion: PRODUCT_CONFIG_DTO_VERSION,
    productVersion: env.productConfigVersion,
    generatedAt: now.toISOString(),
    // `database_unavailable` means the kill-switch state could not be read. Every
    // gated feature is then reported false, which is the state the server is
    // actually enforcing, rather than an optimistic environment default.
    featureFlagSource: source,
    featureFlagStateDegraded: degraded,
    features: Object.fromEntries(FEATURE_FLAG_KEYS.map((flagKey) => [flagKey, flags[flagKey] === true])),
    limits: {
      playCompassMaxResults: PLAY_COMPASS_MAX_RESULTS,
      quickAddPreviewMaxCandidates: CATALOG_PREVIEW_MAX_CANDIDATES,
      quickAddPreviewMaxQuestions: 1,
      aiQuickAddDailyLimit: env.aiQuickAddDailyLimit,
      submissionPreviewTtlMinutes: env.catalogSubmissionPreviewTtlMinutes,
      playSessionNoteMaxLength: 2000,
      productEventBatchMaxSize: 50
    },
    allowlists: {
      productEventCodes: [...PRODUCT_EVENT_CODES],
      articleActionCodes: [...ARTICLE_ACTION_CODES],
      placementCodes: [...PLACEMENT_CODES],
      playCompassReasonCodes: [...PLAY_COMPASS_REASON_CODES]
    }
  };
}

module.exports = {
  PRODUCT_CONFIG_DTO_VERSION,
  getProductConfig
};
