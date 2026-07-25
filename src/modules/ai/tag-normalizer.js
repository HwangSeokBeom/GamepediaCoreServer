const { logger } = require('../../utils/logger');

const DEFAULT_MAX_TAGS = 5;
const MAX_CANONICAL_LENGTH = 40;
const INVALID_TAGS = new Set([
  '',
  'na',
  'n a',
  'n/a',
  'none',
  'null',
  'undefined',
  'unknown',
  'etc',
  '기타',
  '알수없음',
  '알 수 없음'
]);

const CANONICAL_ALIASES = new Map(Object.entries({
  balanced: 'balanced',
  balance: 'balanced',
  short: 'short_session',
  'short session': 'short_session',
  'short sessions': 'short_session',
  short_session: 'short_session',
  low: 'low_difficulty',
  'low difficulty': 'low_difficulty',
  low_difficulty: 'low_difficulty',
  easy: 'low_difficulty',
  beginner: 'low_difficulty',
  singleplayer: 'singleplayer',
  'single player': 'singleplayer',
  single_player: 'singleplayer',
  multiplayer: 'multiplayer',
  'multi player': 'multiplayer',
  co: 'coop',
  'co op': 'coop',
  'co-op': 'coop',
  coop: 'coop',
  cooperative: 'coop',
  relaxing: 'relaxing',
  relax: 'relaxing',
  healing: 'relaxing',
  cozy: 'cozy',
  'relaxing visual novel': 'relaxing_visual_novel',
  relaxing_visual_novel: 'relaxing_visual_novel',
  'short interactive story': 'short_interactive_story',
  short_interactive_story: 'short_interactive_story',
  'interactive story': 'interactive_story',
  interactive_story: 'interactive_story',
  'visual novel': 'visual_novel',
  visual_novel: 'visual_novel',
  indie: 'indie',
  rpg: 'rpg',
  'role playing': 'rpg',
  'role-playing': 'rpg',
  roleplaying: 'rpg',
  strategy: 'strategy',
  simulation: 'simulation',
  simulator: 'simulation',
  action: 'action',
  adventure: 'adventure',
  puzzle: 'puzzle',
  sports: 'sports',
  'story rich': 'story_rich',
  'story-rich': 'story_rich',
  story_rich: 'story_rich',
  casual: 'casual',
  kitchen: 'kitchen',
  survival: 'survival',
  builder: 'builder',
  'high rated': 'high_rated',
  high_rated: 'high_rated',
  'highly rated': 'high_rated',
  'good match': 'good_match',
  'great match': 'good_match',
  personalized: 'personalized',
  'personalized match': 'personalized',
  personalized_match: 'personalized',
  'default ranking': 'default_ranking',
  default_ranking: 'default_ranking',
  fallback: 'default_ranking',
  'fallback ranking': 'default_ranking',
  'ai fallback': 'default_ranking',

  // Server-side Korean fallback/ranker tags. They are normalized to client-localizable keys.
  '힐링': 'relaxing',
  '편안': 'relaxing',
  '코지': 'cozy',
  '짧은 세션': 'short_session',
  '쉬운 난이도': 'low_difficulty',
  '싱글': 'singleplayer',
  '싱글플레이': 'singleplayer',
  '친구와 함께': 'multiplayer',
  '멀티': 'multiplayer',
  '협동': 'coop',
  '플랫폼 매칭': 'good_match',
  '장르 매칭': 'good_match',
  '고평점 취향': 'high_rated',
  '찜 기반': 'personalized',
  '플레이 이력': 'personalized',
  '개인화': 'personalized',
  '기본 추천': 'default_ranking',
  '기본 랭킹': 'default_ranking'
}));

const DISPLAY_LABELS = new Map(Object.entries({
  rpg: 'RPG',
  coop: 'Co-op',
  singleplayer: 'Singleplayer'
}));

function splitCamelCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function normalizeAliasKey(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return splitCamelCase(value)
    .normalize('NFKC')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/[()[\]{}"'`]/g, ' ')
    .replace(/[^\p{L}\p{N}&+/\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isProbablySentence(rawValue, aliasKey) {
  const words = aliasKey.split(/\s+/).filter(Boolean);
  const hasSentencePunctuation = /[.!?。！？]/u.test(rawValue);

  return words.length > 5 || aliasKey.length > MAX_CANONICAL_LENGTH || (hasSentencePunctuation && words.length > 3);
}

function toCanonicalTag(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const aliasKey = normalizeAliasKey(value);

  if (INVALID_TAGS.has(aliasKey)) {
    return null;
  }

  const aliasCanonical = CANONICAL_ALIASES.get(aliasKey) ?? CANONICAL_ALIASES.get(aliasKey.replace(/\s+/g, '_'));

  if (aliasCanonical) {
    return aliasCanonical;
  }

  if (!/^[\p{Script=Latin}0-9\s]+$/u.test(aliasKey) || isProbablySentence(value, aliasKey)) {
    logger.info('[AITagNormalizer] dropped invalid tag', {
      tagLength: typeof value === 'string' ? value.length : 0,
      reason: 'invalid_format'
    });
    return null;
  }

  const canonical = aliasKey.replace(/\s+/g, '_');

  return canonical.length > 0 && canonical.length <= MAX_CANONICAL_LENGTH ? canonical : null;
}

function readableLabelFromCanonical(canonicalTag) {
  if (DISPLAY_LABELS.has(canonicalTag)) {
    return DISPLAY_LABELS.get(canonicalTag);
  }

  return canonicalTag
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function collectRawTags(input) {
  const values = [];
  const fields = [
    'rawTags',
    'matchTags',
    'displayTags',
    'reasonTags',
    'intentTags',
    'genres',
    'themes',
    'keywords'
  ];

  for (const field of fields) {
    const fieldValue = input?.[field];

    if (!Array.isArray(fieldValue)) {
      continue;
    }

    for (const value of fieldValue) {
      if (typeof value !== 'string') {
        continue;
      }

      const trimmedValue = value.trim().replace(/\s+/g, ' ');

      if (!trimmedValue || INVALID_TAGS.has(normalizeAliasKey(trimmedValue))) {
        continue;
      }

      values.push(trimmedValue);
    }
  }

  return values;
}

function normalizeRecommendationTags(input = {}) {
  const maxCount = Number.isInteger(input.maxCount) && input.maxCount > 0
    ? input.maxCount
    : DEFAULT_MAX_TAGS;
  const rawTags = collectRawTags(input);
  const seenCanonicalTags = new Set();
  const canonicalTags = [];

  for (const rawTag of rawTags) {
    const canonicalTag = toCanonicalTag(rawTag);

    if (!canonicalTag || seenCanonicalTags.has(canonicalTag)) {
      continue;
    }

    seenCanonicalTags.add(canonicalTag);
    canonicalTags.push(canonicalTag);

    if (canonicalTags.length >= maxCount) {
      break;
    }
  }

  logger.info('[AITagNormalizer] normalized', {
    rawCount: rawTags.length,
    canonicalCount: canonicalTags.length
  });

  return {
    rawTags: [...new Set(rawTags)],
    canonicalTags,
    displayTags: canonicalTags.map(readableLabelFromCanonical)
  };
}

module.exports = {
  normalizeRecommendationTags,
  readableLabelFromCanonical,
  toCanonicalTag
};
