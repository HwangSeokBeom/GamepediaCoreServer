const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/error-response');
const moderationService = require('../moderation/moderation.service');
const aiClient = require('./ai.client');
const {
  buildReviewSummarySystemPrompt,
  buildReviewSummaryUserPrompt
} = require('./ai-review-summary.prompt');
const {
  validateLlmReviewSummaryResponse
} = require('./ai-review-summary.validator');
const { getUsageDate } = require('./ai.service');

const MIN_REVIEW_COUNT = 3;
const MAX_PROMPT_REVIEW_COUNT = 30;
const PROMPT_REVIEW_CONTENT_MAX_LENGTH = 500;
const DISCLAIMER = 'AI 리뷰 요약은 사용자 리뷰를 기반으로 생성되며, 실제 경험과 다를 수 있습니다.';
const KOREAN_STOP_WORDS = new Set([
  '그리고', '하지만', '그래서', '너무', '정말', '게임', '리뷰', '플레이', '있습니다',
  '없습니다', '같아요', '합니다', '입니다', '있는', '없는', '하면', '해서', '많이',
  '조금', '다소', '매우', '이런', '저는', '제가', '것은', '것도', '수도'
]);

function normalizeGameId(gameId) {
  return String(gameId).trim();
}

function toBigIntGameId(gameId) {
  return BigInt(normalizeGameId(gameId));
}

function toResponseGameId(gameId) {
  const numericGameId = Number(gameId);

  return Number.isSafeInteger(numericGameId) ? numericGameId : String(gameId);
}

function normalizeRating(value) {
  if (value == null) {
    return null;
  }

  const numericValue = typeof value.toNumber === 'function' ? value.toNumber() : Number(value);

  return Number.isFinite(numericValue) ? numericValue : null;
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

function normalizeReviewForHash(review) {
  return {
    reviewId: review.id,
    updatedAt: review.updatedAt instanceof Date ? review.updatedAt.toISOString() : new Date(review.updatedAt).toISOString(),
    content: review.content
  };
}

function buildSourceReviewHash(reviews) {
  const hashSource = reviews
    .map(normalizeReviewForHash)
    .sort((left, right) => left.reviewId.localeCompare(right.reviewId))
    .map((review) => `${review.reviewId}\n${review.updatedAt}\n${review.content}`)
    .join('\n---review---\n');

  return crypto.createHash('sha256').update(hashSource).digest('hex');
}

function selectPromptReviews(reviews) {
  const byNewest = [...reviews].sort((left, right) => {
    const createdAtDiff = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    return createdAtDiff || right.id.localeCompare(left.id);
  });
  const byHighestRating = [...reviews].sort((left, right) => {
    const ratingDiff = (normalizeRating(right.rating) ?? 0) - (normalizeRating(left.rating) ?? 0);
    return ratingDiff || (new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  });
  const byLowestRating = [...reviews].sort((left, right) => {
    const ratingDiff = (normalizeRating(left.rating) ?? 0) - (normalizeRating(right.rating) ?? 0);
    return ratingDiff || (new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  });
  const selectedMap = new Map();

  for (const review of [
    ...byNewest.slice(0, 20),
    ...byHighestRating.slice(0, 5),
    ...byLowestRating.slice(0, 5),
    ...byNewest
  ]) {
    selectedMap.set(review.id, review);

    if (selectedMap.size >= MAX_PROMPT_REVIEW_COUNT) {
      break;
    }
  }

  return [...selectedMap.values()]
    .sort((left, right) => {
      const createdAtDiff = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      return createdAtDiff || right.id.localeCompare(left.id);
    })
    .map((review) => ({
      id: review.id,
      rating: normalizeRating(review.rating),
      createdAt: review.createdAt instanceof Date ? review.createdAt.toISOString() : new Date(review.createdAt).toISOString(),
      content: truncateText(review.content, PROMPT_REVIEW_CONTENT_MAX_LENGTH)
    }));
}

async function findVisibleReviewsForSummary({ currentUserId, gameId }) {
  const hiddenUserIds = await moderationService.getHiddenUserIds(currentUserId);

  return prisma.review.findMany({
    where: {
      gameId: normalizeGameId(gameId),
      ...(hiddenUserIds.length > 0 ? {
        userId: {
          notIn: hiddenUserIds
        }
      } : {})
    },
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ],
    select: {
      id: true,
      rating: true,
      content: true,
      createdAt: true,
      updatedAt: true
    }
  });
}

function extractKeywords(reviews, maxKeywords = 6) {
  const counts = new Map();
  const text = reviews.map((review) => review.content).join(' ').toLowerCase();
  const tokens = text.match(/[가-힣a-zA-Z0-9]{2,}/g) ?? [];

  for (const token of tokens) {
    if (KOREAN_STOP_WORDS.has(token) || /^\d+$/.test(token)) {
      continue;
    }

    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ko'))
    .map(([keyword]) => keyword)
    .slice(0, maxKeywords);
}

function buildFallbackReviewSummary({ reviews }) {
  const reviewCount = reviews.length;
  const ratings = reviews
    .map((review) => normalizeRating(review.rating))
    .filter((rating) => rating != null);
  const averageRating = ratings.length > 0
    ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length
    : null;
  const positiveCount = ratings.filter((rating) => rating >= 4).length;
  const negativeCount = ratings.filter((rating) => rating <= 2.5).length;
  const keywords = extractKeywords(reviews);
  const sentimentText = averageRating == null
    ? '평점 정보 없이 리뷰 내용 중심으로 의견이 모여 있습니다.'
    : `평균 평점은 ${averageRating.toFixed(1)}점이며, 긍정 리뷰 ${positiveCount}개와 낮은 평점 리뷰 ${negativeCount}개가 함께 확인됩니다.`;

  return {
    summary: `${reviewCount}개의 사용자 리뷰를 기준으로 보면 ${sentimentText}`,
    pros: positiveCount > 0
      ? ['높은 평점을 준 사용자가 긍정적인 플레이 경험을 남겼습니다.']
      : ['일부 사용자는 게임의 특정 요소에 만족감을 남겼습니다.'],
    cons: negativeCount > 0
      ? ['낮은 평점 리뷰도 있어 취향에 따라 아쉬운 지점이 있을 수 있습니다.']
      : ['뚜렷한 단점은 제한적으로 언급되었지만 개인 취향에 따라 다를 수 있습니다.'],
    recommendedFor: ['사용자 리뷰를 참고해 취향에 맞는지 확인하려는 사용자'],
    notRecommendedFor: ['리뷰가 언급한 아쉬운 요소에 민감한 사용자'],
    keywords
  };
}

function mapSummaryRecordToResponse(record) {
  return {
    gameId: toResponseGameId(record.gameId),
    summary: record.summary,
    pros: Array.isArray(record.pros) ? record.pros : [],
    cons: Array.isArray(record.cons) ? record.cons : [],
    recommendedFor: Array.isArray(record.recommendedFor) ? record.recommendedFor : [],
    notRecommendedFor: Array.isArray(record.notRecommendedFor) ? record.notRecommendedFor : [],
    keywords: Array.isArray(record.keywords) ? record.keywords : [],
    reviewCount: record.reviewCount,
    sourceReviewHash: record.sourceReviewHash,
    generatedAt: (record.generatedAt instanceof Date ? record.generatedAt : new Date(record.generatedAt)).toISOString(),
    disclaimer: DISCLAIMER
  };
}

async function assertAndIncrementReviewSummaryUsage({ userId }) {
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
        reviewSummaryCount: 1
      },
      update: {
        reviewSummaryCount: {
          increment: 1
        }
      }
    });

    if (usage.reviewSummaryCount > env.aiReviewSummaryDailyLimit) {
      throw new AppError(429, 'AI_DAILY_LIMIT_EXCEEDED', 'Daily AI review summary limit exceeded');
    }
  });
}

