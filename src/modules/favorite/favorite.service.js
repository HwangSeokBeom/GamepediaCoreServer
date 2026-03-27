const { prisma } = require('../../config/prisma');
const { mapFavoriteListToDto } = require('./favorite.mapper');

const favoriteOrderByMap = {
  latest: [{ createdAt: 'desc' }],
  oldest: [{ createdAt: 'asc' }]
};

function getFavoriteOrderBy(sort) {
  return favoriteOrderByMap[sort] ?? favoriteOrderByMap.latest;
}

async function addFavorite({ userId, gameId }) {
  const favorite = await prisma.favoriteGame.upsert({
    where: {
      userId_gameId: {
        userId,
        gameId
      }
    },
    update: {},
    create: {
      userId,
      gameId
    }
  });

  return {
    favorited: true,
    gameId: favorite.gameId
  };
}

async function removeFavorite({ userId, gameId }) {
  await prisma.favoriteGame.deleteMany({
    where: {
      userId,
      gameId
    }
  });

  return {
    favorited: false,
    gameId
  };
}

async function getMyFavorites({ currentUserId, sort }) {
  const favorites = await prisma.favoriteGame.findMany({
    where: { userId: currentUserId },
    orderBy: getFavoriteOrderBy(sort)
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
