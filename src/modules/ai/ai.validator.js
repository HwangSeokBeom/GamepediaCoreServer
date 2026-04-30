const { rankCandidates } = require('../recommendation/recommendation-ranker');

const MIN_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_REASON_LENGTH = 160;
const MAX_MATCH_TAGS = 4;
const MAX_REVIEW_SUMMARY_LENGTH = 300;
const MAX_REVIEW_LIST_ITEMS = 8;

function normalizeLimit(limit) {
  const numericLimit = Number(limit);

  if (!Number.isInteger(numericLimit)) {
    return MAX_LIMIT;
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

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenTags = new Set();
  const tags = [];

  for (const tag of value) {
    const normalizedTag = truncateText(tag, 24);

    if (!normalizedTag || seenTags.has(normalizedTag)) {
      continue;
    }

    seenTags.add(normalizedTag);
    tags.push(normalizedTag);
  }

  return tags.slice(0, MAX_MATCH_TAGS);
}

function normalizeTextList(value, { maxItems = MAX_REVIEW_LIST_ITEMS, maxLength = 40 } = {}) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenItems = new Set();
  const items = [];

  for (const item of value) {
    const normalizedItem = truncateText(item, maxLength);

    if (!normalizedItem || seenItems.has(normalizedItem)) {
      continue;
    }

    seenItems.add(normalizedItem);
    items.push(normalizedItem);

    if (items.length >= maxItems) {
      break;
    }
  }

  return items;
}

function parseLlmContent(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    return null;
  }

  const trimmedContent = rawContent.trim();
  const fencedJsonMatch = trimmedContent.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidates = [
    trimmedContent,
    fencedJsonMatch?.[1]?.trim(),
    extractFirstJsonObject(trimmedContent)
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // Try the next candidate shape.
    }
  }

  return null;
}

function extractFirstJsonObject(value) {
  const startIndex = value.indexOf('{');

  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    }

    if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        return value.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function getRawItems(payload) {
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  if (Array.isArray(payload?.recommendations)) {
    return payload.recommendations;
  }

  return [];
}

function sanitizeRecommendationItems({
  rawItems,
  candidates,
  limit,
  fallbackItems = []
}) {
  const candidateIds = new Set(candidates.map((candidate) => String(candidate.gameId)));
  const fallbackItemMap = new Map(fallbackItems.map((item) => [String(item.gameId), item]));
  const seenIds = new Set();
  const items = [];

  for (const item of rawItems ?? []) {
    const gameId = String(item?.gameId ?? '').trim();

    if (!candidateIds.has(gameId) || seenIds.has(gameId)) {
      continue;
    }

    seenIds.add(gameId);
    const fallbackItem = fallbackItemMap.get(gameId);
    const reason = truncateText(item?.reason, MAX_REASON_LENGTH) || fallbackItem?.reason || '요청한 조건과 잘 맞는 후보 게임입니다.';
    const matchTags = normalizeTags(item?.matchTags);

    items.push({
      gameId,
      reason,
      matchTags: matchTags.length > 0 ? matchTags : fallbackItem?.matchTags ?? [],
      confidence: clampConfidence(item?.confidence)
    });

    if (items.length >= limit) {
      break;
    }
  }

  return items;
}

function validateLlmRecommendationResponse({
  rawContent,
  candidates,
  limit,
  fallbackContext
}) {
  const normalizedLimit = normalizeLimit(limit);
  const payload = parseLlmContent(rawContent);
  const fallbackItems = rankCandidates({
    candidates,
    query: fallbackContext.query,
    platforms: fallbackContext.platforms,
    preferredGenres: fallbackContext.preferredGenres,
    limit: normalizedLimit
  });

  if (!payload) {
    return {
      source: 'fallback',
      normalizedQuery: null,
      intent: null,
      items: fallbackItems
    };
  }

  const items = sanitizeRecommendationItems({
    rawItems: getRawItems(payload),
    candidates,
    limit: normalizedLimit,
    fallbackItems
  });

  if (items.length === 0) {
    return {
      source: 'fallback',
      normalizedQuery: typeof payload.normalizedQuery === 'string' ? payload.normalizedQuery.trim() : null,
      intent: payload.intent ?? null,
      items: fallbackItems
    };
  }

  return {
    source: 'llm',
    normalizedQuery: typeof payload.normalizedQuery === 'string' ? payload.normalizedQuery.trim() : null,
    intent: payload.intent ?? null,
    items
  };
}

function validateLlmReviewSummaryResponse({
  rawContent,
  reviewCount
}) {
  const payload = parseLlmContent(rawContent);

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const summary = truncateText(
    payload.summary ?? [payload.headline, payload.overview].filter(Boolean).join(' '),
    MAX_REVIEW_SUMMARY_LENGTH
  );

  if (!summary) {
    return null;
  }

  return {
    summary,
    highlights: normalizeTextList(payload.highlights ?? payload.keywords, { maxItems: 5, maxLength: 40 }),
    pros: normalizeTextList(payload.pros, { maxItems: 5, maxLength: 40 }),
    cons: normalizeTextList(payload.cons, { maxItems: 5, maxLength: 40 }),
    reviewCount
  };
}

module.exports = {
  MAX_LIMIT,
  MIN_LIMIT,
  normalizeLimit,
  sanitizeRecommendationItems,
  validateLlmReviewSummaryResponse,
  validateLlmRecommendationResponse
};
