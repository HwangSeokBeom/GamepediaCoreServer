const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const { normalizeTitle, titleSimilarity } = require('./catalog-title.util');
const { resolveCanonicalGameId } = require('./catalog-identity.service');
const { mapCatalogGameDetail, mapCatalogGameSummary } = require('./catalog.mapper');
const {
  CORRECTABLE_FIELD_PATHS,
  FUZZY_MATCH_MIN_SIMILARITY,
  GLOBAL_REGION_KEY
} = require('./catalog.constants');

const SEARCH_SCAN_LIMIT = 200;

const GAME_SUMMARY_SELECT = {
  id: true,
  originalTitle: true,
  normalizedTitle: true,
  slug: true,
  developerName: true,
  publisherName: true,
  firstReleaseDate: true,
  genres: true,
  platforms: true,
  publicationStatus: true,
  titleProvenance: true,
  identities: {
    select: { provider: true, externalId: true, regionKey: true, provenance: true, confidence: true },
    orderBy: [{ provider: 'asc' }, { externalId: 'asc' }]
  }
};

function isUniqueViolation(error) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isRecordNotFound(error) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/// Visibility rule for a canonical game: PUBLISHED is public, everything else is
/// only visible to the account that registered it. Tombstones are never returned
/// directly — callers resolve through the merge chain first.
function buildVisibilityWhere(userId) {
  return {
    mergedIntoCatalogGameId: null,
    OR: [
      { publicationStatus: 'PUBLISHED' },
      ...(userId ? [{ createdByUserId: userId }] : [])
    ]
  };
}

/// Deterministic ordering: score desc, then normalized title asc, then id asc.
/// Ties can never reorder between two identical requests.
function compareSearchResults(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  if (left.game.normalizedTitle !== right.game.normalizedTitle) {
    return left.game.normalizedTitle < right.game.normalizedTitle ? -1 : 1;
  }

  return left.game.id < right.game.id ? -1 : 1;
}

async function searchCatalogGames({
  userId = null,
  query,
  locale = null,
  regionCode = null,
  platform = null,
  limit = 20,
  cursor = null
}) {
  const normalizedQuery = normalizeTitle(query);

  if (normalizedQuery.length === 0) {
    return { games: [], meta: { limit, nextCursor: null, matchedBy: 'empty_query', totalScanned: 0 } };
  }

  const visibility = buildVisibilityWhere(userId);
  const localizationMatches = await prisma.gameLocalization.findMany({
    where: {
      normalizedTitle: { startsWith: normalizedQuery },
      ...(locale ? { OR: [{ languageCode: locale }, { languageCode: 'und' }] } : {}),
      ...(regionCode ? { regionCode: { in: [regionCode, 'GLOBAL'] } } : {}),
      catalogGame: visibility
    },
    select: { catalogGameId: true, kind: true },
    take: SEARCH_SCAN_LIMIT
  });

  const candidateIds = new Set(localizationMatches.map((match) => match.catalogGameId));

  const titleMatches = await prisma.catalogGame.findMany({
    where: {
      ...visibility,
      normalizedTitle: { startsWith: normalizedQuery }
    },
    select: { id: true },
    take: SEARCH_SCAN_LIMIT
  });

  for (const match of titleMatches) {
    candidateIds.add(match.id);
  }

  // Fall back to a bounded scan for fuzzy matches only when the deterministic
  // prefix stages found little, so ordinary queries stay index-driven.
  if (candidateIds.size < limit) {
    const firstToken = normalizedQuery.split(' ')[0];
    const fuzzyPool = await prisma.catalogGame.findMany({
      where: {
        ...visibility,
        normalizedTitle: { contains: firstToken }
      },
      select: { id: true },
      take: SEARCH_SCAN_LIMIT
    });

    for (const match of fuzzyPool) {
      candidateIds.add(match.id);
    }
  }

  if (candidateIds.size === 0) {
    return { games: [], meta: { limit, nextCursor: null, matchedBy: 'no_match', totalScanned: 0 } };
  }

  const games = await prisma.catalogGame.findMany({
    where: { id: { in: [...candidateIds] }, ...visibility },
    select: GAME_SUMMARY_SELECT
  });

  const scored = games
    .map((game) => {
      const exact = game.normalizedTitle === normalizedQuery;
      const prefix = game.normalizedTitle.startsWith(normalizedQuery);
      const similarity = titleSimilarity(normalizedQuery, game.normalizedTitle);
      const platformBonus = platform && (game.platforms ?? []).includes(platform) ? 0.05 : 0;
      const score = (exact ? 1 : 0) + (prefix ? 0.4 : 0) + similarity * 0.5 + platformBonus;

      return { game, score, similarity };
    })
    .filter((entry) => entry.similarity >= FUZZY_MATCH_MIN_SIMILARITY
      || entry.game.normalizedTitle.startsWith(normalizedQuery))
    .sort(compareSearchResults);

  const offset = decodeSearchCursor(cursor);
  const page = scored.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    games: page.map((entry) => ({
      ...mapCatalogGameSummary(entry.game),
      matchScore: Number(entry.score.toFixed(4))
    })),
    meta: {
      limit,
      nextCursor: nextOffset < scored.length ? encodeSearchCursor(nextOffset) : null,
      matchedBy: page.length > 0 && page[0].game.normalizedTitle === normalizedQuery
        ? 'normalized_title_exact'
        : 'ranked',
      totalScanned: scored.length
    }
  };
}

