const CATALOG_IDENTITY_PROVIDERS = Object.freeze([
  'IGDB',
  'STEAM',
  'APPLE_APP_STORE',
  'GOOGLE_PLAY',
  'OFFICIAL_SITE',
  'COMMUNITY'
]);

const CATALOG_PROVENANCE_VALUES = Object.freeze([
  'PROVIDER_VERIFIED',
  'OFFICIAL_SOURCE',
  'USER_CONFIRMED',
  'COMMUNITY_CONFIRMED',
  'EDITOR_VERIFIED',
  'AI_INFERRED',
  'UNKNOWN',
  'DISPUTED'
]);

const CATALOG_SERVICE_STATUSES = Object.freeze([
  'ANNOUNCED',
  'PRE_REGISTRATION',
  'LIVE',
  'MAINTENANCE',
  'SUNSET_ANNOUNCED',
  'SHUTDOWN'
]);

const GLOBAL_REGION_KEY = 'GLOBAL';

/// Legacy GameSource -> canonical provider. The legacy columns stay
/// authoritative; this only tells the resolver which provider key to look up.
const LEGACY_SOURCE_TO_PROVIDER = Object.freeze({
  IGDB: 'IGDB',
  STEAM: 'STEAM'
});

const CATALOG_PREVIEW_MAX_CANDIDATES = 3;

/// Structured, allowlisted reasons a preview candidate was surfaced. Free-text
/// explanations are never stored or returned.
const CATALOG_MATCH_REASON_CODES = Object.freeze([
  'provider_identity_exact',
  'locale_alias_exact',
  'normalized_title_exact',
  'compact_title_exact',
  'fuzzy_title_similar',
  'developer_match',
  'platform_match',
  'region_match'
]);

/// Confidence assigned by each deterministic resolution stage, highest first.
/// Stage order is the processing order in catalog-submission.service.js.
const MATCH_STAGE_CONFIDENCE = Object.freeze({
  provider_identity_exact: 1,
  locale_alias_exact: 0.9,
  normalized_title_exact: 0.85,
  compact_title_exact: 0.8,
  fuzzy_title_similar: 0.6
});

/// Below this Dice coefficient a fuzzy candidate is not surfaced at all.
const FUZZY_MATCH_MIN_SIMILARITY = 0.62;

/// Field paths a user may correct on an existing catalog game.
const CORRECTABLE_FIELD_PATHS = Object.freeze([
  'originalTitle',
  'developerName',
  'publisherName',
  'firstReleaseDate',
  'genres',
  'platforms',
  'supportsSinglePlayer',
  'supportsMultiplayer',
  'typicalSessionMinutes',
  'regionalRelease.serviceStatus',
  'regionalRelease.operatorName',
  'regionalRelease.serverRegion',
  'regionalRelease.releaseDate',
  'regionalRelease.shutdownDate'
]);

module.exports = {
  CATALOG_IDENTITY_PROVIDERS,
  CATALOG_MATCH_REASON_CODES,
  CATALOG_PREVIEW_MAX_CANDIDATES,
  CATALOG_PROVENANCE_VALUES,
  CATALOG_SERVICE_STATUSES,
  CORRECTABLE_FIELD_PATHS,
  FUZZY_MATCH_MIN_SIMILARITY,
  GLOBAL_REGION_KEY,
  LEGACY_SOURCE_TO_PROVIDER,
  MATCH_STAGE_CONFIDENCE
};
