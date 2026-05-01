const { z } = require('zod');

const MAX_SUMMARY_BULLETS = 5;
const MAX_MATCH_TAGS = 5;
const MAX_REASON_LENGTH = 220;
const MAX_TEXT_LENGTH = 240;

const libraryCuratorLlmSchema = z.object({
  summary: z.object({
    title: z.string(),
    body: z.string(),
    bullets: z.array(z.string()).max(MAX_SUMMARY_BULLETS).optional().default([])
  }),
  tasteProfile: z.object({
    topGenres: z.array(z.string()).optional().default([]),
    topThemes: z.array(z.string()).optional().default([]),
    preferredSession: z.enum(['short', 'medium', 'long', 'unknown']),
    playStyleTags: z.array(z.string()).optional().default([]),
    ratingStyle: z.string().nullable().optional().default(null)
  }),
  sections: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    items: z.array(z.object({
      gameId: z.string(),
      reason: z.string(),
      matchTags: z.array(z.string()).max(MAX_MATCH_TAGS).optional().default([]),
      confidence: z.number()
    })).optional().default([])
  })).optional().default([])
}).strict();

function normalizeText(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') {
    return '';
  }

  const normalizedValue = value.trim().replace(/\s+/g, ' ');
  return normalizedValue.length > maxLength ? normalizedValue.slice(0, maxLength) : normalizedValue;
}

function normalizeTextList(values, { maxItems = 8, maxLength = 40 } = {}) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalizedValue = normalizeText(value, maxLength);

    if (!normalizedValue || seen.has(normalizedValue)) {
      continue;
    }

    seen.add(normalizedValue);
    result.push(normalizedValue);

    if (result.length >= maxItems) {
      break;
    }
  }

  return result;
}

function clampConfidence(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0.6;
  }

  return Math.min(Math.max(numericValue, 0), 1);
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
    } else if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        return value.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function parseLlmJson(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    return {
      ok: false,
      reason: 'LLM_INVALID_JSON',
      payload: null
    };
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
      return {
        ok: true,
        reason: null,
        payload: JSON.parse(candidate)
      };
    } catch (error) {
      // Try the next parse candidate.
    }
  }

  return {
    ok: false,
    reason: 'LLM_INVALID_JSON',
    payload: null
  };
}

function normalizeSummary(summary, localeText) {
  return {
    title: normalizeText(summary?.title, 80) || localeText.fallbackTitle,
    body: normalizeText(summary?.body, 400) || localeText.fallbackBody,
    bullets: normalizeTextList(summary?.bullets, { maxItems: MAX_SUMMARY_BULLETS, maxLength: 90 })
  };
}

function normalizeTasteProfile(profile) {
  return {
    topGenres: normalizeTextList(profile?.topGenres, { maxItems: 6, maxLength: 40 }),
    topThemes: normalizeTextList(profile?.topThemes, { maxItems: 6, maxLength: 40 }),
    preferredSession: ['short', 'medium', 'long', 'unknown'].includes(profile?.preferredSession)
      ? profile.preferredSession
      : 'unknown',
    playStyleTags: normalizeTextList(profile?.playStyleTags, { maxItems: 8, maxLength: 40 }),
    ratingStyle: profile?.ratingStyle == null ? null : (normalizeText(profile.ratingStyle, 100) || null)
  };
}

function validateLlmLibraryCuratorResponse({
  rawContent,
  candidates,
  limit,
  localeText
}) {
  const parsed = parseLlmJson(rawContent);

  if (!parsed.ok) {
    return {
      source: 'fallback',
      fallbackReason: parsed.reason,
      data: null
    };
  }

  const schemaResult = libraryCuratorLlmSchema.safeParse(parsed.payload);

  if (!schemaResult.success) {
    return {
      source: 'fallback',
      fallbackReason: 'LLM_SCHEMA_INVALID',
      data: null,
      issues: schemaResult.error.issues
    };
  }

  const candidateIds = new Set((candidates ?? []).map((candidate) => String(candidate.gameId)));
  const seenGameIds = new Set();
  const sections = [];
  let selectedCount = 0;
  let llmSelectedCount = 0;
  let removedOutOfScope = 0;
  let removedDuplicate = 0;

  for (const section of schemaResult.data.sections ?? []) {
    const items = [];

    for (const item of section.items ?? []) {
      llmSelectedCount += 1;
      const gameId = normalizeText(item.gameId, 100);

      if (!candidateIds.has(gameId)) {
        removedOutOfScope += 1;
        continue;
      }

      if (seenGameIds.has(gameId)) {
        removedDuplicate += 1;
        continue;
      }

      seenGameIds.add(gameId);
      selectedCount += 1;
      items.push({
        gameId,
        reason: normalizeText(item.reason, MAX_REASON_LENGTH) || localeText.defaultReason,
        matchTags: normalizeTextList(item.matchTags, { maxItems: MAX_MATCH_TAGS, maxLength: 32 }),
        confidence: clampConfidence(item.confidence)
      });

      if (selectedCount >= limit) {
        break;
      }
    }

    if (items.length > 0) {
      sections.push({
        id: normalizeText(section.id, 50) || 'curator',
        title: normalizeText(section.title, 80) || localeText.sectionTitle,
        description: normalizeText(section.description, 180) || localeText.sectionDescription,
        items
      });
    }

    if (selectedCount >= limit) {
      break;
    }
  }

  if (selectedCount === 0) {
    return {
      source: 'fallback',
      fallbackReason: 'LLM_EMPTY_SELECTION',
      data: null
    };
  }

  return {
    source: 'llm',
    fallbackReason: null,
    data: {
      summary: normalizeSummary(schemaResult.data.summary, localeText),
      tasteProfile: normalizeTasteProfile(schemaResult.data.tasteProfile),
      sections
    },
    validation: {
      llmSelectedCount,
      removedOutOfScope,
      removedDuplicate,
      validatedSelectionCount: selectedCount
    }
  };
}

module.exports = {
  clampConfidence,
  normalizeTasteProfile,
  normalizeText,
  normalizeTextList,
  parseLlmJson,
  validateLlmLibraryCuratorResponse
};