function encodeSearchCursor(offset) {
  return Buffer.from(JSON.stringify({ v: 1, o: offset }), 'utf8').toString('base64url');
}

function decodeSearchCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

    return parsed?.v === 1 && Number.isSafeInteger(parsed.o) && parsed.o >= 0 ? parsed.o : 0;
  } catch (error) {
    throw new AppError(400, 'INVALID_CURSOR', 'The supplied catalog cursor could not be decoded');
  }
}

async function getCatalogGameDetail({ userId = null, catalogGameId }) {
  const canonicalId = await resolveCanonicalGameId(catalogGameId);

  if (!canonicalId) {
    throw new AppError(404, 'CATALOG_GAME_NOT_FOUND', 'Catalog game could not be found');
  }

  const game = await prisma.catalogGame.findFirst({
    where: { id: canonicalId, ...buildVisibilityWhere(userId) },
    select: {
      ...GAME_SUMMARY_SELECT,
      steamTags: true,
      supportsSinglePlayer: true,
      supportsMultiplayer: true,
      typicalSessionMinutes: true,
      createdAt: true,
      updatedAt: true,
      localizations: {
        select: { kind: true, languageCode: true, regionCode: true, title: true, provenance: true },
        orderBy: [{ kind: 'asc' }, { languageCode: 'asc' }, { normalizedTitle: 'asc' }]
      },
      regionalReleases: {
        select: {
          id: true,
          countryCode: true,
          languageCode: true,
          platform: true,
          operatorName: true,
          serverRegion: true,
          releaseDate: true,
          shutdownDate: true,
          serviceStatus: true,
          provenance: true
        },
        orderBy: [{ countryCode: 'asc' }, { platform: 'asc' }, { languageCode: 'asc' }]
      },
      assets: {
        select: { kind: true, url: true, rightsStatus: true, provenance: true, attribution: true },
        orderBy: [{ kind: 'asc' }, { url: 'asc' }]
      },
      fieldEvidence: {
        select: {
          fieldPath: true,
          provenance: true,
          confidence: true,
          sourceType: true,
          sourceUrl: true,
          observedAt: true
        },
        orderBy: [{ fieldPath: 'asc' }, { observedAt: 'desc' }]
      }
    }
  });

  if (!game) {
    throw new AppError(404, 'CATALOG_GAME_NOT_FOUND', 'Catalog game could not be found');
  }

  const [followed, requestedId] = await Promise.all([
    userId
      ? prisma.gameFollow.findUnique({
        where: { userId_catalogGameId: { userId, catalogGameId: canonicalId } },
        select: { id: true }
      })
      : Promise.resolve(null),
    Promise.resolve(catalogGameId)
  ]);

  return {
    ...mapCatalogGameDetail(game),
    requestedCatalogGameId: requestedId,
    resolvedFromMerge: requestedId !== canonicalId,
    isFollowedByMe: Boolean(followed)
  };
}

