const crypto = require('crypto');
const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/error-response');
const aiClient = require('./ai.client');
const { buildSystemPrompt, buildUserPrompt } = require('./ai.prompt');
const {
  inferIntent,
  normalizeRecommendationQuery
} = require('../recommendation/recommendation-ranker');
const { getGameCandidates } = require('../recommendation/game-candidate.provider');
const {
  normalizeLimit,
  validateLlmRecommendationResponse
} = require('./ai.validator');

const DISCLAIMER = 'AI 추천은 참고용이며 실제 취향과 다를 수 있습니다.';
const responseCache = new Map();

function buildRequestId() {
  return `ai-rec-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
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

function normalizeGameIdList(gameIds) {
  return [...new Set((gameIds ?? [])
    .map((gameId) => String(gameId).trim())
    .filter(Boolean))];
}

function buildCacheKey({ userId, query, platforms, preferredGenres, excludedGameIds, limit }) {
  return JSON.stringify({
    userId,
    query,
    platforms: [...(platforms ?? [])].sort(),
    preferredGenres: [...(preferredGenres ?? [])].sort(),
    excludedGameIds: normalizeGameIdList(excludedGameIds).sort(),
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
  if (env.aiRecommendationCacheTtlSeconds <= 0) {
    return;
  }

  responseCache.set(cacheKey, {
    value: JSON.parse(JSON.stringify(value)),
    expiresAt: Date.now() + env.aiRecommendationCacheTtlSeconds * 1000
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
        recommendationCount: 1
      },
      update: {
        recommendationCount: {
          increment: 1
        }
      }
    });

    if (usage.recommendationCount > env.aiRecommendationDailyLimit) {
      throw new AppError(429, 'AI_DAILY_LIMIT_EXCEEDED', 'Daily AI recommendation limit exceeded');
    }
  });
}

function normalizeIntent(rawIntent, fallbackIntent) {
  if (!rawIntent || typeof rawIntent !== 'object') {
    return fallbackIntent;
  }

  return {
    mood: Array.isArray(rawIntent.mood) && rawIntent.mood.length > 0
      ? rawIntent.mood.map((value) => String(value).trim()).filter(Boolean).slice(0, 5)
      : fallbackIntent.mood,
    sessionLength: typeof rawIntent.sessionLength === 'string' ? rawIntent.sessionLength : fallbackIntent.sessionLength,
    playMode: typeof rawIntent.playMode === 'string' ? rawIntent.playMode : fallbackIntent.playMode,
    difficulty: typeof rawIntent.difficulty === 'string' ? rawIntent.difficulty : fallbackIntent.difficulty,
    platforms: Array.isArray(rawIntent.platforms)
      ? rawIntent.platforms.map((value) => String(value).trim()).filter(Boolean).slice(0, 10)
      : fallbackIntent.platforms
  };
}

function assembleResponseItems({ recommendations, candidates }) {
  const candidateMap = new Map(candidates.map((candidate) => [String(candidate.gameId), candidate]));

  return recommendations
    .map((recommendation) => {
      const candidate = candidateMap.get(String(recommendation.gameId));

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
        rating: candidate.rating,
        reason: recommendation.reason,
        matchTags: recommendation.matchTags,
        confidence: recommendation.confidence
      };
    })
    .filter(Boolean);
}

async function writeRecommendationLog({
  userId,
  query,
  normalizedQuery,
  intent,
  items,
  model,
  promptTokens,
  completionTokens,
  latencyMs
}) {
  try {
    await prisma.aiRecommendationLog.create({
      data: {
        userId,
        query,
        normalizedQuery,
        intent,
        resultGameIds: items.map((item) => String(item.gameId)),
        model,
        promptTokens,
        completionTokens,
        latencyMs
      }
    });
  } catch (error) {
    logger.warn('AI recommendation log write failed', {
      userId,
      message: error?.message ?? 'unknown'
    });
  }
}

async function createGameRecommendations({
  userId,
  query,
  platforms = [],
  preferredGenres = [],
  excludedGameIds = [],
  limit
}) {
  const startedAt = Date.now();
  const requestId = buildRequestId();
  const normalizedLimit = normalizeLimit(limit);
  const normalizedExcludedGameIds = normalizeGameIdList(excludedGameIds);
  const cacheKey = buildCacheKey({
    userId,
    query,
    platforms,
    preferredGenres,
    excludedGameIds: normalizedExcludedGameIds,
    limit: normalizedLimit
  });
  const cachedResponse = readCachedResponse(cacheKey);

  if (cachedResponse) {
    const response = {
      ...cachedResponse,
      requestId
    };

    await writeRecommendationLog({
      userId,
      query,
      normalizedQuery: response.normalizedQuery,
      intent: response.intent,
      items: response.items,
      model: 'cache',
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startedAt
    });

    return response;
  }

  const fallbackIntent = inferIntent({ query, platforms });
  const candidates = await getGameCandidates({
    query,
    platforms,
    preferredGenres,
    excludedGameIds: normalizedExcludedGameIds
  });

  if (candidates.length === 0) {
    throw new AppError(404, 'CANDIDATE_NOT_FOUND', 'No candidate games were found for AI recommendation');
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    query,
    platforms,
    preferredGenres,
    excludedGameIds: normalizedExcludedGameIds,
    limit: normalizedLimit,
    candidates
  });
  const llmResult = await aiClient.createChatCompletion({ systemPrompt, userPrompt });
  const validatedResult = validateLlmRecommendationResponse({
    rawContent: llmResult.content,
    candidates,
    limit: normalizedLimit,
    fallbackContext: {
      query,
      platforms,
      preferredGenres
    }
  });
  const intent = normalizeIntent(validatedResult.intent, fallbackIntent);
  const normalizedQuery = validatedResult.normalizedQuery || normalizeRecommendationQuery(query, intent);
  const items = assembleResponseItems({
    recommendations: validatedResult.items,
    candidates
  });
  const usedLlmResult = validatedResult.source === 'llm' && !llmResult.skipped;

  if (!usedLlmResult && !llmResult.skipped) {
    const llmConfig = aiClient.getLlmConfig();

    logger.warn('LLM response rejected; AI recommendation will use fallback ranking', {
      provider: llmConfig.provider,
      model: llmResult.model ?? llmConfig.model,
      status: null,
      timeoutMs: llmConfig.timeoutMs,
      reason: 'invalid_llm_response'
    });
  }

  if (items.length === 0) {
    throw new AppError(500, 'AI_RECOMMENDATION_FAILED', 'AI recommendation failed');
  }

  const responseWithoutRequestId = {
    normalizedQuery,
    intent,
    items,
    disclaimer: DISCLAIMER
  };
  const response = {
    requestId,
    ...responseWithoutRequestId
  };

  writeCachedResponse(cacheKey, responseWithoutRequestId);

  await writeRecommendationLog({
    userId,
    query,
    normalizedQuery,
    intent,
    items,
    model: usedLlmResult ? (llmResult.model ?? env.llmModel) : 'mock-rule-based',
    promptTokens: usedLlmResult ? (llmResult.promptTokens ?? 0) : 0,
    completionTokens: usedLlmResult ? (llmResult.completionTokens ?? 0) : 0,
    latencyMs: Date.now() - startedAt
  });

  return response;
}

module.exports = {
  assertAndIncrementDailyUsage,
  buildCacheKey,
  createGameRecommendations,
  getUsageDate,
  writeRecommendationLog
};
