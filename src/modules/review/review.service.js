const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const moderationService = require('../moderation/moderation.service');
const { AppError } = require('../../utils/error-response');
const steamService = require('../../services/steam.service');
const userActivityService = require('../user/user-activity.service');
const { mapAverageRating, mapReviewListToDto, mapReviewToDto, mapSteamLinkedReviewToDto } = require('./review.mapper');

const reviewAuthorSelect = {
  id: true,
  nickname: true,
  profileImageUrl: true
};

const reviewOrderByMap = {
  latest: [{ createdAt: 'desc' }],
  oldest: [{ createdAt: 'asc' }],
  rating_desc: [{ rating: 'desc' }, { createdAt: 'desc' }],
  rating_asc: [{ rating: 'asc' }, { createdAt: 'desc' }]
};

function getReviewOrderBy(sort) {
  return reviewOrderByMap[sort] ?? reviewOrderByMap.latest;
}

function buildReviewData({ rating, content }) {
  return {
    ...(rating !== undefined ? { rating: new Prisma.Decimal(rating) } : {}),
    ...(content !== undefined ? { content: content.trim() } : {})
  };
}

async function createReview({ userId, gameId, rating, content }) {
  try {
    const review = await prisma.review.create({
      data: {
        userId,
        gameId,
        rating: new Prisma.Decimal(rating),
        content: content.trim()
      },
      include: {
        user: {
          select: reviewAuthorSelect
        }
      }
    });

    try {
      await userActivityService.recordReviewCreatedActivity({
        userId,
        review
      });
    } catch (activityError) {
      logger.warn('review-activity-create-failed', {
        userId,
        gameId,
        code: activityError?.code ?? null,
        message: activityError?.message ?? 'Review activity creation failed'
      });
    }

    return {
      review: mapReviewToDto(review, userId)
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(409, 'REVIEW_ALREADY_EXISTS', 'You already wrote a review for this game');
    }

    throw error;
  }
}

async function getGameReviews({ currentUserId, gameId, sort }) {
  const hiddenUserIds = await moderationService.getHiddenUserIds(currentUserId);
  const reviewWhere = {
    gameId,
    ...(hiddenUserIds.length > 0 ? {
      userId: {
        notIn: hiddenUserIds
      }
    } : {})
  };

  const [reviews, aggregation] = await prisma.$transaction([
    prisma.review.findMany({
      // Moderation hook: hide reviews authored by users hidden through blocking.
      where: reviewWhere,
      orderBy: getReviewOrderBy(sort),
      include: {
        user: {
          select: reviewAuthorSelect
        }
      }
    }),
    prisma.review.aggregate({
      where: reviewWhere,
      _count: {
        id: true
      },
      _avg: {
        rating: true
      }
    })
  ]);

  return {
    reviews: mapReviewListToDto(reviews, currentUserId),
    meta: {
      reviewCount: aggregation._count.id,
      averageRating: mapAverageRating(aggregation._avg.rating)
    }
  };
}

async function getMyReviews({ currentUserId, sort, limit }) {
  const reviews = await prisma.review.findMany({
    where: { userId: currentUserId },
    orderBy: getReviewOrderBy(sort),
    ...(Number.isInteger(limit) && limit > 0 ? { take: limit } : {}),
    include: {
      user: {
        select: reviewAuthorSelect
      }
    }
  });

  return {
    reviews: mapReviewListToDto(reviews, currentUserId)
  };
}

async function updateReview({ currentUserId, reviewId, rating, content }) {
  const existingReview = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      userId: true,
      gameId: true,
      rating: true,
      content: true
    }
  });

  if (!existingReview) {
    throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review could not be found');
  }

  if (existingReview.userId !== currentUserId) {
    throw new AppError(403, 'REVIEW_FORBIDDEN', 'You can only edit your own review');
  }

  const updatedReview = await prisma.review.update({
    where: { id: reviewId },
    data: buildReviewData({ rating, content }),
    include: {
      user: {
        select: reviewAuthorSelect
      }
    }
  });

  try {
    await userActivityService.recordReviewUpdatedActivity({
      userId: currentUserId,
      review: updatedReview,
      previousRating: existingReview.rating,
      previousContent: existingReview.content
    });
  } catch (activityError) {
    logger.warn('review-activity-update-failed', {
      userId: currentUserId,
      reviewId,
      code: activityError?.code ?? null,
      message: activityError?.message ?? 'Review activity update failed'
    });
  }

  return {
    review: mapReviewToDto(updatedReview, currentUserId)
  };
}

