const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const userActivityService = require('../user/user-activity.service');
const catalogDualWriteService = require('../catalog/catalog-dual-write.service');
const { mapFavoriteListToDto } = require('./favorite.mapper');

const favoriteOrderByMap = {
  latest: [{ createdAt: 'desc' }],
  oldest: [{ createdAt: 'asc' }]
};

function getFavoriteOrderBy(sort) {
  return favoriteOrderByMap[sort] ?? favoriteOrderByMap.latest;
}

async function addFavorite({ userId, gameId }) {
  let favorite = null;
  let created = false;

  try {
    favorite = await prisma.favoriteGame.create({
      data: {
        userId,
        gameId
      }
    });
    created = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
      throw error;
    }

    favorite = await prisma.favoriteGame.findUnique({
      where: {
        userId_gameId: {
          userId,
          gameId
        }
      }
    });
  }

  if (created && favorite) {
    try {
      await userActivityService.recordFavoriteAddedActivity({
        userId,
        gameId
      });
    } catch (activityError) {
      logger.warn('favorite-activity-create-failed', {
        userId,
        gameId,
        code: activityError?.code ?? null,
        message: activityError?.message ?? 'Favorite activity create failed'
      });
    }
  }

  // Product 2.2 dual write: gameId came from the request body, so it is only
  // *resolved* against an already verified identity, never used to create one.
  if (favorite) {
    await catalogDualWriteService.linkResolvedFavorite({ favoriteId: favorite.id, gameId });
  }

  return {
    favorited: true,
    gameId: favorite?.gameId ?? gameId
  };
}

async function removeFavorite({ userId, gameId }) {
  const result = await prisma.favoriteGame.deleteMany({
    where: {
      userId,
      gameId
    }
  });

  if (result.count > 0) {
    try {
      await userActivityService.recordFavoriteRemovedActivity({
        userId,
        gameId
      });
    } catch (activityError) {
      logger.warn('favorite-activity-remove-failed', {
        userId,
        gameId,
        code: activityError?.code ?? null,
        message: activityError?.message ?? 'Favorite activity remove failed'
      });
    }
  }

  return {
    favorited: false,
    gameId
  };
}

async function getMyFavorites({ currentUserId, sort, limit }) {
  const favorites = await prisma.favoriteGame.findMany({
    where: { userId: currentUserId },
    orderBy: getFavoriteOrderBy(sort),
    ...(Number.isInteger(limit) && limit > 0 ? { take: limit } : {})
  });

  return {
    favorites: mapFavoriteListToDto(favorites)
  };
}

async function getFavoriteStatus({ userId, gameId }) {
  const favorite = await prisma.favoriteGame.findUnique({
    where: {
      userId_gameId: {
        userId,
        gameId
      }
    },
    select: {
      id: true
    }
  });

  return {
    isFavorite: Boolean(favorite)
  };
}

module.exports = {
  addFavorite,
  getFavoriteStatus,
  getMyFavorites,
  removeFavorite
};
