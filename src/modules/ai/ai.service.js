const crypto = require('crypto');
const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/error-response');
const aiClient = require('./ai.client');
const {
  buildReviewSummarySystemPrompt,
  buildReviewSummaryUserPrompt,
  buildSystemPrompt,
  buildUserPrompt
} = require('./ai.prompt');
const {
  inferIntent,
  normalizeRecommendationQuery,
  rankCandidateDetails
} = require('../recommendation/recommendation-ranker');
const { getGameCandidates } = require('../recommendation/game-candidate.provider');
const {
  applyGameMetadataToProfile,
  buildUserPreferenceProfile,
  createEmptyPreferenceProfile,
  sanitizePreferenceProfileForPrompt
} = require('../recommendation/user-personalization.service');
const {
  normalizeLimit,
  validateLlmReviewSummaryResponse,
  validateLlmRecommendationResponse
} = require('./ai.validator');

const DISCLAIMER = 'AI 추천은 참고용이며 실제 취향과 다를 수 있습니다.';
const REVIEW_SUMMARY_SAMPLE_LIMIT = 30;
const REVIEW_SUMMARY_MIN_LLM_REVIEWS = 3;
const REVIEW_SUMMARY_FALLBACK_TEXT = 'AI 요약을 일시적으로 생성하지 못했어요. 등록된 리뷰를 기준으로 다시 시도할 수 있습니다.';
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

function buildCacheKey({
  userId,
  query,
  platforms,
  preferredGenres,
  excludedGameIds,
  limit,
  personalization = true,
  includeOwned = false,
  includeReviewed = false,
  includeFavorites = false
}) {
  return JSON.stringify({
    userId,
    query,
    platforms: [...(platforms ?? [])].sort(),
    preferredGenres: [...(preferredGenres ?? [])].sort(),
    excludedGameIds: normalizeGameIdList(excludedGameIds).sort(),
    limit,
    personalization,
    includeOwned,
    includeReviewed,
    includeFavorites
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

function assembleResponseItems({
  recommendations,
  candidates,
  personalized,
  fallbackUsed,
  recommendationSource
}) {
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
        name: candidate.title,
        coverUrl: candidate.coverUrl,
        imageUrl: candidate.coverUrl,
        platforms: candidate.platforms,
        genres: candidate.genres,
        themes: candidate.themes ?? [],
        keywords: candidate.keywords ?? [],
        rating: candidate.rating,
        reason: recommendation.reason,
        rawMatchTags: recommendation.rawMatchTags ?? [],
        canonicalTags: recommendation.canonicalTags ?? [],
        matchTags: recommendation.matchTags,
        displayTags: recommendation.displayTags ?? [],
        confidence: recommendation.confidence,
        source: recommendation.source === 'fallback' ? 'rule_based' : 'llm',
        recommendationSource,
        personalized,
        fallbackUsed
      };
    })
    .filter(Boolean);
}

function buildKnownGameIdsForRequest(profile, {
  includeOwned = false,
  includeReviewed = false,
  includeFavorites = false
}) {
  return normalizeGameIdList([
    ...(!includeOwned ? profile.ownedGameIds ?? [] : []),
    ...(!includeReviewed ? profile.reviewedGameIds ?? [] : []),
    ...(!includeFavorites ? profile.likedGameIds ?? [] : [])
  ]);
}

function filterKnownCandidates(candidates, knownGameIds) {
  const knownGameIdSet = new Set(normalizeGameIdList(knownGameIds));
  const filteredCandidates = (candidates ?? []).filter((candidate) => !knownGameIdSet.has(String(candidate.gameId)));

  return filteredCandidates.length > 0 ? filteredCandidates : candidates;
}

function buildFallbackLlmResult() {
  return {
    content: null,
    model: 'mock-rule-based',
    promptTokens: 0,
    completionTokens: 0,
    skipped: true
  };
}

