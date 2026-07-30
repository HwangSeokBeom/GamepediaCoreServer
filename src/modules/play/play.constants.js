const PLAY_SESSION_OUTCOMES = Object.freeze(['CONTINUE', 'PAUSED', 'DROPPED', 'COMPLETED']);
const PLAY_SESSION_VISIBILITIES = Object.freeze(['PRIVATE', 'FRIENDS', 'PUBLIC']);
const PLAY_SESSION_MOODS = Object.freeze(['RELAXED', 'FOCUSED', 'EXCITED', 'BORED', 'FRUSTRATED', 'NOSTALGIC']);

const PLAY_COMPASS_MAX_RESULTS = 3;
const PLAY_COMPASS_ACTIONS = Object.freeze(['SELECTED', 'EXCLUDED', 'SNOOZED', 'PLAY_CONFIRMED']);

/// Allowlisted, structured explanations. A recommendation never carries free
/// text, so nothing a user typed can be reflected back through a reason.
const PLAY_COMPASS_REASON_CODES = Object.freeze([
  'fits_available_time',
  'shorter_than_available_time',
  'already_in_progress',
  'fresh_start_available',
  'backlog_oldest_untouched',
  'recently_played',
  'not_played_recently',
  'genre_affinity_match',
  'solo_friendly',
  'party_friendly',
  'low_energy_friendly',
  'high_energy_friendly',
  'comfort_pick',
  'challenge_pick',
  'platform_available',
  'installed_on_platform',
  'owned_on_steam',
  'friend_owned_overlap',
  'snoozed_recently_deprioritized'
]);

/// Structured explanations for Game DNA. Same rule: codes only.
const GAME_DNA_REASON_CODES = Object.freeze([
  'rating_sample_sufficient',
  'rating_sample_thin',
  'genre_concentration_high',
  'genre_concentration_low',
  'completion_rate_high',
  'completion_rate_low',
  'drop_rate_high',
  'session_length_short',
  'session_length_long',
  'session_length_mixed',
  'multiplayer_leaning',
  'singleplayer_leaning',
  'comfort_leaning',
  'challenge_leaning',
  'playlog_sample_thin',
  'playtime_signal_missing',
  'genre_signal_missing',
  'steam_tag_signal_missing',
  'recent_activity_missing'
]);

const GAME_DNA_MISSING_SIGNAL_CODES = Object.freeze([
  'ratings',
  'library_status',
  'completion_outcomes',
  'playtime_minutes',
  'genres',
  'steam_tags',
  'recent_play',
  'playlog_outcomes'
]);

const CONFIDENCE_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

/// Genre buckets used by the deterministic ranker and the DNA calculator. Steam
/// tag strings are matched case-insensitively against the same buckets.
const GENRE_BUCKETS = Object.freeze({
  comfort: Object.freeze(['casual', 'simulation', 'life sim', 'farming', 'puzzle', 'visual novel', 'cozy', 'sandbox', 'management']),
  challenge: Object.freeze(['souls-like', 'soulslike', 'roguelike', 'roguelite', 'shooter', 'fighting', 'strategy', 'rts', 'action', 'platformer', 'bullet hell', 'survival']),
  shortSession: Object.freeze(['puzzle', 'roguelike', 'roguelite', 'fighting', 'arcade', 'card', 'battle royale', 'moba', 'sports', 'racing']),
  longSession: Object.freeze(['rpg', 'jrpg', 'mmorpg', 'open world', 'strategy', '4x', 'grand strategy', 'simulation', 'adventure', 'story rich']),
  multiplayer: Object.freeze(['mmorpg', 'moba', 'battle royale', 'co-op', 'coop', 'multiplayer', 'pvp', 'party', 'sports', 'shooter']),
  singleplayer: Object.freeze(['rpg', 'jrpg', 'adventure', 'visual novel', 'story rich', 'puzzle', 'metroidvania', 'platformer', 'singleplayer'])
});

/// Minimum number of distinct signals before a DNA axis is reported at all.
const GAME_DNA_MIN_SIGNALS_PER_AXIS = 3;
const GAME_DNA_HIGH_CONFIDENCE_SIGNALS = 25;
const GAME_DNA_MEDIUM_CONFIDENCE_SIGNALS = 8;

module.exports = {
  CONFIDENCE_LEVELS,
  GAME_DNA_HIGH_CONFIDENCE_SIGNALS,
  GAME_DNA_MEDIUM_CONFIDENCE_SIGNALS,
  GAME_DNA_MIN_SIGNALS_PER_AXIS,
  GAME_DNA_MISSING_SIGNAL_CODES,
  GAME_DNA_REASON_CODES,
  GENRE_BUCKETS,
  PLAY_COMPASS_ACTIONS,
  PLAY_COMPASS_MAX_RESULTS,
  PLAY_COMPASS_REASON_CODES,
  PLAY_SESSION_MOODS,
  PLAY_SESSION_OUTCOMES,
  PLAY_SESSION_VISIBILITIES
};
