const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');
const igdbService = require('../igdb/igdb.service');

const TARGET_CANDIDATE_COUNT = 50;

const STATIC_FALLBACK_GAMES = [
  {
    gameId: '17000',
    title: 'Stardew Valley',
    coverUrl: null,
    platforms: ['PC', 'Nintendo Switch', 'PlayStation', 'Xbox'],
    genres: ['Simulator', 'Role-playing', 'Adventure', 'Indie'],
    rating: 89.2,
    summary: 'A cozy farming and life simulation game with flexible session length.'
  },
  {
    gameId: '132181',
    title: 'Unpacking',
    coverUrl: null,
    platforms: ['PC', 'Nintendo Switch', 'Xbox', 'PlayStation'],
    genres: ['Puzzle', 'Simulator', 'Indie'],
    rating: 83,
    summary: 'A calm puzzle game about arranging belongings through life stages.'
  },
  {
    gameId: '106987',
    title: 'A Short Hike',
    coverUrl: null,
    platforms: ['PC', 'Nintendo Switch', 'PlayStation', 'Xbox'],
    genres: ['Adventure', 'Indie'],
    rating: 86,
    summary: 'A relaxed exploration game that works well in short sessions.'
  },
  {
    gameId: '7346',
    title: 'Journey',
    coverUrl: null,
    platforms: ['PC', 'PlayStation', 'iOS'],
    genres: ['Adventure', 'Indie'],
    rating: 88,
    summary: 'A short atmospheric adventure focused on mood and exploration.'
  },
  {
    gameId: '131951',
    title: 'Dorfromantik',
    coverUrl: null,
    platforms: ['PC', 'Nintendo Switch'],
    genres: ['Puzzle', 'Strategy', 'Simulator', 'Indie'],
    rating: 82,
    summary: 'A peaceful tile placement game with low pressure sessions.'
  },
  {
    gameId: '20342',
    title: 'Celeste',
    coverUrl: null,
    platforms: ['PC', 'Nintendo Switch', 'PlayStation', 'Xbox'],
    genres: ['Platform', 'Adventure', 'Indie'],
    rating: 91,
    summary: 'A highly rated platformer with short levels and precise challenge.'
  },
  {
    gameId: '113112',
    title: 'Hades',
    coverUrl: null,
    platforms: ['PC', 'Nintendo Switch', 'PlayStation', 'Xbox'],
    genres: ['Role-playing', 'Adventure', 'Indie'],
    rating: 92,
    summary: 'A polished action roguelite built around repeatable sessions.'
  },
  {
    gameId: '119171',
    title: 'PowerWash Simulator',
    coverUrl: null,
    platforms: ['PC', 'Nintendo Switch', 'PlayStation', 'Xbox'],
    genres: ['Simulator', 'Indie'],
    rating: 78,
    summary: 'A low-pressure cleaning simulator suited to relaxing play.'
  },
  {
    gameId: '119133',
    title: 'Animal Crossing: New Horizons',
    coverUrl: null,
    platforms: ['Nintendo Switch'],
    genres: ['Simulator'],
    rating: 85,
    summary: 'A cozy life simulation game built around daily bite-sized routines.'
  },
  {
    gameId: '1020',
    title: 'Minecraft',
    coverUrl: null,
    platforms: ['PC', 'Nintendo Switch', 'PlayStation', 'Xbox', 'iOS', 'Android'],
    genres: ['Adventure', 'Simulator'],
    rating: 84,
    summary: 'A flexible sandbox that can be relaxing, creative, or social.'
  }
];

function normalizeGameId(gameId) {
  const value = typeof gameId === 'string' ? gameId.trim() : String(gameId ?? '').trim();

  return /^\d+$/.test(value) ? value : null;
}

function normalizeToken(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    : '';
}