function getTopCandidateIds(candidates, limit = 5) {
  return candidates.slice(0, limit).map((candidate) => String(candidate.gameId));
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
        query: `sha256:${crypto.createHash('sha256').update(String(query)).digest('hex')}`,
        normalizedQuery: `sha256:${crypto.createHash('sha256').update(String(normalizedQuery)).digest('hex')}`,
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
  limit,
  personalization = true,
  includeOwned = false,
  includeReviewed = false,
  includeFavorites = false
}) {
  const startedAt = Date.now();
  const requestId = buildRequestId();
  const normalizedLimit = normalizeLimit(limit);
  const normalizedExcludedGameIds = normalizeGameIdList(excludedGameIds);
  const personalizationRequested = personalization !== false;

  logger.info('AI recommendation request started', {
    userId,
    queryLength: typeof query === 'string' ? query.length : 0,
    limit: normalizedLimit,
    personalizationRequested,
    excludedCount: normalizedExcludedGameIds.length
  });

  const cacheKey = buildCacheKey({
    userId,
    query,
    platforms,
    preferredGenres,
    excludedGameIds: normalizedExcludedGameIds,
    limit: normalizedLimit,
    personalization: personalizationRequested,
    includeOwned,
    includeReviewed,
    includeFavorites
  });
  const cachedResponse = readCachedResponse(cacheKey);

  if (cachedResponse) {
    const response = {
      ...cachedResponse,
      requestId,
      meta: {
        ...(cachedResponse.meta ?? {}),
        source: 'cache'
      }
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
  const profileStartedAt = Date.now();
  let initialPersonalizationProfile = createEmptyPreferenceProfile(userId);

  if (personalizationRequested) {
    try {
      initialPersonalizationProfile = await buildUserPreferenceProfile({ userId });
    } catch (error) {
      logger.warn('AI personalization profile unavailable; using generic ranking', {
        userId,
        code: error?.code ?? null
      });
    }
  }
  const candidateStartedAt = Date.now();
  const rawCandidates = await getGameCandidates({
    query,
    platforms,
    preferredGenres,
    excludedGameIds: normalizedExcludedGameIds
  });
  const personalizationProfile = personalizationRequested
    ? applyGameMetadataToProfile(initialPersonalizationProfile, rawCandidates)
    : initialPersonalizationProfile;
  const knownGameIdsForPenalty = buildKnownGameIdsForRequest(personalizationProfile, {
    includeOwned,
    includeReviewed,
    includeFavorites
  });
  const candidates = filterKnownCandidates(rawCandidates, knownGameIdsForPenalty);

  logger.info('AI recommendation candidates generated', {
    userId,
    candidateCount: rawCandidates.length,
    afterExcludedCount: candidates.length,
    personalizedBoostApplied: personalizationRequested && personalizationProfile.personalizationAvailable,
    topCandidateIds: getTopCandidateIds(candidates),
    elapsedMs: Date.now() - candidateStartedAt,
    profileElapsedMs: candidateStartedAt - profileStartedAt
  });

  if (candidates.length === 0) {
    throw new AppError(404, 'CANDIDATE_NOT_FOUND', 'No candidate games were found for AI recommendation');
  }

  const rankedCandidates = rankCandidateDetails({
    candidates,
    query,
    platforms,
    preferredGenres,
    personalizationProfile,
    knownGameIdsForPenalty
  });
  const candidatesForLlm = rankedCandidates.map((detail) => ({
    ...detail.candidate,
    score: Math.round(detail.score * 1000) / 1000,
    scoreBreakdown: detail.scoreBreakdown,
    personalizationSignals: detail.personalizationSignals,
    matchedUserSignals: detail.matchedUserSignals,
    candidateSource: detail.candidateSource
  }));
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    query,
    platforms,
    preferredGenres,
    excludedGameIds: normalizedExcludedGameIds,
    limit: normalizedLimit,
    candidates: candidatesForLlm,
    normalizedIntent: fallbackIntent,
    userPreferenceProfile: sanitizePreferenceProfileForPrompt(personalizationProfile)
  });
  let llmResult;
  const llmStartedAt = Date.now();

  try {
    llmResult = await aiClient.createChatCompletion({ systemPrompt, userPrompt });
  } catch (error) {
    logger.warn('LLM request threw; AI recommendation will use fallback', {
      userId,
      message: error?.message ?? 'unknown'
    });
    llmResult = buildFallbackLlmResult();
  }

  const validatedResult = validateLlmRecommendationResponse({
    rawContent: llmResult.content,
    candidates: candidatesForLlm,
    limit: normalizedLimit,
    fallbackContext: {
      query,
      platforms,
      preferredGenres,
      personalizationProfile,
      knownGameIdsForPenalty
    }
  });
  const intent = normalizeIntent(validatedResult.intent, fallbackIntent);
  const normalizedQuery = validatedResult.normalizedQuery || normalizeRecommendationQuery(query, intent);
  const fallbackUsed = validatedResult.source !== 'llm' || llmResult.skipped;
  const recommendationSource = fallbackUsed ? 'rule_based_fallback' : 'llm';
  const items = assembleResponseItems({
    recommendations: validatedResult.items,
    candidates: candidatesForLlm,
    personalized: personalizationRequested && personalizationProfile.personalizationAvailable,
    fallbackUsed,
    recommendationSource
  });

  logger.info('[AIRecommendation] response tags normalized', {
    itemCount: items.length,
    fallbackUsed,
    source: recommendationSource
  });

  if (fallbackUsed) {
    logger.info('[AIRecommendation] fallback tags normalized', {
      itemCount: items.length
    });
  }
  const usedLlmResult = validatedResult.source === 'llm' && !llmResult.skipped;
  const llmConfig = aiClient.getLlmConfig();

  if (!usedLlmResult && !llmResult.skipped) {
    logger.warn('LLM response rejected; AI recommendation will use fallback ranking', {
      provider: llmConfig.provider,
      model: llmResult.model ?? llmConfig.model,
      status: null,
      timeoutMs: llmConfig.timeoutMs,
      latencyMs: Date.now() - llmStartedAt,
      fallbackUsed: true,
      validationErrorReason: validatedResult.validationErrorReason ?? 'invalid_llm_response'
    });
  }

  logger.info('AI recommendation LLM completed', {
    provider: llmConfig.provider,
    model: llmResult.model ?? llmConfig.model,
    timeoutMs: llmConfig.timeoutMs,
    status: usedLlmResult ? 'success' : (llmResult.skipped ? 'skipped' : 'fallback'),
    latencyMs: Date.now() - llmStartedAt,
    fallbackUsed,
    validationErrorReason: validatedResult.validationErrorReason ?? null
  });

  if (items.length === 0) {
    throw new AppError(500, 'AI_RECOMMENDATION_FAILED', 'AI recommendation failed');
  }

  const responseWithoutRequestId = {
    normalizedQuery,
    intent,
    items,
    meta: {
      personalizationUsed: personalizationRequested && personalizationProfile.personalizationAvailable,
      personalizationAvailable: personalizationProfile.personalizationAvailable,
      fallbackUsed,
      source: recommendationSource,
      candidateCount: candidatesForLlm.length,
      generatedAt: new Date().toISOString()
    },
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

  logger.info('AI recommendation response completed', {
    userId,
    itemCount: items.length,
    personalizationUsed: responseWithoutRequestId.meta.personalizationUsed,
    fallbackUsed,
    source: recommendationSource,
    elapsedMs: Date.now() - startedAt
  });

  return response;
}

function normalizeRating(value) {
  if (value == null) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeAverageRating(value) {
  const numericValue = normalizeRating(value);

  if (numericValue == null) {
    return null;
  }

  return Math.round(numericValue * 10) / 10;
}

function sanitizeReviewContent(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\s+/g, ' ').slice(0, 500);
}

async function fetchReviewSummarySource(gameId) {
  const normalizedGameId = String(gameId);
  const where = {
    gameId: normalizedGameId
  };
  const [reviews, aggregation] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' }
      ],
      take: REVIEW_SUMMARY_SAMPLE_LIMIT,
      select: {
        id: true,
        rating: true,
        content: true,
        createdAt: true
      }
    }),
    prisma.review.aggregate({
      where,
      _count: {
        id: true
      },
      _avg: {
        rating: true
      }
    })
  ]);

  return {
    reviews,
    reviewCount: aggregation?._count?.id ?? 0,
    averageRating: normalizeAverageRating(aggregation?._avg?.rating ?? null)
  };
}

