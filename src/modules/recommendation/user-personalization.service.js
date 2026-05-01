const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');
const igdbService = require('../igdb/igdb.service');

const HIGH_RATING_THRESHOLD = 4;
const LOW_RATING_THRESHOLD = 2;
const MAX_PROFILE_GAME_IDS = 80;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_RECENT_SIGNALS = 12;
const REVIEW_SNIPPET_LENGTH = 140;

function normalizeGameId(gameId) {
  const value = typeof gameId === 'string' ? gameId.trim() : String(gameId ?? '').trim();

  return value ? value : null;
}

function normalizeNumericRating(value) {
  if (value == null) {
    return null;
  }

  const numericValue = Number(value);

  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function truncateText(value, maxLength) {
  const normalizedValue = normalizeText(value);

  return normalizedValue.length > maxLength ? normalizedValue.slice(0, maxLength) : normalizedValue;
}

function uniqueList(values) {
  return [...new Set((values ?? []).map(normalizeGameId).filter(Boolean))];
}

function normalizeMetadataGame(game) {
  const gameId = normalizeGameId(game?.gameId ?? game?.id);
  const title = normalizeText(game?.title ?? game?.name);

  if (!gameId) {
    return null;
  }

  return {
    gameId,
    title: title || null,
    genres: Array.isArray(game?.genres) ? game.genres.map(normalizeText).filter(Boolean) : [],
    themes: Array.isArray(game?.themes) ? game.themes.map(normalizeText).filter(Boolean) : [],
    keywords: Array.isArray(game?.keywords) ? game.keywords.map(normalizeText).filter(Boolean) : [],
    platforms: Array.isArray(game?.platforms) ? game.platforms.map(normalizeText).filter(Boolean) : [],
    rating: normalizeNumericRating(game?.rating),
    coverUrl: game?.coverUrl ?? null
  };
}

function incrementCounter(counter, values, weight = 1) {
  for (const value of values ?? []) {
    const normalizedValue = normalizeText(value);

    if (!normalizedValue) {
      continue;
    }

    counter.set(normalizedValue, (counter.get(normalizedValue) ?? 0) + weight);
  }
}

function toTopSignals(counter, limit = 8) {
  return [...counter.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function buildEvidenceItem({ gameId, metadata, rating = null, reviewContent = null, playtimeMinutes = null, source = null }) {
  return {
    gameId,
    title: metadata?.title ?? null,
    genres: metadata?.genres?.slice(0, 5) ?? [],
    themes: metadata?.themes?.slice(0, 5) ?? [],
    keywords: metadata?.keywords?.slice(0, 6) ?? [],
    platforms: metadata?.platforms?.slice(0, 6) ?? [],
    rating,
    reviewSnippet: reviewContent ? truncateText(reviewContent, REVIEW_SNIPPET_LENGTH) : null,
    playtimeMinutes: Number.isFinite(Number(playtimeMinutes)) ? Number(playtimeMinutes) : null,
    source
  };
}

function buildRecentSignals({ favorites, reviews, libraryEntries, metadataByGameId, steamToIgdbGameIdMap }) {
  const signals = [];

  for (const favorite of favorites ?? []) {
    const gameId = normalizeGameId(favorite.gameId);

    if (!gameId) {
      continue;
    }

    signals.push({
      type: 'favorite',
      gameId,
      title: metadataByGameId.get(gameId)?.title ?? null,
      at: favorite.createdAt
    });
  }

  for (const review of reviews ?? []) {
    const gameId = normalizeGameId(review.gameId);

    if (!gameId) {
      continue;
    }

    signals.push({
      type: normalizeNumericRating(review.rating) >= HIGH_RATING_THRESHOLD ? 'highRatedReview' : 'review',
      gameId,
      title: metadataByGameId.get(gameId)?.title ?? null,
      rating: normalizeNumericRating(review.rating),
      at: review.updatedAt ?? review.createdAt
    });
  }

  for (const entry of libraryEntries ?? []) {
    const gameId = resolveLibraryIgdbGameId(entry, steamToIgdbGameIdMap);

    if (!gameId || !(Number(entry.playtimeMinutes) > 0)) {
      continue;
    }

    signals.push({
      type: 'played',
      gameId,
      title: metadataByGameId.get(gameId)?.title ?? (normalizeText(entry.gameName) || null),
      playtimeMinutes: Number(entry.playtimeMinutes),
      at: entry.lastPlayedAt ?? entry.updatedAt
    });
  }

  return signals
    .filter((signal) => signal.at)
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
    .slice(0, MAX_RECENT_SIGNALS)
    .map((signal) => ({
      ...signal,
      at: new Date(signal.at).toISOString()
    }));
}

function resolveLibraryIgdbGameId(entry, steamToIgdbGameIdMap = new Map()) {
  const externalGameId = normalizeGameId(entry?.externalGameId);

  if (!externalGameId) {
    return null;
  }

  if (String(entry?.gameSource) === 'IGDB') {
    return externalGameId;
  }

  if (String(entry?.gameSource) === 'STEAM') {
    return normalizeGameId(steamToIgdbGameIdMap.get(externalGameId));
  }

  return null;
}

function buildProfileAvailability(profile) {
  return (
    profile.likedGameIds.length > 0 ||
    profile.reviewedGameIds.length > 0 ||
    profile.playedGameIds.length > 0 ||
    profile.topGenres.length > 0 ||
    profile.topThemes.length > 0 ||
    profile.topKeywords.length > 0 ||
    profile.preferredPlatforms.length > 0
  );
}

function buildPreferenceProfileFromData({
  userId,
  favorites = [],
  reviews = [],
  libraryEntries = [],
  metadataByGameId = new Map(),
  steamToIgdbGameIdMap = new Map()
}) {
  const likedGameIds = uniqueList(favorites.map((favorite) => favorite.gameId));
  const reviewedGameIds = uniqueList(reviews.map((review) => review.gameId));
  const highRatedGameIds = uniqueList(reviews
    .filter((review) => normalizeNumericRating(review.rating) >= HIGH_RATING_THRESHOLD)
    .map((review) => review.gameId));
  const lowRatedGameIds = uniqueList(reviews
    .filter((review) => normalizeNumericRating(review.rating) <= LOW_RATING_THRESHOLD)
    .map((review) => review.gameId));
  const ownedGameIds = uniqueList(libraryEntries.map((entry) => resolveLibraryIgdbGameId(entry, steamToIgdbGameIdMap)));
  const playedGameIds = uniqueList(libraryEntries
    .filter((entry) => Number(entry.playtimeMinutes) > 0)
    .map((entry) => resolveLibraryIgdbGameId(entry, steamToIgdbGameIdMap)));

  const genreCounter = new Map();
  const themeCounter = new Map();
  const keywordCounter = new Map();
  const platformCounter = new Map();
  const avoidGenreCounter = new Map();
  const likedGenreCounter = new Map();
  const highRatedGenreCounter = new Map();
  const playedGenreCounter = new Map();
  const lowRatedGenreCounter = new Map();

  for (const gameId of likedGameIds) {
    const metadata = metadataByGameId.get(gameId);

    if (!metadata) {
      continue;
    }

    incrementCounter(genreCounter, metadata.genres, 1.4);
    incrementCounter(themeCounter, metadata.themes, 1.2);
    incrementCounter(keywordCounter, metadata.keywords, 1.1);
    incrementCounter(platformCounter, metadata.platforms, 1);
    incrementCounter(likedGenreCounter, metadata.genres, 1);
  }

  for (const gameId of highRatedGameIds) {
    const metadata = metadataByGameId.get(gameId);

    if (!metadata) {
      continue;
    }

    incrementCounter(genreCounter, metadata.genres, 1.8);
    incrementCounter(themeCounter, metadata.themes, 1.5);
    incrementCounter(keywordCounter, metadata.keywords, 1.3);
    incrementCounter(platformCounter, metadata.platforms, 1);
    incrementCounter(highRatedGenreCounter, metadata.genres, 1);
  }

  for (const gameId of playedGameIds) {
    const metadata = metadataByGameId.get(gameId);

    if (!metadata) {
      continue;
    }

    incrementCounter(genreCounter, metadata.genres, 1.1);
    incrementCounter(themeCounter, metadata.themes, 1);
    incrementCounter(keywordCounter, metadata.keywords, 0.8);
    incrementCounter(platformCounter, metadata.platforms, 1.2);
    incrementCounter(playedGenreCounter, metadata.genres, 1);
  }

  for (const gameId of lowRatedGameIds) {
    const metadata = metadataByGameId.get(gameId);

    if (!metadata) {
      continue;
    }

    incrementCounter(avoidGenreCounter, metadata.genres, 1);
    incrementCounter(lowRatedGenreCounter, metadata.genres, 1);
  }

  const reviewsByGameId = new Map(reviews.map((review) => [normalizeGameId(review.gameId), review]));
  const libraryByGameId = new Map(
    libraryEntries
      .map((entry) => [resolveLibraryIgdbGameId(entry, steamToIgdbGameIdMap), entry])
      .filter(([gameId]) => Boolean(gameId))
  );
  const evidence = {
    likedGames: likedGameIds.slice(0, MAX_EVIDENCE_ITEMS).map((gameId) => buildEvidenceItem({
      gameId,
      metadata: metadataByGameId.get(gameId),
      source: 'favorite'
    })),
    highRatedGames: highRatedGameIds.slice(0, MAX_EVIDENCE_ITEMS).map((gameId) => {
      const review = reviewsByGameId.get(gameId);

      return buildEvidenceItem({
        gameId,
        metadata: metadataByGameId.get(gameId),
        rating: normalizeNumericRating(review?.rating),
        reviewContent: review?.content,
        source: 'review'
      });
    }),
    lowRatedGames: lowRatedGameIds.slice(0, MAX_EVIDENCE_ITEMS).map((gameId) => {
      const review = reviewsByGameId.get(gameId);

      return buildEvidenceItem({
        gameId,
        metadata: metadataByGameId.get(gameId),
        rating: normalizeNumericRating(review?.rating),
        reviewContent: review?.content,
        source: 'review'
      });
    }),
    playedGames: playedGameIds.slice(0, MAX_EVIDENCE_ITEMS).map((gameId) => {
      const entry = libraryByGameId.get(gameId);

      return buildEvidenceItem({
        gameId,
        metadata: metadataByGameId.get(gameId),
        playtimeMinutes: entry?.playtimeMinutes,
        source: 'library'
      });
    })
  };

  const profile = {
    userId,
    likedGameIds,
    reviewedGameIds,
    highRatedGameIds,
    lowRatedGameIds,
    ownedGameIds,
    playedGameIds,
    topGenres: toTopSignals(genreCounter),
    topThemes: toTopSignals(themeCounter),
    topKeywords: toTopSignals(keywordCounter),
    preferredPlatforms: toTopSignals(platformCounter),
    avoidGenres: toTopSignals(avoidGenreCounter),
    negativeSignals: toTopSignals(lowRatedGenreCounter).map((signal) => ({
      type: 'lowRatedGenre',
      ...signal
    })),
    recentSignals: buildRecentSignals({
      favorites,
      reviews,
      libraryEntries,
      metadataByGameId,
      steamToIgdbGameIdMap
    }),
    evidence,
    signalSets: {
      likedGenres: toTopSignals(likedGenreCounter),
      highRatedGenres: toTopSignals(highRatedGenreCounter),
      playedGenres: toTopSignals(playedGenreCounter),
      lowRatedGenres: toTopSignals(lowRatedGenreCounter)
    },
    personalizationAvailable: false
  };

  profile.personalizationAvailable = buildProfileAvailability(profile);

  return profile;
}

function createEmptyPreferenceProfile(userId) {
  return buildPreferenceProfileFromData({ userId });
}

async function resolveSteamMappings(libraryEntries) {
  const steamAppIds = uniqueList((libraryEntries ?? [])
    .filter((entry) => String(entry.gameSource) === 'STEAM')
    .map((entry) => entry.externalGameId));

  if (steamAppIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.steamIgdbMapping.findMany({
    where: {
      steamAppId: {
        in: steamAppIds
      },
      igdbGameId: {
        not: null
      },
      matchStatus: 'CONFIRMED'
    },
    select: {
      steamAppId: true,
      igdbGameId: true
    }
  });

  return new Map(rows.map((row) => [row.steamAppId, row.igdbGameId]));
}

async function fetchGameMetadata(gameIds) {
  const normalizedGameIds = uniqueList(gameIds).slice(0, MAX_PROFILE_GAME_IDS);

  if (normalizedGameIds.length === 0 || !env.twitchClientId || !env.twitchClientSecret) {
    return new Map();
  }

  try {
    const result = await igdbService.getGamesByIds({ gameIds: normalizedGameIds });
    const metadataEntries = (result.games ?? [])
      .map(normalizeMetadataGame)
      .filter(Boolean)
      .map((game) => [game.gameId, game]);

    return new Map(metadataEntries);
  } catch (error) {
    logger.warn('AI personalization metadata lookup failed', {
      requestedCount: normalizedGameIds.length,
      code: error?.code ?? null,
      message: error?.message ?? 'unknown'
    });

    return new Map();
  }
}

function applyGameMetadataToProfile(profile, games) {
  const metadataByGameId = new Map(
    (games ?? [])
      .map(normalizeMetadataGame)
      .filter(Boolean)
      .map((game) => [game.gameId, game])
  );

  if (metadataByGameId.size === 0) {
    return profile;
  }

  const metadataRows = [...metadataByGameId.values()];
  const favorites = profile.likedGameIds.map((gameId) => ({ gameId, createdAt: null }));
  const reviews = [
    ...profile.highRatedGameIds.map((gameId) => ({ gameId, rating: HIGH_RATING_THRESHOLD, content: '', createdAt: null, updatedAt: null })),
    ...profile.lowRatedGameIds.map((gameId) => ({ gameId, rating: LOW_RATING_THRESHOLD, content: '', createdAt: null, updatedAt: null })),
    ...profile.reviewedGameIds
      .filter((gameId) => !profile.highRatedGameIds.includes(gameId) && !profile.lowRatedGameIds.includes(gameId))
      .map((gameId) => ({ gameId, rating: null, content: '', createdAt: null, updatedAt: null }))
  ];
  const libraryEntries = profile.playedGameIds.map((gameId) => ({
    gameSource: 'IGDB',
    externalGameId: gameId,
    gameName: metadataByGameId.get(gameId)?.title ?? '',
    playtimeMinutes: 1,
    lastPlayedAt: null,
    updatedAt: null
  }));

  const rebuiltProfile = buildPreferenceProfileFromData({
    userId: profile.userId,
    favorites,
    reviews,
    libraryEntries,
    metadataByGameId: new Map(metadataRows.map((game) => [game.gameId, game]))
  });

  return {
    ...profile,
    topGenres: rebuiltProfile.topGenres.length > 0 ? rebuiltProfile.topGenres : profile.topGenres,
    topThemes: rebuiltProfile.topThemes.length > 0 ? rebuiltProfile.topThemes : profile.topThemes,
    topKeywords: rebuiltProfile.topKeywords.length > 0 ? rebuiltProfile.topKeywords : profile.topKeywords,
    preferredPlatforms: rebuiltProfile.preferredPlatforms.length > 0 ? rebuiltProfile.preferredPlatforms : profile.preferredPlatforms,
    avoidGenres: rebuiltProfile.avoidGenres.length > 0 ? rebuiltProfile.avoidGenres : profile.avoidGenres,
    negativeSignals: rebuiltProfile.negativeSignals.length > 0 ? rebuiltProfile.negativeSignals : profile.negativeSignals,
    signalSets: rebuiltProfile.signalSets,
    evidence: {
      likedGames: mergeEvidence(profile.evidence.likedGames, rebuiltProfile.evidence.likedGames),
      highRatedGames: mergeEvidence(profile.evidence.highRatedGames, rebuiltProfile.evidence.highRatedGames),
      lowRatedGames: mergeEvidence(profile.evidence.lowRatedGames, rebuiltProfile.evidence.lowRatedGames),
      playedGames: mergeEvidence(profile.evidence.playedGames, rebuiltProfile.evidence.playedGames)
    },
    personalizationAvailable: profile.personalizationAvailable || rebuiltProfile.personalizationAvailable
  };
}

function mergeEvidence(existingItems, updatedItems) {
  const updatedByGameId = new Map((updatedItems ?? []).map((item) => [item.gameId, item]));

  return (existingItems ?? []).map((item) => {
    const updatedItem = updatedByGameId.get(item.gameId);

    if (!updatedItem) {
      return item;
    }

    return {
      ...item,
      title: updatedItem.title ?? item.title,
      genres: updatedItem.genres?.length > 0 ? updatedItem.genres : item.genres,
      themes: updatedItem.themes?.length > 0 ? updatedItem.themes : item.themes,
      keywords: updatedItem.keywords?.length > 0 ? updatedItem.keywords : item.keywords,
      platforms: updatedItem.platforms?.length > 0 ? updatedItem.platforms : item.platforms,
      rating: item.rating ?? updatedItem.rating,
      reviewSnippet: item.reviewSnippet ?? updatedItem.reviewSnippet,
      playtimeMinutes: item.playtimeMinutes ?? updatedItem.playtimeMinutes,
      source: item.source ?? updatedItem.source
    };
  });
}

function sanitizePreferenceProfileForPrompt(profile) {
  return {
    likedGameIds: profile.likedGameIds.slice(0, 30),
    reviewedGameIds: profile.reviewedGameIds.slice(0, 30),
    highRatedGameIds: profile.highRatedGameIds.slice(0, 30),
    lowRatedGameIds: profile.lowRatedGameIds.slice(0, 30),
    playedGameIds: profile.playedGameIds.slice(0, 30),
    topGenres: profile.topGenres,
    topThemes: profile.topThemes,
    topKeywords: profile.topKeywords,
    preferredPlatforms: profile.preferredPlatforms,
    avoidGenres: profile.avoidGenres,
    negativeSignals: profile.negativeSignals,
    recentSignals: profile.recentSignals,
    evidence: profile.evidence,
    personalizationAvailable: profile.personalizationAvailable
  };
}

async function buildUserPreferenceProfile({ userId }) {
  const [favorites, reviews, libraryEntries] = await Promise.all([
    prisma.favoriteGame.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: MAX_PROFILE_GAME_IDS,
      select: {
        gameId: true,
        createdAt: true
      }
    }),
    prisma.review.findMany({
      where: { userId },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' }
      ],
      take: MAX_PROFILE_GAME_IDS,
      select: {
        gameId: true,
        rating: true,
        content: true,
        createdAt: true,
        updatedAt: true
      }
    }),
    prisma.userGameLibrary.findMany({
      where: { userId },
      orderBy: [
        { lastPlayedAt: 'desc' },
        { updatedAt: 'desc' }
      ],
      take: MAX_PROFILE_GAME_IDS,
      select: {
        gameSource: true,
        externalGameId: true,
        gameName: true,
        coverUrl: true,
        playtimeMinutes: true,
        lastPlayedAt: true,
        updatedAt: true
      }
    })
  ]);
  const steamToIgdbGameIdMap = await resolveSteamMappings(libraryEntries);
  const profileGameIds = uniqueList([
    ...favorites.map((favorite) => favorite.gameId),
    ...reviews.map((review) => review.gameId),
    ...libraryEntries.map((entry) => resolveLibraryIgdbGameId(entry, steamToIgdbGameIdMap))
  ]);
  const metadataByGameId = await fetchGameMetadata(profileGameIds);
  const profile = buildPreferenceProfileFromData({
    userId,
    favorites,
    reviews,
    libraryEntries,
    metadataByGameId,
    steamToIgdbGameIdMap
  });

  logger.info('AI personalization profile built', {
    userId,
    likedCount: profile.likedGameIds.length,
    reviewedCount: profile.reviewedGameIds.length,
    highRatedCount: profile.highRatedGameIds.length,
    lowRatedCount: profile.lowRatedGameIds.length,
    playedCount: profile.playedGameIds.length,
    topGenresCount: profile.topGenres.length,
    personalizationAvailable: profile.personalizationAvailable
  });

  return profile;
}

module.exports = {
  HIGH_RATING_THRESHOLD,
  LOW_RATING_THRESHOLD,
  applyGameMetadataToProfile,
  buildPreferenceProfileFromData,
  buildUserPreferenceProfile,
  createEmptyPreferenceProfile,
  sanitizePreferenceProfileForPrompt
};