function normalizeCandidate(game) {
  const gameId = normalizeGameId(game?.id ?? game?.gameId);
  const title = typeof game?.name === 'string' ? game.name : game?.title;

  if (!gameId || typeof title !== 'string' || !title.trim()) {
    return null;
  }

  return {
    gameId,
    title: title.trim(),
    coverUrl: game.coverUrl ?? null,
    platforms: Array.isArray(game.platforms) ? game.platforms.filter(Boolean) : [],
    genres: Array.isArray(game.genres) ? game.genres.filter(Boolean) : [],
    themes: Array.isArray(game.themes) ? game.themes.filter(Boolean) : [],
    keywords: Array.isArray(game.keywords) ? game.keywords.filter(Boolean) : [],
    rating: typeof game.rating === 'number' ? Math.round(game.rating * 10) / 10 : null,
    summary: typeof game.summary === 'string' ? game.summary : null,
    candidateSource: game.candidateSource ?? 'candidate_provider'
  };
}

function hasLooseMatch(actualValues, requestedValues) {
  const requestedTokens = (requestedValues ?? []).map(normalizeToken).filter(Boolean);

  if (requestedTokens.length === 0) {
    return true;
  }

  const actualTokens = (actualValues ?? []).map(normalizeToken).filter(Boolean);

  return requestedTokens.some((requestedToken) => actualTokens.some((actualToken) => (
    actualToken.includes(requestedToken) || requestedToken.includes(actualToken)
  )));
}

function mergeCandidates(candidateGroups, excludedGameIds = []) {
  const excludedSet = new Set((excludedGameIds ?? []).map(normalizeGameId).filter(Boolean));
  const candidateMap = new Map();

  for (const group of candidateGroups) {
    for (const rawGame of group ?? []) {
      const candidate = normalizeCandidate(rawGame);

      if (!candidate || excludedSet.has(candidate.gameId) || candidateMap.has(candidate.gameId)) {
        continue;
      }

      candidateMap.set(candidate.gameId, candidate);
    }
  }

  return [...candidateMap.values()];
}

function filterCandidatesByPreferences(candidates, { platforms = [], preferredGenres = [] }) {
  const requestedPlatforms = platforms.filter(Boolean);
  const requestedGenres = preferredGenres.filter(Boolean);

  if (requestedPlatforms.length === 0 && requestedGenres.length === 0) {
    return candidates;
  }

  const filtered = candidates.filter((candidate) => (
    hasLooseMatch(candidate.platforms, requestedPlatforms) &&
    hasLooseMatch(candidate.genres, requestedGenres)
  ));

  return filtered.length > 0 ? filtered : candidates;
}

function buildSearchQueries({ query, preferredGenres = [] }) {
  return [
    query,
    ...preferredGenres
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .slice(0, 4);
}

async function safelyFetch(fetcher, context) {
  try {
    return await fetcher();
  } catch (error) {
    logger.warn('AI recommendation candidate source failed', {
      source: context,
      code: error?.code ?? null,
      message: error?.message ?? 'unknown'
    });

    return { games: [] };
  }
}

async function getGameCandidates({
  query,
  platforms = [],
  preferredGenres = [],
  excludedGameIds = [],
  targetCount = TARGET_CANDIDATE_COUNT
}) {
  const candidateGroups = [];

  if (env.twitchClientId && env.twitchClientSecret) {
    const searchQueries = buildSearchQueries({ query, preferredGenres });

    const searchResults = await Promise.all(searchQueries.map((searchQuery) => safelyFetch(
      () => igdbService.searchGames({ query: searchQuery, limit: 30 }),
      `igdb-search:${searchQuery}`
    )));

    candidateGroups.push(...searchResults.map((result) => result.games ?? []));

    const [recommendedResult, popularResult] = await Promise.all([
      safelyFetch(() => igdbService.getRecommendedGames({ limit: 50 }), 'igdb-recommended'),
      safelyFetch(() => igdbService.getPopularGames({ limit: 50 }), 'igdb-popular')
    ]);

    candidateGroups.push(recommendedResult.games ?? [], popularResult.games ?? []);
  }

  candidateGroups.push(STATIC_FALLBACK_GAMES);

  const mergedCandidates = mergeCandidates(candidateGroups, excludedGameIds);
  const filteredCandidates = filterCandidatesByPreferences(mergedCandidates, { platforms, preferredGenres });

  return filteredCandidates.slice(0, targetCount);
}

module.exports = {
  STATIC_FALLBACK_GAMES,
  getGameCandidates,
  mergeCandidates
};
