const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const catalogIdentityService = require('./catalog-identity.service');
const { GLOBAL_REGION_KEY, OWNERSHIP_PROVENANCE } = require('./catalog.constants');

// Dual write for the pre-existing write paths.
//
// TRUST RULE. The identifier in a manual library / review / favorite request came
// from the request body, so it is a claim, not a fact. These hooks therefore only
// *resolve* an already verified identity; they never create one and never create
// a publicly visible catalog game. When nothing verified exists the row keeps
// catalogGameId null and the legacy identity columns stay the sole record, which
// is an honest "not linked yet" rather than a fabricated verified link.
//
// The one trusted path is `linkVerifiedSteamOwnership`, used by the Steam owned-
// games sync, where the appid and name came from a real Steam API response that
// the server itself made.

async function linkResolvedLibraryEntry({ libraryEntryId, gameSource, externalGameId }) {
  try {
    const catalogGameId = await catalogIdentityService.resolveVerifiedCanonicalGameIdForLegacyWrite({
      gameSource,
      externalGameId
    });

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
async function linkResolvedReview({ reviewId, gameId }) {
  try {
    const catalogGameId = await catalogIdentityService.resolveVerifiedCanonicalGameIdForLegacyWrite({
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

async function linkResolvedFavorite({ favoriteId, gameId }) {
  try {
    const catalogGameId = await catalogIdentityService.resolveVerifiedCanonicalGameIdForLegacyWrite({
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

async function linkResolvedActivityEvent({ activityEventId, gameSource, externalGameId, igdbGameId = null }) {
  try {
    const catalogGameId = await catalogIdentityService.resolveVerifiedCanonicalGameIdForLegacyWrite({
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

/// Trusted path: links library rows the server itself synced from Steam.
///
/// `entries` are `{ libraryEntryId, externalGameId, gameName }` taken from the
/// Steam owned-games response, so the appid and name are provider facts and may
/// establish a verified identity and a PUBLISHED canonical game.
///
/// Returns per-entry outcomes plus counters. Idempotent: repeating a sync reuses
/// the same canonical game, and a row whose catalogGameId is still null from an
/// earlier failure is recovered on the next sync. Never throws — the caller
/// reports a degraded result instead of claiming a link it does not have.
async function linkVerifiedSteamOwnership({ entries, now = new Date() }) {
  let linkedCount = 0;
  let pendingCount = 0;
  const failureReasons = new Set();

  for (const entry of entries) {
    const externalGameId = String(entry.externalGameId ?? '').trim();

    if (externalGameId.length === 0 || !entry.libraryEntryId) {
      pendingCount += 1;
      failureReasons.add('missing_identity_input');
      continue;
    }

    try {
      const { catalogGameId } = await catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
        provider: 'STEAM',
        externalId: externalGameId,
        regionKey: GLOBAL_REGION_KEY,
        title: entry.gameName,
        // A real Steam owned-games response is a provider fact.
        publicationStatus: 'PUBLISHED',
        titleProvenance: 'PROVIDER_VERIFIED',
        identityProvenance: 'PROVIDER_VERIFIED',
        verificationSource: 'steam_owned_games_sync',
        platforms: ['STEAM'],
        verifiedAt: now
      });

      if (!catalogGameId) {
        pendingCount += 1;
        failureReasons.add('canonical_game_unresolved');
        continue;
      }

      await prisma.userGameLibrary.update({
        where: { id: entry.libraryEntryId },
        data: {
          catalogGameId,
          ownershipProvenance: OWNERSHIP_PROVENANCE.PROVIDER_VERIFIED
        },
        select: { id: true }
      });

      linkedCount += 1;
    } catch (error) {
      pendingCount += 1;
      failureReasons.add(error?.code ?? error?.name ?? 'unknown');
    }
  }

  const status = pendingCount === 0
    ? 'linked'
    : (linkedCount > 0 ? 'partial' : 'unavailable');

  logger.info('catalog-steam-ownership-link', {
    entryCount: entries.length,
    linkedCount,
    pendingCount,
    canonicalLinkStatus: status,
    // Reason codes only, never a provider body or a raw error string.
    failureReasonCodes: [...failureReasons].sort()
  });

  return {
    canonicalLinkStatus: status,
    canonicalLinkedCount: linkedCount,
    canonicalPendingCount: pendingCount,
    canonicalFailureReasonCodes: [...failureReasons].sort()
  };
}

module.exports = {
  linkResolvedActivityEvent,
  linkResolvedFavorite,
  linkResolvedLibraryEntry,
  linkResolvedReview,
  linkVerifiedSteamOwnership
};
