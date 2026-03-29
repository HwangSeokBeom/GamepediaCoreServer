const { GameLibraryStatus, GameSource } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const favoriteService = require('../favorite/favorite.service');
const igdbService = require('../igdb/igdb.service');
const reviewService = require('../review/review.service');
const steamService = require('../../services/steam.service');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/error-response');
const {
  mapLibraryStatusEntry,
  mapReviewedItem,
  mapSteamLinkStatus,
  mapWishlistItem
} = require('./library.mapper');

const steamAccountSelect = {
  id: true,
  userId: true,
  providerSubject: true,
  personaName: true,
  profileUrl: true,
  avatarUrl: true,
  linkedAt: true,
  createdAt: true,
  updatedAt: true
};

const sourceMap = {
  steam: GameSource.STEAM,
  igdb: GameSource.IGDB
};

const statusMap = {
  playing: GameLibraryStatus.PLAYING,
  completed: GameLibraryStatus.COMPLETED,
  dropped: GameLibraryStatus.DROPPED
};

function resolveGameSource(source) {
  return sourceMap[source];
}

function resolveGameStatus(status) {
  return statusMap[status];
}

async function getSteamSocialAccount(userId) {
  return prisma.socialAccount.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: steamService.STEAM_AUTH_PROVIDER
      }
    },
    select: steamAccountSelect
  });
}

async function buildIgdbGameMap(gameIds) {
  if (!Array.isArray(gameIds) || gameIds.length === 0) {
    return new Map();
  }

  try {
    const { games } = await igdbService.getGamesByIds({ gameIds });
    return new Map(games.map((game) => [String(game.id), game]));
  } catch (error) {
    logger.warn('Library IGDB hydration skipped', {
      code: error?.code,
      message: error?.message,
      gameCount: gameIds.length
    });
    return new Map();
  }
}

async function buildRecentlyPlayedItems(steamAccount) {
  if (!steamAccount?.providerSubject) {
    return [];
  }

  try {
    const result = await steamService.fetchRecentlyPlayedGames({
      steamId64: steamAccount.providerSubject
    });

    return result.games;
  } catch (error) {
    logger.warn('Library Steam recently played sync skipped', {
      userId: steamAccount.userId,
      code: error?.code,
      message: error?.message
    });
    return [];
  }
}

function buildLibraryEntryWriteData({
  existingEntry,
  source,
  externalGameId,
  title,
  coverUrl,
  status,
  startedAt,
  completedAt,
  lastPlayedAt,
  playtimeMinutes
}) {
  const nextStatus = resolveGameStatus(status);
  const now = new Date();

  return {
    gameSource: resolveGameSource(source),
    externalGameId,
    gameName: title,
    coverUrl: coverUrl ?? null,
    status: nextStatus,
    startedAt: startedAt !== undefined
      ? startedAt
      : (nextStatus === GameLibraryStatus.PLAYING ? (existingEntry?.startedAt ?? now) : (existingEntry?.startedAt ?? null)),
    completedAt: completedAt !== undefined
      ? completedAt
      : (
        nextStatus === GameLibraryStatus.COMPLETED
          ? (existingEntry?.completedAt ?? now)
          : (nextStatus === GameLibraryStatus.PLAYING ? null : (existingEntry?.completedAt ?? null))
      ),
    lastPlayedAt: lastPlayedAt !== undefined ? lastPlayedAt : (existingEntry?.lastPlayedAt ?? null),
    playtimeMinutes: playtimeMinutes !== undefined ? playtimeMinutes : (existingEntry?.playtimeMinutes ?? null)
  };
}

