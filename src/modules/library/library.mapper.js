const {
  buildGameImageResolverUrl,
  extractUsableIgdbCoverUrl
} = require('./library-image.service');
const { logger } = require('../../utils/logger');

function mapGameSource(source) {
  if (source === 'STEAM' || source === 'steam') {
    return 'steam';
  }

  return 'igdb';
}

function mapLibraryStatus(status) {
  if (typeof status !== 'string') {
    return null;
  }

  return status.toLowerCase();
}

function resolveSteamEnrichmentStatus({ gameSource, metadataEnriched, matchStatus = null }) {
  const normalizedGameSource = mapGameSource(gameSource);

  if (normalizedGameSource !== 'steam') {
    return null;
  }

  if (metadataEnriched) {
    return 'steam_plus_igdb_enriched';
  }

  if (matchStatus === 'CANDIDATE') {
    return 'enrichment_pending';
  }

  if (matchStatus === 'UNMATCHED' || matchStatus === 'REJECTED') {
    return 'enrichment_failed';
  }

  return 'steam_only';
}

function buildLibraryDetailIdentity({
  gameSource,
  externalGameId,
  gameName,
  coverUrl,
  igdbGameId,
  rating = null,
  aggregatedRating = null,
  totalRating = null,
  metadataEnriched,
  matchStatus = null
}) {
  const normalizedGameSource = mapGameSource(gameSource);
  const normalizedIgdbGameId = String(igdbGameId ?? '').trim();
  const numericGameId = normalizedIgdbGameId && /^\d+$/.test(normalizedIgdbGameId)
    ? Number.parseInt(normalizedIgdbGameId, 10)
    : null;

  return {
    gameSource: normalizedGameSource,
    externalGameId,
    gameName,
    coverUrl,
    gameId: Number.isInteger(numericGameId) && numericGameId > 0 ? numericGameId : null,
    igdbGameId: normalizedIgdbGameId || null,
    rating: typeof rating === 'number' ? rating : null,
    aggregatedRating: typeof aggregatedRating === 'number' ? aggregatedRating : null,
    totalRating: typeof totalRating === 'number' ? totalRating : null,
    metadataEnriched: Boolean(metadataEnriched),
    enrichmentStatus: resolveSteamEnrichmentStatus({
      gameSource: normalizedGameSource,
      metadataEnriched: Boolean(metadataEnriched),
      matchStatus
    }),
    detailAvailable: Number.isInteger(numericGameId) && numericGameId > 0
  };
}

function mapSteamLinkStatus(steamAccount) {
  if (!steamAccount) {
    return {
      isLinked: false,
      steamId64: null,
      personaName: null,
      avatarUrl: null,
      profileUrl: null,
      linkedAt: null
    };
  }

  return {
    isLinked: true,
    steamId64: steamAccount.providerSubject,
    personaName: steamAccount.personaName ?? null,
    avatarUrl: steamAccount.avatarUrl ?? null,
    profileUrl: steamAccount.profileUrl ?? null,
    linkedAt: steamAccount.linkedAt
  };
}

function mapLibraryStatusEntry(entry, options = {}) {
  const source = mapGameSource(entry.gameSource);
  const resolvedIgdbCoverUrl = extractUsableIgdbCoverUrl(options.igdbCoverUrl ?? entry.coverUrl);
  const resolvedCoverUrl = source === 'steam'
    ? buildGameImageResolverUrl({
      gameSource: source,
      externalGameId: entry.externalGameId,
      igdbCoverUrl: resolvedIgdbCoverUrl
    })
    : (entry.coverUrl ?? null);
  const identity = buildLibraryDetailIdentity({
    gameSource: source,
    externalGameId: entry.externalGameId,
    gameName: entry.gameName,
    coverUrl: resolvedCoverUrl,
    igdbGameId: options.igdbGameId ?? (source === 'igdb' ? entry.externalGameId : null),
    rating: options.rating ?? null,
    aggregatedRating: options.aggregatedRating ?? null,
    totalRating: options.totalRating ?? null,
    metadataEnriched: options.metadataEnriched ?? false,
    matchStatus: options.matchStatus ?? null
  });
  logger.info('[LibraryRating]', {
    title: entry.gameName ?? null,
    externalGameId: entry.externalGameId,
    igdbGameId: identity.igdbGameId,
    aggregatedRating: identity.aggregatedRating,
    totalRating: identity.totalRating
  });

  return {
    source,
    externalGameId: entry.externalGameId,
    title: entry.gameName,
    coverUrl: resolvedCoverUrl,
    status: mapLibraryStatus(entry.status),
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    lastPlayedAt: entry.lastPlayedAt,
    playtimeMinutes: Number.isInteger(entry.playtimeMinutes) ? entry.playtimeMinutes : null,
    recentPlaytimeMinutes: Number.isInteger(entry.recentPlaytimeMinutes) ? entry.recentPlaytimeMinutes : null,
    updatedAt: entry.updatedAt,
    ...identity
  };
}

function mapWishlistItem(favorite, game) {
  const coverUrl = game?.coverUrl ?? null;
  const identity = buildLibraryDetailIdentity({
    gameSource: 'igdb',
    externalGameId: favorite.gameId,
    gameName: game?.name ?? null,
    coverUrl,
    igdbGameId: favorite.gameId,
    rating: game?.rating ?? null,
    aggregatedRating: game?.aggregatedRating ?? null,
    totalRating: game?.totalRating ?? null,
    metadataEnriched: Boolean(game)
  });
  logger.info('[LibraryRating]', {
    title: game?.name ?? null,
    externalGameId: favorite.gameId,
    igdbGameId: identity.igdbGameId,
    aggregatedRating: identity.aggregatedRating,
    totalRating: identity.totalRating
  });

  return {
    source: 'igdb',
    externalGameId: favorite.gameId,
    title: game?.name ?? null,
    coverUrl,
    favoritedAt: favorite.createdAt,
    ...identity
  };
}

function mapReviewedItem(review, game) {
  const coverUrl = game?.coverUrl ?? null;
  const reviewContent = typeof review?.content === 'string' ? review.content.trim() : '';
  const identity = buildLibraryDetailIdentity({
    gameSource: 'igdb',
    externalGameId: review.gameId,
    gameName: game?.name ?? null,
    coverUrl,
    igdbGameId: review.gameId,
    rating: game?.rating ?? null,
    aggregatedRating: game?.aggregatedRating ?? null,
    totalRating: game?.totalRating ?? null,
    metadataEnriched: Boolean(game)
  });
  logger.info('[LibraryRating]', {
    title: game?.name ?? null,
    externalGameId: review.gameId,
    igdbGameId: identity.igdbGameId,
    aggregatedRating: identity.aggregatedRating,
    totalRating: identity.totalRating
  });

  return {
    source: 'igdb',
    externalGameId: review.gameId,
    title: game?.name ?? null,
    coverUrl,
    reviewId: review.id,
    rating: identity.rating,
    userRating: review.rating,
    reviewSnippet: reviewContent ? reviewContent.slice(0, 140) : null,
    reviewedAt: review.createdAt,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    ...identity
  };
}

module.exports = {
  mapLibraryStatus,
  mapLibraryStatusEntry,
  mapReviewedItem,
  resolveSteamEnrichmentStatus,
  mapSteamLinkStatus,
  mapWishlistItem
};
