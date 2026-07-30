// Product 2.2 control-plane constants.
//
// Everything here is an allowlist. Codes and property keys that are not listed
// are rejected rather than stored, so a client cannot smuggle a raw search
// query, a Playlog note, a provider response body or a prompt into analytics.

const FEATURE_FLAG_KEYS = Object.freeze([
  'openCatalog',
  'aiQuickAdd',
  'playlog',
  'playCompass',
  'gameDNA',
  'monthlyReplay',
  'todayFeed',
  'magazine'
]);

const PRODUCT_ROLES = Object.freeze({
  USER: 'USER',
  EDITOR: 'EDITOR',
  ADMIN: 'ADMIN'
});

/// Value shapes an event property may take. `enum` restricts to a fixed set of
/// short codes; there is deliberately no free-text shape.
const PROPERTY_SHAPES = Object.freeze({
  boolean: 'boolean',
  integer: 'integer',
  enum: 'enum',
  code: 'code'
});

const PLACEMENT_CODES = Object.freeze([
  'today_play_compass',
  'today_game_dna',
  'today_game_briefing',
  'today_backlog_rescue',
  'today_start_guide',
  'today_editorial',
  'today_monthly_replay',
  'today_friend_activity',
  'catalog_search',
  'catalog_detail',
  'magazine_detail'
]);

const ARTICLE_ACTION_CODES = Object.freeze(['open', 'source_open', 'follow_game', 'share', 'dismiss']);
const QUICK_ADD_RESULT_CODES = Object.freeze(['existing_candidate', 'new_draft', 'needs_question', 'degraded_manual']);
const REPLAY_SHARE_TARGET_CODES = Object.freeze(['image', 'link', 'clipboard']);

/// eventCode -> allowed property keys and their shapes. A property that is not
/// declared here is dropped before the row is written.
const PRODUCT_EVENT_ALLOWLIST = Object.freeze({
  quick_add_preview: Object.freeze({
    inputType: { shape: PROPERTY_SHAPES.enum, values: ['TEXT', 'URL', 'PROVIDER_ID'] },
    candidateCount: { shape: PROPERTY_SHAPES.integer, min: 0, max: 3 },
    aiUsed: { shape: PROPERTY_SHAPES.boolean },
    aiFallbackUsed: { shape: PROPERTY_SHAPES.boolean },
    resultCode: { shape: PROPERTY_SHAPES.enum, values: QUICK_ADD_RESULT_CODES }
  }),
  quick_add_confirm: Object.freeze({
    createdNewGame: { shape: PROPERTY_SHAPES.boolean },
    publicReviewRequested: { shape: PROPERTY_SHAPES.boolean },
    identityProviderCount: { shape: PROPERTY_SHAPES.integer, min: 0, max: 8 }
  }),
  play_compass_submit: Object.freeze({
    availableMinutes: { shape: PROPERTY_SHAPES.integer, min: 0, max: 1440 },
    soloOrParty: { shape: PROPERTY_SHAPES.enum, values: ['SOLO', 'PARTY', 'EITHER'] },
    continueOrStart: { shape: PROPERTY_SHAPES.enum, values: ['CONTINUE', 'START', 'EITHER'] },
    resultCount: { shape: PROPERTY_SHAPES.integer, min: 0, max: 3 }
  }),
  play_compass_select: Object.freeze({
    rank: { shape: PROPERTY_SHAPES.integer, min: 1, max: 3 },
    reasonCode: { shape: PROPERTY_SHAPES.code },
    confidence: { shape: PROPERTY_SHAPES.enum, values: ['LOW', 'MEDIUM', 'HIGH'] }
  }),
  play_session_create: Object.freeze({
    outcome: { shape: PROPERTY_SHAPES.enum, values: ['CONTINUE', 'PAUSED', 'DROPPED', 'COMPLETED'] },
    hasDuration: { shape: PROPERTY_SHAPES.boolean },
    hasProgress: { shape: PROPERTY_SHAPES.boolean },
    idempotentReplay: { shape: PROPERTY_SHAPES.boolean }
  }),
  game_dna_view: Object.freeze({
    signalCount: { shape: PROPERTY_SHAPES.integer, min: 0, max: 100000 },
    confidence: { shape: PROPERTY_SHAPES.enum, values: ['LOW', 'MEDIUM', 'HIGH'] },
    missingSignalCount: { shape: PROPERTY_SHAPES.integer, min: 0, max: 32 }
  }),
  replay_view: Object.freeze({
    monthOffset: { shape: PROPERTY_SHAPES.integer, min: -120, max: 0 },
    isEmpty: { shape: PROPERTY_SHAPES.boolean },
    playedDayCount: { shape: PROPERTY_SHAPES.integer, min: 0, max: 31 }
  }),
  replay_share: Object.freeze({
    target: { shape: PROPERTY_SHAPES.enum, values: REPLAY_SHARE_TARGET_CODES },
    monthOffset: { shape: PROPERTY_SHAPES.integer, min: -120, max: 0 }
  }),
  article_impression: Object.freeze({
    placement: { shape: PROPERTY_SHAPES.enum, values: PLACEMENT_CODES },
    position: { shape: PROPERTY_SHAPES.integer, min: 0, max: 200 },
    articleSlug: { shape: PROPERTY_SHAPES.code }
  }),
  article_action: Object.freeze({
    placement: { shape: PROPERTY_SHAPES.enum, values: PLACEMENT_CODES },
    action: { shape: PROPERTY_SHAPES.enum, values: ARTICLE_ACTION_CODES },
    articleSlug: { shape: PROPERTY_SHAPES.code }
  })
});

const PRODUCT_EVENT_CODES = Object.freeze(Object.keys(PRODUCT_EVENT_ALLOWLIST));

/// A `code` property must look like a slug: short, lowercase, no whitespace and
/// no punctuation that could carry a sentence, URL or query string.
const CODE_VALUE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

module.exports = {
  ARTICLE_ACTION_CODES,
  CODE_VALUE_PATTERN,
  FEATURE_FLAG_KEYS,
  PLACEMENT_CODES,
  PRODUCT_EVENT_ALLOWLIST,
  PRODUCT_EVENT_CODES,
  PRODUCT_ROLES,
  PROPERTY_SHAPES,
  QUICK_ADD_RESULT_CODES,
  REPLAY_SHARE_TARGET_CODES
};