async function deleteReview({ currentUserId, reviewId }) {
  const existingReview = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      userId: true
    }
  });

  if (!existingReview) {
    throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review could not be found');
  }

  if (existingReview.userId !== currentUserId) {
    throw new AppError(403, 'REVIEW_FORBIDDEN', 'You can only delete your own review');
  }

  await prisma.review.delete({
    where: { id: reviewId }
  });

  return {
    deleted: true,
    reviewId
  };
}

const STEAM_LINKED_REVIEW_LIMIT = 20;

async function getSteamLinkedReviews({ currentUserId }) {
  const steamAccount = await prisma.socialAccount.findUnique({
    where: {
      userId_provider: {
        userId: currentUserId,
        provider: steamService.STEAM_AUTH_PROVIDER
      }
    },
    select: { providerSubject: true }
  });

  if (!steamAccount) {
    return { reviews: [] };
  }

  const reviews = await prisma.review.findMany({
    where: { userId: currentUserId },
    orderBy: [{ createdAt: 'desc' }],
    include: {
      user: { select: reviewAuthorSelect }
    }
  });

  if (reviews.length === 0) {
    return { reviews: [] };
  }

  const reviewGameIds = reviews.map((r) => r.gameId);

  const mappings = await prisma.steamIgdbMapping.findMany({
    where: {
      igdbGameId: { in: reviewGameIds },
      matchStatus: 'CONFIRMED'
    }
  });

  if (mappings.length === 0) {
    return { reviews: [] };
  }

  const steamAppIds = mappings.map((m) => m.steamAppId);

  const libraryEntries = await prisma.userGameLibrary.findMany({
    where: {
      userId: currentUserId,
      gameSource: 'STEAM',
      externalGameId: { in: steamAppIds }
    },
    select: { externalGameId: true }
  });

  const ownedSteamAppIds = new Set(libraryEntries.map((e) => e.externalGameId));

  const igdbToSteamMap = new Map();
  for (const mapping of mappings) {
    if (ownedSteamAppIds.has(mapping.steamAppId)) {
      igdbToSteamMap.set(mapping.igdbGameId, mapping.steamAppId);
    }
  }

  const steamLinkedReviews = reviews
    .filter((r) => igdbToSteamMap.has(r.gameId))
    .slice(0, STEAM_LINKED_REVIEW_LIMIT);

  if (steamLinkedReviews.length === 0) {
    return { reviews: [] };
  }

  const uniqueAppIds = [...new Set(
    steamLinkedReviews.map((r) => igdbToSteamMap.get(r.gameId)).filter(Boolean)
  )];

  const summaryResults = await Promise.allSettled(
    uniqueAppIds.map((appId) =>
      steamService.fetchAppReviewSummarySafe({ appId }).then((summary) => [appId, summary])
    )
  );

  const steamSummaryMap = new Map();
  for (const result of summaryResults) {
    if (result.status === 'fulfilled' && result.value) {
      const [appId, summary] = result.value;
      steamSummaryMap.set(appId, summary);
    }
  }

  const mappedReviews = steamLinkedReviews.map((review) => {
    const steamAppId = igdbToSteamMap.get(review.gameId);
    const steamMeta = steamSummaryMap.get(steamAppId) ?? null;
    return mapSteamLinkedReviewToDto(review, currentUserId, steamMeta);
  });

  return { reviews: mappedReviews };
}

module.exports = {
  createReview,
  deleteReview,
  getGameReviews,
  getMyReviews,
  getSteamLinkedReviews,
  updateReview
};
