const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const catalogIdentityService = require('./catalog-identity.service');

// Dual write for the pre-existing write paths.
//
// New writes record the canonical catalogGameId *alongside* the legacy identity
// columns, which stay authoritative. The canonical id is an additive index, so
// every hook here is best effort: a catalog failure logs a category and returns,
// leaving the already-committed legacy row exactly as it was. That is what keeps
// a catalog problem from breaking game search, Steam sync, reviews or the
// library.

async function linkLibraryEntry({ libraryEntryId, gameSource, externalGameId, title = null }) {
  try {
    const catalogGameId = await catalogIdentityService.linkLegacyIdentity({ gameSource, externalGameId, title });

    if (!catalogGameId) {
      return null;
    }

    await prisma.userGameLibrary.update({
      where: { id: libraryEntryId },
      data: { catalogGameId },
      select: { id: true }
    });

    return catalogGameId;
  } catch (error) {
    logger.warn('catalog-dual-write-library-skipped', {
      errorCategory: error?.code ?? error?.name ?? 'unknown',
      legacyWritePreserved: true
    });

    return null;
  }
}

/// Review and favorite game ids are IGDB identities.
async function linkReview({ reviewId, gameId }) {
  try {
    const catalogGameId = await catalogIdentityService.linkLegacyIdentity({
      gameSource: 'IGDB',
      externalGameId: gameId
    });

    if (!catalogGameId) {
      return null;
    }

    await prisma.review.update({
      where: { id: reviewId },
      data: { catalogGameId },
      select: { id: true }
    });

    return catalogGameId;
  } catch (error) {
    logger.warn('catalog-dual-write-review-skipped', {
      errorCategory: error?.code ?? error?.name ?? 'unknown',
      legacyWritePreserved: true
    });

    return null;
  }
}

async function linkFavorite({ favoriteId, gameId }) {
  try {
    const catalogGameId = await catalogIdentityService.linkLegacyIdentity({
      gameSource: 'IGDB',
      externalGameId: gameId
    });

    if (!catalogGameId) {
      return null;
    }

    await prisma.favoriteGame.update({
      where: { id: favoriteId },
      data: { catalogGameId },
      select: { id: true }
    });

    return catalogGameId;
  } catch (error) {
    logger.warn('catalog-dual-write-favorite-skipped', {
      errorCategory: error?.code ?? error?.name ?? 'unknown',
      legacyWritePreserved: true
    });

    return null;
  }
}

async function linkActivityEvent({ activityEventId, gameSource, externalGameId, igdbGameId = null }) {
  try {
    const catalogGameId = await catalogIdentityService.linkLegacyIdentity({
      // The explicit IGDB id wins, matching the backfill's resolution order.
      gameSource: igdbGameId ? 'IGDB' : gameSource,
      externalGameId: igdbGameId ?? externalGameId
    });

    if (!catalogGameId) {
      return null;
    }

    await prisma.userActivityEvent.update({
      where: { id: activityEventId },
      data: { catalogGameId },
      select: { id: true }
    });

    return catalogGameId;
  } catch (error) {
    logger.warn('catalog-dual-write-activity-skipped', {
      errorCategory: error?.code ?? error?.name ?? 'unknown',
      legacyWritePreserved: true
    });

    return null;
  }
}

module.exports = {
  linkActivityEvent,
  linkFavorite,
  linkLibraryEntry,
  linkReview
};