function buildReviewSummaryResponse({
  gameId,
  status,
  reason,
  reviewCount,
  fallbackUsed,
  summary,
  highlights = [],
  pros = [],
  cons = [],
  generatedAt = new Date().toISOString()
}) {
  return {
    gameId: String(gameId),
    status,
    reason,
    fallbackUsed,
    reviewCount,
    summary,
    highlights,
    pros,
    cons,
    generatedAt
  };
}

async function getGameReviewSummary({ gameId }) {
  const { reviews, reviewCount, averageRating } = await fetchReviewSummarySource(gameId);

  if (reviewCount === 0) {
    logger.info('[AIReviewSummary] completed', {
      gameId,
      status: 'empty',
      reason: 'NO_REVIEWS',
      reviewCount,
      fallbackUsed: false
    });

    return buildReviewSummaryResponse({
      gameId,
      status: 'empty',
      reason: 'NO_REVIEWS',
      reviewCount: 0,
      fallbackUsed: false,
      summary: '아직 요약할 리뷰가 없어요.'
    });
  }

  if (reviewCount < REVIEW_SUMMARY_MIN_LLM_REVIEWS) {
    logger.info('[AIReviewSummary] completed', {
      gameId,
      status: 'empty',
      reason: 'INSUFFICIENT_REVIEWS',
      reviewCount,
      fallbackUsed: false
    });

    return buildReviewSummaryResponse({
      gameId,
      status: 'empty',
      reason: 'INSUFFICIENT_REVIEWS',
      reviewCount,
      fallbackUsed: false,
      summary: '아직 AI 요약을 만들기에는 리뷰가 조금 부족해요.'
    });
  }

  const systemPrompt = buildReviewSummarySystemPrompt();
  const userPrompt = buildReviewSummaryUserPrompt({
    gameId,
    reviewCount,
    averageRating,
    reviews: reviews.map((review) => ({
      rating: normalizeRating(review.rating),
      content: sanitizeReviewContent(review.content)
    })).filter((review) => review.content)
  });

  try {
    const llmResult = await aiClient.createChatCompletion({
      systemPrompt,
      userPrompt,
      contextLabel: 'AI review summary',
      maxTokens: 500
    });
    const summary = validateLlmReviewSummaryResponse({
      rawContent: llmResult.content,
      reviewCount
    });

    if (summary) {
      logger.info('[AIReviewSummary] completed', {
        gameId,
        status: 'success',
        reason: null,
        reviewCount,
        fallbackUsed: false,
        summaryLength: summary.summary.length
      });

      return buildReviewSummaryResponse({
        gameId,
        status: 'success',
        reason: null,
        reviewCount,
        fallbackUsed: false,
        summary: summary.summary,
        highlights: summary.highlights,
        pros: summary.pros,
        cons: summary.cons
      });
    }
  } catch (error) {
    logger.warn('[AIReviewSummary] LLM summary unavailable', {
      gameId,
      status: 'fallback',
      reason: 'AI_SUMMARY_UNAVAILABLE',
      reviewCount
    });
  }

  logger.info('[AIReviewSummary] completed', {
    gameId,
    status: 'fallback',
    reason: 'AI_SUMMARY_UNAVAILABLE',
    reviewCount,
    fallbackUsed: true
  });

  return buildReviewSummaryResponse({
    gameId,
    status: 'fallback',
    reason: 'AI_SUMMARY_UNAVAILABLE',
    reviewCount,
    fallbackUsed: true,
    summary: REVIEW_SUMMARY_FALLBACK_TEXT
  });
}

module.exports = {
  assertAndIncrementDailyUsage,
  buildCacheKey,
  createGameRecommendations,
  getUsageDate,
  getGameReviewSummary,
  writeRecommendationLog
};
