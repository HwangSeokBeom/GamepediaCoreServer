const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const moderationService = require('../moderation/moderation.service');
const { AppError } = require('../../utils/error-response');
const { mapAverageRating, mapReviewListToDto, mapReviewToDto } = require('./review.mapper');

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

async function getMyReviews({ currentUserId, sort }) {
  const reviews = await prisma.review.findMany({
    where: { userId: currentUserId },
    orderBy: getReviewOrderBy(sort),
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
      userId: true
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

module.exports = {
  createReview,
  deleteReview,
  getGameReviews,
  getMyReviews,
  updateReview
};