async function followCatalogGame({ userId, catalogGameId, regionalReleaseId = null }) {
  const canonicalId = await resolveCanonicalGameId(catalogGameId);

  if (!canonicalId) {
    throw new AppError(404, 'CATALOG_GAME_NOT_FOUND', 'Catalog game could not be found');
  }

  const visible = await prisma.catalogGame.findFirst({
    where: { id: canonicalId, ...buildVisibilityWhere(userId) },
    select: { id: true }
  });

  if (!visible) {
    throw new AppError(404, 'CATALOG_GAME_NOT_FOUND', 'Catalog game could not be found');
  }

  if (regionalReleaseId) {
    const release = await prisma.regionalRelease.findFirst({
      where: { id: regionalReleaseId, catalogGameId: canonicalId },
      select: { id: true }
    });

    if (!release) {
      throw new AppError(400, 'REGIONAL_RELEASE_MISMATCH', 'The regional release does not belong to this catalog game');
    }
  }

  try {
    await prisma.gameFollow.create({
      data: { userId, catalogGameId: canonicalId, regionalReleaseId },
      select: { id: true }
    });

    return { catalogGameId: canonicalId, following: true, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    // Idempotent: a repeated PUT updates the regional scope without a duplicate.
    await prisma.gameFollow.update({
      where: { userId_catalogGameId: { userId, catalogGameId: canonicalId } },
      data: { regionalReleaseId },
      select: { id: true }
    });

    return { catalogGameId: canonicalId, following: true, created: false };
  }
}

async function unfollowCatalogGame({ userId, catalogGameId }) {
  const canonicalId = await resolveCanonicalGameId(catalogGameId);

  if (!canonicalId) {
    throw new AppError(404, 'CATALOG_GAME_NOT_FOUND', 'Catalog game could not be found');
  }

  try {
    await prisma.gameFollow.delete({
      where: { userId_catalogGameId: { userId, catalogGameId: canonicalId } },
      select: { id: true }
    });

    return { catalogGameId: canonicalId, following: false, removed: true };
  } catch (error) {
    if (!isRecordNotFound(error)) {
      throw error;
    }

    return { catalogGameId: canonicalId, following: false, removed: false };
  }
}

/// A correction is *evidence*, never an in-place edit of a published fact. It
/// records what the user claims plus provenance; promoting it to the published
/// value is an editor decision.
async function submitCatalogCorrection({ userId, catalogGameId, corrections }) {
  const canonicalId = await resolveCanonicalGameId(catalogGameId);

  if (!canonicalId) {
    throw new AppError(404, 'CATALOG_GAME_NOT_FOUND', 'Catalog game could not be found');
  }

  const visible = await prisma.catalogGame.findFirst({
    where: { id: canonicalId, ...buildVisibilityWhere(userId) },
    select: { id: true, createdByUserId: true, publicationStatus: true }
  });

  if (!visible) {
    throw new AppError(404, 'CATALOG_GAME_NOT_FOUND', 'Catalog game could not be found');
  }

  const unknownFields = corrections
    .map((correction) => correction.fieldPath)
    .filter((fieldPath) => !CORRECTABLE_FIELD_PATHS.includes(fieldPath));

  if (unknownFields.length > 0) {
    throw new AppError(400, 'UNCORRECTABLE_FIELD', 'One or more field paths cannot be corrected',
      unknownFields.map((fieldPath) => ({ field: 'fieldPath', message: fieldPath })));
  }

  const observedAt = new Date();
  const created = await prisma.gameFieldEvidence.createMany({
    data: corrections.map((correction) => ({
      catalogGameId: canonicalId,
      fieldPath: correction.fieldPath,
      // A user report is USER_CONFIRMED at most; it can never claim
      // PROVIDER_VERIFIED or EDITOR_VERIFIED provenance from the client side.
      provenance: correction.sourceUrl ? 'OFFICIAL_SOURCE' : 'USER_CONFIRMED',
      confidence: correction.sourceUrl ? 0.7 : 0.5,
      sourceType: correction.sourceUrl ? 'user_supplied_official_url' : 'user_report',
      sourceUrl: correction.sourceUrl ?? null,
      sourceInputHash: correction.valueFingerprint ?? null,
      observedAt
    }))
  });

  logger.info('catalog-correction-recorded', {
    correctionCount: created.count,
    fieldPathCount: new Set(corrections.map((correction) => correction.fieldPath)).size,
    hasSourceUrl: corrections.some((correction) => Boolean(correction.sourceUrl))
  });

  return {
    catalogGameId: canonicalId,
    recordedCount: created.count,
    // Nothing is published by this call. The evidence queue is reviewed first.
    reviewStatus: 'PENDING_REVIEW'
  };
}

module.exports = {
  GLOBAL_REGION_KEY,
  buildVisibilityWhere,
  decodeSearchCursor,
  encodeSearchCursor,
  followCatalogGame,
  getCatalogGameDetail,
  searchCatalogGames,
  submitCatalogCorrection,
  unfollowCatalogGame
};