async function getMyLibrary({ userId }) {
  const [steamAccount, favoriteResult, reviewResult, playingEntries] = await Promise.all([
    getSteamSocialAccount(userId),
    favoriteService.getMyFavorites({
      currentUserId: userId,
      sort: 'latest'
    }),
    reviewService.getMyReviews({
      currentUserId: userId,
      sort: 'latest'
    }),
    prisma.userGameLibrary.findMany({
      where: {
        userId,
        status: GameLibraryStatus.PLAYING
      },
      orderBy: {
        updatedAt: 'desc'
      }
    })
  ]);

  const favoriteGameIds = favoriteResult.favorites.map((favorite) => favorite.gameId);
  const reviewedGameIds = reviewResult.reviews.map((review) => review.gameId);
  const [recentlyPlayed, igdbGameMap] = await Promise.all([
    buildRecentlyPlayedItems(steamAccount),
    buildIgdbGameMap([...favoriteGameIds, ...reviewedGameIds])
  ]);

  return {
    steamLinkStatus: mapSteamLinkStatus(steamAccount),
    recentlyPlayed,
    playing: playingEntries.map(mapLibraryStatusEntry),
    wishlist: favoriteResult.favorites.map((favorite) => mapWishlistItem(favorite, igdbGameMap.get(favorite.gameId))),
    reviewed: reviewResult.reviews.map((review) => mapReviewedItem(review, igdbGameMap.get(review.gameId)))
  };
}

async function startSteamLink({ userId, redirectUri }) {
  return {
    steamLink: steamService.buildSteamLinkUrl({
      userId,
      redirectUri
    })
  };
}

async function completeSteamLink({ query, callbackContext }) {
  const verifiedContext = callbackContext ?? steamService.parseSteamLinkState(query.state);
  const { steamId64 } = await steamService.verifySteamOpenIdCallback(query);
  const [existingBySteamId, existingByUser, profile] = await Promise.all([
    prisma.socialAccount.findUnique({
      where: {
        provider_providerSubject: {
          provider: steamService.STEAM_AUTH_PROVIDER,
          providerSubject: steamId64
        }
      },
      select: steamAccountSelect
    }),
    getSteamSocialAccount(verifiedContext.userId),
    steamService.fetchPlayerSummarySafe({ steamId64 })
  ]);

  if (existingBySteamId && existingBySteamId.userId !== verifiedContext.userId) {
    throw new AppError(409, 'STEAM_ACCOUNT_ALREADY_LINKED', 'This Steam account is already linked to another user');
  }

  if (existingByUser && existingByUser.providerSubject !== steamId64) {
    throw new AppError(409, 'STEAM_ACCOUNT_LINK_CONFLICT', 'Unlink the current Steam account before linking a different one');
  }

  const writeData = {
    providerSubject: steamId64,
    personaName: profile.personaName,
    profileUrl: profile.profileUrl,
    avatarUrl: profile.avatarUrl
  };

  const steamAccount = existingByUser
    ? await prisma.socialAccount.update({
      where: { id: existingByUser.id },
      data: writeData,
      select: steamAccountSelect
    })
    : await prisma.socialAccount.create({
      data: {
        userId: verifiedContext.userId,
        provider: steamService.STEAM_AUTH_PROVIDER,
        linkedAt: new Date(),
        ...writeData
      },
      select: steamAccountSelect
    });

  return {
    linked: true,
    redirectUri: verifiedContext.redirectUri,
    steamAccount: mapSteamLinkStatus(steamAccount)
  };
}

async function unlinkSteamAccount({ userId }) {
  await prisma.socialAccount.deleteMany({
    where: {
      userId,
      provider: steamService.STEAM_AUTH_PROVIDER
    }
  });

  return {
    unlinked: true,
    steamLinkStatus: mapSteamLinkStatus(null)
  };
}

async function updateLibraryStatus({
  userId,
  source,
  externalGameId,
  title,
  coverUrl,
  status,
  startedAt,
  completedAt,
  lastPlayedAt,
  playtimeMinutes
}) {
  const gameSource = resolveGameSource(source);
  const existingEntry = await prisma.userGameLibrary.findUnique({
    where: {
      userId_gameSource_externalGameId: {
        userId,
        gameSource,
        externalGameId
      }
    }
  });

  const data = buildLibraryEntryWriteData({
    existingEntry,
    source,
    externalGameId,
    title,
    coverUrl,
    status,
    startedAt,
    completedAt,
    lastPlayedAt,
    playtimeMinutes
  });

  const libraryEntry = existingEntry
    ? await prisma.userGameLibrary.update({
      where: { id: existingEntry.id },
      data
    })
    : await prisma.userGameLibrary.create({
      data: {
        userId,
        ...data
      }
    });

  return {
    libraryEntry: mapLibraryStatusEntry(libraryEntry)
  };
}

module.exports = {
  completeSteamLink,
  getMyLibrary,
  startSteamLink,
  unlinkSteamAccount,
  updateLibraryStatus
};
