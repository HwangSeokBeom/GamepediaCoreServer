const crypto = require('crypto');
const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/error-response');
const aiClient = require('./ai.client');
const {
  buildSearchAssistSystemPrompt,
  buildSearchAssistUserPrompt
} = require('./ai-search-assist.prompt');
const { getSearchCandidates } = require('../recommendation/search-candidate.provider');
const {
  buildSuggestedQueries,
  inferSearchIntent
} = require('../recommendation/search-assist-ranker');
const {
  normalizeLimit,
  validateLlmSearchAssistResponse
} = require('./ai-search-assist.validator');

const DISCLAIMER = 'AI 검색 보조 결과는 참고용이며 실제 검색 결과와 다를 수 있습니다.';
const responseCache = new Map();

function buildRequestId() {
  return `ai-search-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function getUsageDate({ now = new Date(), timeZone = 'Asia/Seoul' } = {}) {
  const usageDateText = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  return new Date(`${usageDateText}T00:00:00.000Z`);
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean);
}

function buildCacheKey({ userId, query, platforms, genres, limit }) {
  return JSON.stringify({
    userId,
    query,
    platforms: [...normalizeStringList(platforms)].sort(),
    genres: [...normalizeStringList(genres)].sort(),
    limit
  });
}

function readCachedResponse(cacheKey) {
  const cached = responseCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(cacheKey);
    return null;
  }

  return JSON.parse(JSON.stringify(cached.value));
}

function writeCachedResponse(cacheKey, value) {
  if (env.aiSearchCacheTtlSeconds <= 0) {
    return;
  }

  responseCache.set(cacheKey, {
    value: JSON.parse(JSON.stringify(value)),
    expiresAt: Date.now() + env.aiSearchCacheTtlSeconds * 1000
  });
}

async function assertAndIncrementDailyUsage({ userId }) {
  const usageDate = getUsageDate();

  await prisma.$transaction(async (tx) => {
    const usage = await tx.aiUsageLimit.upsert({
      where: {
        userId_usageDate: {
          userId,
          usageDate
        }
      },
      create: {
        userId,
        usageDate,
        searchAssistCount: 1
      },
      update: {
        searchAssistCount: {
          increment: 1
        }
      }
    });

    if (usage.searchAssistCount > env.aiSearchDailyLimit) {
      throw new AppError(429, 'AI_SEARCH_DAILY_LIMIT_EXCEEDED', 'Daily AI search assist limit exceeded');
    }
  });
}

function assembleResponseItems({ items, candidates }) {
  const candidateMap = new Map(candidates.map((candidate) => [String(candidate.gameId), candidate]));

  return items
    .map((item) => {
      const candidate = candidateMap.get(String(item.gameId));

      if (!candidate) {
        return null;
      }

      const numericGameId = Number(candidate.gameId);

      if (!Number.isSafeInteger(numericGameId) || numericGameId <= 0) {
        return null;
      }

      return {
        gameId: numericGameId,
        title: candidate.title,
        coverUrl: candidate.coverUrl,
        platforms: candidate.platforms,
        genres: candidate.genres,
        themes: candidate.themes ?? [],
        keywords: candidate.keywords ?? [],
        rating: candidate.rating,
        matchReason: item.matchReason,
        reason: item.matchReason,
        rawMatchTags: item.rawMatchTags ?? [],
        canonicalTags: item.canonicalTags ?? [],
        matchTags: item.matchTags,
        displayTags: item.displayTags ?? [],
        confidence: item.confidence,
        source: item.source === 'fallback' ? 'fallback' : 'llm'
      };
    })
    .filter(Boolean);
}

async function writeSearchLog({
  userId,
  query,
  normalizedQuery,
  intent,
  items,
  model,
  promptTokens,
  completionTokens,
  latencyMs,
  fallbackUsed
}) {
  try {
    await prisma.aiSearchLog.create({
      data: {
        userId,
        query,
        normalizedQuery,
        intent,
        resultGameIds: items.map((item) => Number(item.gameId)).filter((gameId) => Number.isSafeInteger(gameId)),
        model,
        promptTokens,
        completionTokens,
        latencyMs,
        fallbackUsed
      }
    });
  } catch (error) {
    logger.warn('AI search assist log write failed', {
      userId,
      message: error?.message ?? 'unknown'
    });
  }
}

async function createSearchAssist({
  userId,
  query,
  platforms = [],
  genres = [],
  limit
}) {
  const startedAt = Date.now();
  const requestId = buildRequestId();
  const normalizedLimit = normalizeLimit(limit);
  const normalizedPlatforms = normalizeStringList(platforms);
  const normalizedGenres = normalizeStringList(genres);
  const cacheKey = buildCacheKey({
    userId,
    query,
    platforms: normalizedPlatforms,
    genres: normalizedGenres,
    limit: normalizedLimit
  });
  const cachedResponse = readCachedResponse(cacheKey);

  if (cachedResponse) {
    const response = {
      ...cachedResponse,
      requestId
    };

    await writeSearchLog({
      userId,
      query,
      normalizedQuery: response.normalizedQuery,
      intent: response.intent,
      items: response.items,
      model: 'cache',
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startedAt,
      fallbackUsed: response.fallbackUsed
    });

    return response;
  }

  const fallbackIntent = inferSearchIntent({
    query,
    platforms: normalizedPlatforms,
    genres: normalizedGenres
  });
  const fallbackSuggestedQueries = buildSuggestedQueries({ query, intent: fallbackIntent });
  const candidates = await getSearchCandidates({
    query,
    platforms: normalizedPlatforms,
    genres: normalizedGenres,
    targetCount: 50
  });

  if (candidates.length === 0) {
    throw new AppError(404, 'CANDIDATE_NOT_FOUND', 'No candidate games were found for AI search assist', {
      suggestedQueries: fallbackSuggestedQueries
    });
  }

  const systemPrompt = buildSearchAssistSystemPrompt();
  const userPrompt = buildSearchAssistUserPrompt({
    query,
    platforms: normalizedPlatforms,
    genres: normalizedGenres,
    limit: normalizedLimit,
    candidates
  });
  const llmResult = await aiClient.createChatCompletion({ systemPrompt, userPrompt });
  const validatedResult = validateLlmSearchAssistResponse({
    rawContent: llmResult.content,
    candidates,
    limit: normalizedLimit,
    fallbackContext: {
      query,
      platforms: normalizedPlatforms,
      genres: normalizedGenres
    }
  });
  const usedLlmResult = validatedResult.source === 'llm' && !llmResult.skipped;
  const fallbackUsed = !usedLlmResult;

  if (!usedLlmResult && !llmResult.skipped) {
    const llmConfig = aiClient.getLlmConfig();

    logger.warn('LLM response rejected; AI search assist will use fallback ranking', {
      provider: llmConfig.provider,
      model: llmResult.model ?? llmConfig.model,
      status: null,
      timeoutMs: llmConfig.timeoutMs,
      reason: 'invalid_llm_response'
    });
  }

  const items = assembleResponseItems({
    items: validatedResult.items,
    candidates
  });

  logger.info('[AISearchAssist] response tags normalized', {
    itemCount: items.length,
    fallbackUsed
  });

  if (items.length === 0) {
    throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'AI search assist failed');
  }

  const responseWithoutRequestId = {
    originalQuery: query,
    normalizedQuery: validatedResult.normalizedQuery,
    intent: validatedResult.intent,
    suggestedQueries: validatedResult.suggestedQueries,
    items,
    fallbackUsed,
    disclaimer: DISCLAIMER
  };
  const response = {
    requestId,
    ...responseWithoutRequestId
  };

  writeCachedResponse(cacheKey, responseWithoutRequestId);

  await writeSearchLog({
    userId,
    query,
    normalizedQuery: response.normalizedQuery,
    intent: response.intent,
    items,
    model: usedLlmResult ? (llmResult.model ?? env.llmModel) : 'mock-rule-based',
    promptTokens: usedLlmResult ? (llmResult.promptTokens ?? 0) : 0,
    completionTokens: usedLlmResult ? (llmResult.completionTokens ?? 0) : 0,
    latencyMs: Date.now() - startedAt,
    fallbackUsed
  });

  return response;
}

module.exports = {
  assertAndIncrementDailyUsage,
  buildCacheKey,
  createSearchAssist,
  getUsageDate,
  writeSearchLog
};
