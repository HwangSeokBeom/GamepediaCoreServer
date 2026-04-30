const MAX_SUMMARY_LENGTH = 240;
const MAX_ITEM_LENGTH = 120;
const MAX_KEYWORD_LENGTH = 24;
const MAX_PROS = 4;
const MAX_CONS = 4;
const MAX_RECOMMENDED_FOR = 3;
const MAX_NOT_RECOMMENDED_FOR = 3;
const MAX_KEYWORDS = 6;

function parseLlmContent(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    return null;
  }

  const trimmedContent = rawContent.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(trimmedContent);
  } catch (error) {
    return null;
  }
}

function truncateText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  const normalizedValue = value.trim().replace(/\s+/g, ' ');

  if (!normalizedValue) {
    return '';
  }

  return normalizedValue.length > maxLength
    ? normalizedValue.slice(0, maxLength).trim()
    : normalizedValue;
}

function sanitizeTextList(value, {
  maxItems,
  maxLength,
  fallback = []
}) {
  const sourceItems = Array.isArray(value) ? value : fallback;
  const seen = new Set();
  const items = [];

  for (const item of sourceItems) {
    const normalizedItem = truncateText(item, maxLength);

    if (!normalizedItem || seen.has(normalizedItem)) {
      continue;
    }

    seen.add(normalizedItem);
    items.push(normalizedItem);

    if (items.length >= maxItems) {
      break;
    }
  }

  return items;
}

function validateLlmReviewSummaryResponse({ rawContent, fallbackSummary }) {
  const payload = parseLlmContent(rawContent);

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      source: 'fallback',
      value: fallbackSummary
    };
  }

  const summary = truncateText(payload.summary, MAX_SUMMARY_LENGTH);

  if (!summary) {
    return {
      source: 'fallback',
      value: fallbackSummary
    };
  }

  return {
    source: 'llm',
    value: {
      summary,
      pros: sanitizeTextList(payload.pros, {
        maxItems: MAX_PROS,
        maxLength: MAX_ITEM_LENGTH,
        fallback: fallbackSummary.pros
      }),
      cons: sanitizeTextList(payload.cons, {
        maxItems: MAX_CONS,
        maxLength: MAX_ITEM_LENGTH,
        fallback: fallbackSummary.cons
      }),
      recommendedFor: sanitizeTextList(payload.recommendedFor, {
        maxItems: MAX_RECOMMENDED_FOR,
        maxLength: MAX_ITEM_LENGTH,
        fallback: fallbackSummary.recommendedFor
      }),
      notRecommendedFor: sanitizeTextList(payload.notRecommendedFor, {
        maxItems: MAX_NOT_RECOMMENDED_FOR,
        maxLength: MAX_ITEM_LENGTH,
        fallback: fallbackSummary.notRecommendedFor
      }),
      keywords: sanitizeTextList(payload.keywords, {
        maxItems: MAX_KEYWORDS,
        maxLength: MAX_KEYWORD_LENGTH,
        fallback: fallbackSummary.keywords
      })
    }
  };
}

module.exports = {
  MAX_CONS,
  MAX_KEYWORDS,
  MAX_NOT_RECOMMENDED_FOR,
  MAX_PROS,
  MAX_RECOMMENDED_FOR,
  validateLlmReviewSummaryResponse
};
