const {
  buildMatchReason,
  buildMatchTags,
  buildSuggestedQueries,
  inferSearchIntent,
  normalizeSearchQuery,
  rankSearchCandidates
} = require('../recommendation/search-assist-ranker');

const MIN_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_MATCH_REASON_LENGTH = 160;
const MAX_MATCH_TAGS = 4;
const MAX_SUGGESTED_QUERIES = 5;
const INTENT_KEYS = new Set([
  'mood',
  'sessionLength',
  'playMode',
  'difficulty',
  'platforms',
  'genres',
  'keywords'
]);

function normalizeLimit(limit) {
  const numericLimit = Number(limit);

  if (!Number.isInteger(numericLimit)) {
    return 10;
  }

  return Math.min(Math.max(numericLimit, MIN_LIMIT), MAX_LIMIT);
}

function clampConfidence(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0.65;
  }

  return Math.min(Math.max(numericValue, 0), 1);
}

function truncateText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmedValue = value.trim().replace(/\s+/g, ' ');

  return trimmedValue.length > maxLength ? trimmedValue.slice(0, maxLength) : trimmedValue;
}

function normalizeStringList(values, { maxItems, maxLength }) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seenValues = new Set();
  const normalizedValues = [];

  for (const value of values) {
    const normalizedValue = truncateText(value, maxLength);

    if (!normalizedValue || seenValues.has(normalizedValue)) {
      continue;
    }

    seenValues.add(normalizedValue);
    normalizedValues.push(normalizedValue);
  }

  return normalizedValues.slice(0, maxItems);
}

function parseLlmContent(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    return null;
  }

  try {
    return JSON.parse(rawContent);
  } catch (error) {
    return null;
  }
}

function normalizeIntent(rawIntent, fallbackIntent) {
  if (!rawIntent || typeof rawIntent !== 'object') {
    return fallbackIntent;
  }

  const normalizedIntent = { ...fallbackIntent };

  for (const key of INTENT_KEYS) {
    const value = rawIntent[key];

    if (Array.isArray(value)) {
      normalizedIntent[key] = normalizeStringList(value, {
        maxItems: key === 'keywords' ? 10 : 8,
        maxLength: 40
      });
      continue;
    }

    if (typeof value === 'string' && ['sessionLength', 'playMode', 'difficulty'].includes(key)) {
      normalizedIntent[key] = truncateText(value, 30) || fallbackIntent[key];
    }
  }

  return normalizedIntent;
}

function normalizeSuggestedQueries(value, fallbackSuggestedQueries) {
  const normalizedQueries = normalizeStringList(value, {
    maxItems: MAX_SUGGESTED_QUERIES,
    maxLength: 60
  }).filter((suggestion) => suggestion.length >= 2);

  return normalizedQueries.length > 0
    ? normalizedQueries
    : fallbackSuggestedQueries;
}

function getRawItems(payload) {
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  return [];
}

function sanitizeSearchItems({
  rawItems,
  candidates,
  limit,
  fallbackItems,
  fallbackContext,
  intent
}) {
  const candidateMap = new Map(candidates.map((candidate) => [String(candidate.gameId), candidate]));
  const fallbackItemMap = new Map(fallbackItems.map((item) => [String(item.gameId), item]));
  const seenIds = new Set();
  const items = [];

  for (const item of rawItems ?? []) {
    const gameId = String(item?.gameId ?? '').trim();

    if (!candidateMap.has(gameId) || seenIds.has(gameId)) {
      continue;
    }

    seenIds.add(gameId);

    const candidate = candidateMap.get(gameId);
    const fallbackItem = fallbackItemMap.get(gameId);
    const fallbackReason = fallbackItem?.matchReason ?? buildMatchReason({ candidate, intent });
    const fallbackTags = fallbackItem?.matchTags ?? buildMatchTags({
      candidate,
      query: fallbackContext.query,
      platforms: fallbackContext.platforms,
      genres: fallbackContext.genres,
      intent
    });
    const matchReason = truncateText(item?.matchReason ?? item?.reason, MAX_MATCH_REASON_LENGTH) || fallbackReason;
    const matchTags = normalizeStringList(item?.matchTags, {
      maxItems: MAX_MATCH_TAGS,
      maxLength: 24
    });

    items.push({
      gameId,
      matchReason,
      matchTags: matchTags.length > 0 ? matchTags : fallbackTags,
      confidence: clampConfidence(item?.confidence)
    });

    if (items.length >= limit) {
      break;
    }
  }

  return items;
}

function validateLlmSearchAssistResponse({
  rawContent,
  candidates,
  limit,
  fallbackContext
}) {
  const normalizedLimit = normalizeLimit(limit);
  const fallbackIntent = inferSearchIntent(fallbackContext);
  const fallbackSuggestedQueries = buildSuggestedQueries({
    query: fallbackContext.query,
    intent: fallbackIntent
  });
  const fallbackItems = rankSearchCandidates({
    candidates,
    query: fallbackContext.query,
    platforms: fallbackContext.platforms,
    genres: fallbackContext.genres,
    limit: normalizedLimit
  });
  const payload = parseLlmContent(rawContent);

  if (!payload) {
    return {
      source: 'fallback',
      normalizedQuery: normalizeSearchQuery(fallbackContext.query, fallbackIntent),
      intent: fallbackIntent,
      suggestedQueries: fallbackSuggestedQueries,
      items: fallbackItems
    };
  }

  const intent = normalizeIntent(payload.intent, fallbackIntent);
  const items = sanitizeSearchItems({
    rawItems: getRawItems(payload),
    candidates,
    limit: normalizedLimit,
    fallbackItems,
    fallbackContext,
    intent
  });
  const normalizedQuery = truncateText(payload.normalizedQuery, 120) || normalizeSearchQuery(fallbackContext.query, intent);
  const suggestedQueries = normalizeSuggestedQueries(payload.suggestedQueries, buildSuggestedQueries({
    query: fallbackContext.query,
    intent
  }));

  if (items.length === 0) {
    return {
      source: 'fallback',
      normalizedQuery,
      intent,
      suggestedQueries,
      items: fallbackItems
    };
  }

  return {
    source: 'llm',
    normalizedQuery,
    intent,
    suggestedQueries,
    items
  };
}

module.exports = {
  MAX_LIMIT,
  MIN_LIMIT,
  normalizeIntent,
  normalizeLimit,
  normalizeSuggestedQueries,
  sanitizeSearchItems,
  validateLlmSearchAssistResponse
};