async function createAndStoreReviewSummary({
  gameId,
  reviews,
  sourceReviewHash
}) {
  const fallbackSummary = buildFallbackReviewSummary({ reviews });
  const promptReviews = selectPromptReviews(reviews);
  const systemPrompt = buildReviewSummarySystemPrompt();
  const userPrompt = buildReviewSummaryUserPrompt({
    gameId: normalizeGameId(gameId),
    reviewCount: reviews.length,
    reviews: promptReviews
  });
  const llmResult = await aiClient.createChatCompletion({
    systemPrompt,
    userPrompt
  });
  const validatedResult = validateLlmReviewSummaryResponse({
    rawContent: llmResult.content,
    fallbackSummary
  });
  const usedLlmResult = validatedResult.source === 'llm' && !llmResult.skipped;

  if (!usedLlmResult) {
    logger.warn('AI review summary fallback used', {
      gameId: normalizeGameId(gameId),
      reason: llmResult.skipped ? 'llm_skipped' : 'invalid_llm_response',
      model: llmResult.model ?? null
    });
  }

  try {
    return await prisma.aiReviewSummary.create({
      data: {
        gameId: toBigIntGameId(gameId),
        summary: validatedResult.value.summary,
        pros: validatedResult.value.pros,
        cons: validatedResult.value.cons,
        recommendedFor: validatedResult.value.recommendedFor,
        notRecommendedFor: validatedResult.value.notRecommendedFor,
        keywords: validatedResult.value.keywords,
        reviewCount: reviews.length,
        sourceReviewHash,
        model: usedLlmResult ? (llmResult.model ?? env.llmModel) : 'mock-rule-based',
        promptTokens: usedLlmResult ? (llmResult.promptTokens ?? 0) : 0,
        completionTokens: usedLlmResult ? (llmResult.completionTokens ?? 0) : 0
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.aiReviewSummary.findUnique({
        where: {
          gameId_sourceReviewHash: {
            gameId: toBigIntGameId(gameId),
            sourceReviewHash
          }
        }
      });
    }

    throw error;
  }
}

async function getGameReviewSummary({ currentUserId, gameId }) {
  const reviews = await findVisibleReviewsForSummary({
    currentUserId,
    gameId
  });

  if (reviews.length < MIN_REVIEW_COUNT) {
    throw new AppError(
      404,
      'REVIEW_SUMMARY_NOT_AVAILABLE',
      '요약할 리뷰가 충분하지 않습니다.'
    );
  }

  const sourceReviewHash = buildSourceReviewHash(reviews);
  const cachedSummary = await prisma.aiReviewSummary.findUnique({
    where: {
      gameId_sourceReviewHash: {
        gameId: toBigIntGameId(gameId),
        sourceReviewHash
      }
    }
  });

  if (cachedSummary) {
    return mapSummaryRecordToResponse(cachedSummary);
  }

  await assertAndIncrementReviewSummaryUsage({
    userId: currentUserId
  });

  const summary = await createAndStoreReviewSummary({
    gameId,
    reviews,
    sourceReviewHash
  });

  if (!summary) {
    throw new AppError(500, 'AI_REVIEW_SUMMARY_FAILED', 'AI review summary failed');
  }

  return mapSummaryRecordToResponse(summary);
}

module.exports = {
  DISCLAIMER,
  buildFallbackReviewSummary,
  buildSourceReviewHash,
  findVisibleReviewsForSummary,
  getGameReviewSummary,
  assertAndIncrementReviewSummaryUsage,
  selectPromptReviews
};
