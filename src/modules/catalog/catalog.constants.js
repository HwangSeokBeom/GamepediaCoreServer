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

// ---------------------------------------------------------------------------
// Trust model
// ---------------------------------------------------------------------------
//
// Only a real server-side provider response or an editor decision can produce a
// verified identity or a publicly visible catalog fact. A value a user typed —
// a provider id, a title, a URL — is at most USER_CONFIRMED, and parsing the
// *syntax* of a store URL or a package id is not verification of anything.

/// Provenance values that may back a PUBLISHED catalog game or a verified
/// identity. Everything else is a claim.
const VERIFIED_PROVENANCE_VALUES = Object.freeze([
  'PROVIDER_VERIFIED',
  'OFFICIAL_SOURCE',
  'EDITOR_VERIFIED'
]);

/// Provenance values that must never reach a PUBLISHED catalog game.
const UNVERIFIED_PROVENANCE_VALUES = Object.freeze([
  'USER_CONFIRMED',
  'COMMUNITY_CONFIRMED',
  'AI_INFERRED',
  'UNKNOWN',
  'DISPUTED'
]);

/// How a verified identity came to be trusted. Recorded on the identity row so a
/// reviewer can tell a real Steam sync from an editor decision.
const IDENTITY_VERIFICATION_SOURCES = Object.freeze([
  'steam_owned_games_sync',
  'igdb_provider_lookup',
  'editor_review'
]);

/// Ownership provenance for a library row. A Steam row created by the server from
/// a real Steam API response is PROVIDER_VERIFIED; the same row shape created by
/// a user calling POST /users/me/library/status is only USER_CONFIRMED; a row
/// that predates provenance tracking is UNKNOWN.
const OWNERSHIP_PROVENANCE = Object.freeze({
  PROVIDER_VERIFIED: 'PROVIDER_VERIFIED',
  USER_CONFIRMED: 'USER_CONFIRMED',
  UNKNOWN: 'UNKNOWN'
});

function isVerifiedProvenance(provenance) {
  return VERIFIED_PROVENANCE_VALUES.includes(provenance);
}

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
  'provider_identity_unverified',
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
  // Only a verified provider identity earns full confidence. A key that merely
  // exists as an unverified legacy row is a weaker signal than an exact title.
  provider_identity_exact: 1,
  provider_identity_unverified: 0.5,
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
  IDENTITY_VERIFICATION_SOURCES,
  LEGACY_SOURCE_TO_PROVIDER,
  MATCH_STAGE_CONFIDENCE,
  OWNERSHIP_PROVENANCE,
  UNVERIFIED_PROVENANCE_VALUES,
  VERIFIED_PROVENANCE_VALUES,
  isVerifiedProvenance
};
