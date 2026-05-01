const { env } = require('../../config/env');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/error-response');
const searchQueryTranslationService = require('../../services/search-query-translation.service');
const {
  appendSearchLog,
  buildSearchLogRecord
} = require('../../services/search-log.service');
const {
  buildCanonicalCandidateCacheKey,
  getCachedSearch,
  getCachedSuggestions,
  setCachedSearch,
  setCachedSuggestions
} = require('./igdb.search-cache');
const {
  buildFallbackCandidateQueries,
  buildSearchCandidateQueries,
  explainGameMatchReasons,
  mergeGamesById,
  normalizeQuery,
  rankGames
} = require('./igdb.search-utils');
const {
  mapGameDetail,
  mapGameList,
  mapGameSuggestions
} = require('./igdb.mapper');

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const IGDB_BASE_URL = 'https://api.igdb.com/v4';
const DEFAULT_LIMIT = 10;
const HIGHLIGHTS_LIMIT = 5;
const SEARCH_LIMIT = 20;
const SUGGESTION_LIMIT = 6;
const SUGGESTION_MAX_LIMIT = 8;
const SEARCH_PIPELINE_MIN_LIMIT = 20;
const SEARCH_CANDIDATE_QUERY_LIMIT = 8;
const SEARCH_EXACT_QUERY_FETCH_LIMIT = 20;
const SEARCH_WILDCARD_QUERY_FETCH_LIMIT = 50;
const SUGGESTION_EXACT_QUERY_FETCH_LIMIT = 20;
const SUGGESTION_WILDCARD_QUERY_FETCH_LIMIT = 50;
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;
const STEAM_EXTERNAL_GAME_SOURCE = 1;
const FILTERED_COLLECTION_MULTIPLIER = 4;
const FILTERED_COLLECTION_MAX_LIMIT = 60;
const IGDB_DETAIL_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const IGDB_BATCH_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const IGDB_RATE_LIMIT_COOLDOWN_MS = 1000 * 60;
const IGDB_CACHE_MAX_ENTRIES = 1000;
const HOME_PLATFORM_MATCHERS = {
  steam: [/pc \(microsoft windows\)/i, /\bmac\b/i, /linux/i],
  playstation: [/playstation/i],
  nintendo: [/nintendo/i, /switch/i, /wii/i],
  xbox: [/\bxbox\b/i],
  mobile: [/\bios\b/i, /android/i, /\bmobile\b/i]
};
const HOME_CATEGORY_MATCHERS = {
  action: ['action'],
  rpg: ['role-playing (rpg)', 'rpg'],
  strategy: ['strategy'],
  simulation: ['simulation', 'simulator'],
  sports: ['sport'],
  adventure: ['adventure'],
  indie: ['indie'],
  horror: ['horror'],
  puzzle: ['puzzle']
};
const HOME_GAME_MODE_MATCHERS = {
  singleplayer: ['single player', 'single-player', 'singleplayer'],
  multiplayer: ['multiplayer', 'massively multiplayer online (mmo)', 'mmo'],
  coop: ['co-operative', 'co op', 'co-op', 'coop'],
  pvp: ['player versus player', 'pvp', 'battle royale']
};

const GAME_LIST_FIELDS = [
  'id',
  'name',
  'summary',
  'cover.url',
  'genres.name',
  'game_modes.name',
  'platforms.name',
  'rating',
  'total_rating',
  'total_rating_count',
  'aggregated_rating',
  'aggregated_rating_count',
  'first_release_date'
].join(', ');

const SUGGESTION_FIELDS = [
  'id',
  'name',
  'cover.url',
  'rating',
  'total_rating',
  'total_rating_count',
  'aggregated_rating',
  'aggregated_rating_count',
  'first_release_date'
].join(', ');

const DETAIL_FIELDS = [
  'id',
  'name',
  'summary',
  'storyline',
  'cover.url',
  'artworks.url',
  'screenshots.url',
  'genres.name',
  'platforms.name',
  'involved_companies.company.name',
  'involved_companies.developer',
  'involved_companies.publisher',
  'first_release_date',
  'rating',
  'aggregated_rating',
  'total_rating',
  'status',
  'category'
].join(', ');

const STEAM_MATCH_FIELDS = [
  'id',
  'name',
  'cover.url',
  'alternative_names.name',
  'franchises.name',
  'platforms.name',
  'first_release_date',
  'version_parent.id',
  'category',
  'rating',
  'total_rating',
  'total_rating_count',
  'aggregated_rating',
  'aggregated_rating_count'
].join(', ');

const EXTERNAL_GAME_FIELDS = [
  'uid',
  'name',
  'game',
  'year',
  'external_game_source'
].join(', ');

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
  pendingPromise: null
};
let searchAnalyticsDisabled = false;
let igdbRateLimitedUntil = 0;
let igdbRateLimitWindowId = 0;
const igdbDetailCache = new Map();
const igdbBatchGameCache = new Map();
const pendingGameDetailRequests = new Map();
const pendingGamesByIdsRequests = new Map();
const igdbCooldownLoggedPaths = new Set();

function cloneCacheValue(value) {
  if (value == null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function getCacheEntry(cache, key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  cache.delete(key);
  cache.set(key, entry);
  return cloneCacheValue(entry.value);
}

function setCacheEntry(cache, key, value, ttlMs) {
  cache.set(key, {
    value: cloneCacheValue(value),
    expiresAt: Date.now() + ttlMs
  });

  if (cache.size <= IGDB_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = cache.keys().next().value;

  if (oldestKey !== undefined) {
    cache.delete(oldestKey);
  }
}

function normalizeGameId(gameId) {
  const normalizedValue = typeof gameId === 'string'
    ? gameId.trim()
    : String(gameId ?? '').trim();

  return /^\d+$/.test(normalizedValue) ? normalizedValue : null;
}

function isIgdbRateLimitCooldownActive() {
  return igdbRateLimitedUntil > Date.now();
}

function getRateLimitCooldownRemainingMs() {
  return Math.max(igdbRateLimitedUntil - Date.now(), 0);
}

function enterIgdbRateLimitCooldown({ path, status, body = null }) {
  igdbRateLimitedUntil = Date.now() + IGDB_RATE_LIMIT_COOLDOWN_MS;
  igdbRateLimitWindowId += 1;
  igdbCooldownLoggedPaths.clear();

  logger.warn('igdb-rate-limit-entered', {
    path,
    status,
    cooldownMs: IGDB_RATE_LIMIT_COOLDOWN_MS
  });

  logger.warn('IGDB upstream rate limited request', {
    path,
    status,
    body: typeof body === 'string' ? body.slice(0, 300) : null,
    cooldownMs: IGDB_RATE_LIMIT_COOLDOWN_MS
  });
}

function logIgdbCooldownActive(path) {
  const logKey = `${igdbRateLimitWindowId}:${path}`;

  if (igdbCooldownLoggedPaths.has(logKey)) {
    return;
  }

  igdbCooldownLoggedPaths.add(logKey);
  logger.warn('igdb-rate-limit-cooldown-active', {
    path,
    cooldownRemainingMs: getRateLimitCooldownRemainingMs()
  });
}

function getIgdbRateLimitState() {
  return {
    active: isIgdbRateLimitCooldownActive(),
    cooldownRemainingMs: getRateLimitCooldownRemainingMs()
  };
}

function createIgdbRateLimitedError() {
  return new AppError(429, 'IGDB_RATE_LIMITED', 'IGDB is temporarily rate limited');
}

function buildGameListItemFromDetail(detailGame) {
  if (!detailGame || !normalizeGameId(detailGame.id)) {
    return null;
  }

  return {
    id: detailGame.id,
    name: detailGame.name ?? null,
    summary: detailGame.summary ?? null,
    coverUrl: detailGame.coverUrl ?? null,
    genres: Array.isArray(detailGame.genres) ? detailGame.genres : [],
    platforms: Array.isArray(detailGame.platforms) ? detailGame.platforms : [],
    rating: typeof detailGame.rating === 'number' ? detailGame.rating : null,
    aggregatedRating: typeof detailGame.aggregatedRating === 'number' ? detailGame.aggregatedRating : null,
    totalRating: typeof detailGame.totalRating === 'number' ? detailGame.totalRating : null,
    releaseDate: detailGame.releaseDate ?? null
  };
}

function normalizeAverageRating(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.round(numericValue * 10) / 10;
}

function buildGameDetailMeta({
  cacheHit = false,
  liveFetchAttempted = false,
  liveFetchSkippedReason = null,
  isPartial = false,
  igdbDataAvailable = true,
  fallbackSource = null,
  degradedSections = [],
  localReviewSummary = null
} = {}) {
  return {
    cacheHit,
    liveFetchAttempted,
    liveFetchSkippedReason,
    isPartial,
    igdbDataAvailable,
    fallbackSource,
    degradedSections,
    localReviewSummary
  };
}

function buildPartialGameDetailFromListItem(listItem) {
  const normalizedGameId = normalizeGameId(listItem?.id);

  if (!normalizedGameId) {
    return null;
  }

  return {
    id: Number.parseInt(normalizedGameId, 10),
    name: listItem?.name ?? null,
    summary: listItem?.summary ?? null,
    storyline: null,
    coverUrl: listItem?.coverUrl ?? null,
    artworkUrls: [],
    screenshotUrls: [],
    genres: Array.isArray(listItem?.genres) ? listItem.genres : [],
    platforms: Array.isArray(listItem?.platforms) ? listItem.platforms : [],
    developers: [],
    publishers: [],
    rating: typeof listItem?.rating === 'number' ? listItem.rating : null,
    aggregatedRating: typeof listItem?.aggregatedRating === 'number' ? listItem.aggregatedRating : null,
    totalRating: typeof listItem?.totalRating === 'number' ? listItem.totalRating : null,
    releaseDate: listItem?.releaseDate ?? null,
    status: null,
    category: null,
    videoIds: [],
    similarGames: []
  };
}

function seedBatchCacheFromGames(games) {
  for (const game of games ?? []) {
    cacheBatchGame(game);
  }
}

async function getLocalReviewSummary(gameId) {
  const normalizedGameId = normalizeGameId(gameId);

  if (!normalizedGameId) {
    return {
      reviewCount: 0,
      averageRating: null
    };
  }

  const aggregation = await prisma.review.aggregate({
    where: {
      gameId: normalizedGameId
    },
    _count: {
      id: true
    },
    _avg: {
      rating: true
    }
  });

  return {
    reviewCount: aggregation?._count?.id ?? 0,
    averageRating: normalizeAverageRating(aggregation?._avg?.rating ?? null)
  };
}

async function getLocalStoredGameSummary(gameId) {
  const normalizedGameId = normalizeGameId(gameId);

  if (!normalizedGameId) {
    return null;
  }

  const [libraryEntry, localReviewSummary] = await Promise.all([
    prisma.userGameLibrary.findFirst({
      where: {
        gameSource: 'IGDB',
        externalGameId: normalizedGameId
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' }
      ],
      select: {
        externalGameId: true,
        gameName: true,
        coverUrl: true,
        updatedAt: true
      }
    }),
    getLocalReviewSummary(normalizedGameId)
  ]);

  if (!libraryEntry && localReviewSummary.reviewCount === 0) {
    return null;
  }

  return {
    id: Number.parseInt(normalizedGameId, 10),
    name: libraryEntry?.gameName ?? `IGDB Game ${normalizedGameId}`,
    summary: null,
    storyline: null,
    coverUrl: libraryEntry?.coverUrl ?? null,
    artworkUrls: [],
    screenshotUrls: [],
    genres: [],
    platforms: [],
    developers: [],
    publishers: [],
    rating: null,
    aggregatedRating: null,
    totalRating: null,
    releaseDate: null,
    status: null,
    category: null,
    videoIds: [],
    similarGames: [],
    localReviewSummary
  };
}

async function buildPartialDetailFallbackResponse({
  gameId,
  liveFetchAttempted = false,
  liveFetchSkippedReason = null,
  fallbackReason = null
}) {
  const normalizedGameId = normalizeGameId(gameId);
  const cachedBatchGame = getCachedBatchGame(normalizedGameId);
  const dbFallbackGame = cachedBatchGame ? null : await getLocalStoredGameSummary(normalizedGameId);
  const partialGame = cachedBatchGame
    ? buildPartialGameDetailFromListItem(cachedBatchGame)
    : dbFallbackGame;
  const fallbackSource = cachedBatchGame ? 'batch_cache' : 'db';

  if (!partialGame) {
    return null;
  }

  const localReviewSummary = partialGame.localReviewSummary ?? await getLocalReviewSummary(normalizedGameId);
  delete partialGame.localReviewSummary;

  logger.info('[GameDetail] fallbackToCached', {
    gameId: normalizedGameId,
    source: fallbackSource,
    reason: liveFetchSkippedReason === 'rate_limited' ? 'igdb_rate_limited' : fallbackReason,
    liveFetchAttempted,
    liveFetchSkippedReason,
    fallbackReason,
    reviewCount: localReviewSummary.reviewCount,
    averageRating: localReviewSummary.averageRating
  });

  return {
    game: partialGame,
    meta: buildGameDetailMeta({
      cacheHit: false,
      liveFetchAttempted,
      liveFetchSkippedReason,
      isPartial: true,
      igdbDataAvailable: false,
      fallbackSource,
      degradedSections: ['storyline', 'artworkUrls', 'screenshotUrls', 'developers', 'publishers', 'videoIds', 'similarGames'],
      localReviewSummary
    })
  };
}

function getCachedGameDetail(gameId) {
  const normalizedGameId = normalizeGameId(gameId);

  if (!normalizedGameId) {
    return null;
  }

  return getCacheEntry(igdbDetailCache, normalizedGameId);
}

function getCachedBatchGame(gameId) {
  const normalizedGameId = normalizeGameId(gameId);

  if (!normalizedGameId) {
    return null;
  }

  return getCacheEntry(igdbBatchGameCache, normalizedGameId);
}

function cacheGameDetail(gameId, gameDetail) {
  const normalizedGameId = normalizeGameId(gameId ?? gameDetail?.id);

  if (!normalizedGameId || !gameDetail) {
    return;
  }

  setCacheEntry(igdbDetailCache, normalizedGameId, gameDetail, IGDB_DETAIL_CACHE_TTL_MS);

  const listItem = buildGameListItemFromDetail(gameDetail);

  if (listItem) {
    setCacheEntry(igdbBatchGameCache, normalizedGameId, listItem, IGDB_BATCH_CACHE_TTL_MS);
  }
}

function cacheBatchGame(game) {
  const normalizedGameId = normalizeGameId(game?.id);

  if (!normalizedGameId || !game) {
    return;
  }

  setCacheEntry(igdbBatchGameCache, normalizedGameId, game, IGDB_BATCH_CACHE_TTL_MS);
}

function ensureIgdbConfig() {
  if (!env.twitchClientId || !env.twitchClientSecret) {
    throw new AppError(500, 'IGDB_NOT_CONFIGURED', 'IGDB integration is not configured');
  }
}

function hasUsableToken() {
  return Boolean(
    tokenCache.accessToken &&
    tokenCache.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()
  );
}

function escapeIgdbString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeHomeFilterToken(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase();
}

function mapNamedItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => (typeof item?.name === 'string' ? item.name.trim() : ''))
    .filter(Boolean);
}

function hasActiveHomeFilters(filters) {
  return Boolean(filters?.platform || filters?.category || filters?.gameMode);
}

function matchesPlatformFilter(game, platform) {
  if (!platform) {
    return true;
  }

  const platformNames = mapNamedItems(game?.platforms);
  const matchers = HOME_PLATFORM_MATCHERS[platform] ?? [];

  return platformNames.some((platformName) => matchers.some((pattern) => pattern.test(platformName)));
}

function matchesCategoryFilter(game, category) {
  if (!category) {
    return true;
  }

  const genreLabels = mapNamedItems(game?.genres).map(normalizeHomeFilterToken);
  const expectedTokens = HOME_CATEGORY_MATCHERS[category] ?? [];

  return genreLabels.some((genreLabel) => expectedTokens.some((token) => genreLabel.includes(token)));
}

function matchesGameModeFilter(game, gameMode) {
  if (!gameMode) {
    return true;
  }

  const gameModeLabels = mapNamedItems(game?.game_modes).map(normalizeHomeFilterToken);
  const expectedTokens = HOME_GAME_MODE_MATCHERS[gameMode] ?? [];

  return gameModeLabels.some((gameModeLabel) => expectedTokens.some((token) => gameModeLabel.includes(token)));
}

function applyHomeFiltersToGames(games, filters) {
  if (!hasActiveHomeFilters(filters)) {
    return Array.isArray(games) ? games : [];
  }

  return (games ?? []).filter((game) => (
    matchesPlatformFilter(game, filters.platform) &&
    matchesCategoryFilter(game, filters.category) &&
    matchesGameModeFilter(game, filters.gameMode)
  ));
}

function clearTokenCache() {
  tokenCache = {
    accessToken: null,
    expiresAt: 0,
    pendingPromise: null
  };
}

function buildGamesQuery({ fields, search, limit, sort, where }) {
  const statements = [];

  if (search) {
    statements.push(`search "${escapeIgdbString(search)}";`);
  }

  statements.push(`fields ${fields};`);

  if (where) {
    statements.push(`where ${where};`);
  }

  if (sort && !search) {
    statements.push(`sort ${sort};`);
  }

  statements.push(`limit ${limit};`);

  return statements.join(' ');
}

function buildDetailQuery(gameId) {
  return [
    `fields ${DETAIL_FIELDS};`,
    `where id = ${gameId};`,
    'limit 1;'
  ].join(' ');
}

function normalizeIgdbGameIds(gameIds) {
  if (!Array.isArray(gameIds)) {
    return [];
  }

  return [...new Set(
    gameIds
      .map((gameId) => (typeof gameId === 'string' ? gameId.trim() : String(gameId ?? '').trim()))
      .filter((gameId) => /^\d+$/.test(gameId))
  )];
}

function buildGamesByIdsQueryWithFields({ gameIds, fields }) {
  const normalizedIds = normalizeIgdbGameIds(gameIds);

  if (normalizedIds.length === 0) {
    return null;
  }

  return [
    `fields ${fields};`,
    `where id = (${normalizedIds.join(',')});`,
    `limit ${normalizedIds.length};`
  ].join(' ');
}

function buildGamesByIdsQuery(gameIds) {
  return buildGamesByIdsQueryWithFields({
    gameIds,
    fields: GAME_LIST_FIELDS
  });
}

function buildSteamExternalGamesQuery(steamAppId) {
  const normalizedSteamAppId = typeof steamAppId === 'string'
    ? steamAppId.trim()
    : String(steamAppId ?? '').trim();

  if (!/^\d+$/.test(normalizedSteamAppId)) {
    return null;
  }

  return [
    `fields ${EXTERNAL_GAME_FIELDS};`,
    `where uid = "${normalizedSteamAppId}" & external_game_source = ${STEAM_EXTERNAL_GAME_SOURCE} & game != null;`,
    'limit 20;'
  ].join(' ');
}

function buildSearchMeta({ originalQuery, normalizedQuery, effectiveQuery, resultCount }) {
  return {
    originalQuery,
    normalizedQuery,
    effectiveQuery,
    resultCount
  };
}

function sliceSearchResponse(response, requestedLimit) {
  const limitedGames = response.games.slice(0, requestedLimit);

  return {
    ...response,
    games: limitedGames,
    results: limitedGames,
    suggestions: response.suggestions.slice(0, SUGGESTION_MAX_LIMIT),
    meta: {
      ...response.meta,
      resultCount: limitedGames.length
    }
  };
}

function sliceSuggestionResponse(response, requestedLimit) {
  const limitedSuggestions = response.suggestions.slice(0, requestedLimit);

  return {
    ...response,
    suggestions: limitedSuggestions,
    meta: {
      ...response.meta,
      resultCount: limitedSuggestions.length
    }
  };
}

function getSearchPipelineLimit(requestedLimit) {
  return Math.max(requestedLimit, SEARCH_PIPELINE_MIN_LIMIT);
}

function getSuggestionPipelineLimit(requestedLimit) {
  return Math.max(requestedLimit, SUGGESTION_LIMIT);
}

function getCandidateFetchLimit(candidateQuery, exactFloor, wildcardFloor, pipelineLimit) {
  if (candidateQuery.endsWith('*')) {
    return Math.max(pipelineLimit, wildcardFloor);
  }

  return Math.max(pipelineLimit, exactFloor);
}

function mergeCandidateQueries(frontCandidates = [], trailingCandidates = [], maxCandidates = 5) {
  const mergedCandidates = [];

  for (const candidateQuery of [...frontCandidates, ...trailingCandidates]) {
    if (!candidateQuery || mergedCandidates.includes(candidateQuery)) {
      continue;
    }

    mergedCandidates.push(candidateQuery);
  }

  return mergedCandidates.slice(0, maxCandidates);
}

function buildAliasBoost(searchResolution) {
  const aliasTarget = searchResolution.exactAliasMatchedQuery ?? searchResolution.prefixAliasMatchedQuery;

  if (!aliasTarget || !searchResolution.aliasMatchType) {
    return null;
  }

  return {
    target: aliasTarget,
    matchedAliasKey: searchResolution.exactAliasMatchedKey ?? searchResolution.prefixAliasMatchedKey,
    matchType: searchResolution.aliasMatchType,
    confidence: searchResolution.aliasConfidence,
    candidateQueries: searchResolution.aliasCandidateQueries
  };
}

function getSearchQueryInfo(searchResolution) {
  if (searchResolution.aliasMatchType !== 'prefix') {
    return normalizeQuery(searchResolution.effectiveQuery);
  }

  return normalizeQuery(searchResolution.normalizedQuery || searchResolution.effectiveQuery);
}

function buildTrailingCandidateQueries(searchResolution, queryInfo) {
  const effectiveQueryInfo = normalizeQuery(searchResolution.effectiveQuery);

  if (searchResolution.aliasMatchType !== 'prefix') {
    return buildSearchCandidateQueries(queryInfo);
  }

  return mergeCandidateQueries(
    buildSearchCandidateQueries(queryInfo),
    buildSearchCandidateQueries(effectiveQueryInfo)
  );
}

function buildSearchCandidatePlan(searchResolution, queryInfo) {
  const aliasCandidateQueries = Array.isArray(searchResolution.aliasCandidateQueries)
    ? searchResolution.aliasCandidateQueries
    : [];
  const trailingCandidates = buildTrailingCandidateQueries(searchResolution, queryInfo);
  const candidateQueries = mergeCandidateQueries(aliasCandidateQueries, trailingCandidates, SEARCH_CANDIDATE_QUERY_LIMIT);

  return {
    aliasExpansionUsed: aliasCandidateQueries.length > 0,
    aliasHits: aliasCandidateQueries.length > 0
      ? [{
        matchType: searchResolution.aliasMatchType ?? null,
        matchedKey: searchResolution.exactAliasMatchedKey ?? searchResolution.prefixAliasMatchedKey ?? null,
        matchedQuery: searchResolution.exactAliasMatchedQuery ?? searchResolution.prefixAliasMatchedQuery ?? null,
        locale: searchResolution.aliasLocale ?? null
      }]
      : [],
    candidateQueries
  };
}

function getTopRankedResultNames(games, limit = 3) {
  return games
    .slice(0, limit)
    .map((game) => game?.name)
    .filter(Boolean);
}

function buildRerankTopReasons(queryInfo, games, aliasBoost) {
  return (games ?? []).slice(0, 5).map((game) => ({
    gameId: game?.id ?? null,
    title: game?.name ?? null,
    reasons: explainGameMatchReasons(queryInfo, game, { aliasBoost })
  }));
}

function logIgdbCounts(label, rawGames, mappedGames) {
  const rawCount = Array.isArray(rawGames) ? rawGames.length : 0;
  const mappedCount = Array.isArray(mappedGames) ? mappedGames.length : (mappedGames ? 1 : 0);

  logger.info('IGDB result counts', {
    label,
    rawCount,
    mappedCount
  });
}

async function requestTwitchAppAccessToken() {
  ensureIgdbConfig();

  const requestBody = new URLSearchParams({
    client_id: env.twitchClientId,
    client_secret: env.twitchClientSecret,
    grant_type: 'client_credentials'
  });

  let response;

  try {
    response = await fetch(TWITCH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: requestBody.toString(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    logger.error('Twitch token request failed', { error });
    throw new AppError(502, 'TWITCH_AUTH_UNAVAILABLE', 'Twitch authentication is temporarily unavailable');
  }

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error('Twitch token endpoint returned a non-OK response', {
      status: response.status,
      body: upstreamBody.slice(0, 300)
    });
    throw new AppError(502, 'TWITCH_AUTH_UNAVAILABLE', 'Twitch authentication is temporarily unavailable');
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    logger.error('Twitch token endpoint returned invalid JSON', { error });
    throw new AppError(502, 'TWITCH_AUTH_UNAVAILABLE', 'Twitch authentication is temporarily unavailable');
  }

  if (typeof payload?.access_token !== 'string' || typeof payload?.expires_in !== 'number') {
    logger.error('Twitch token endpoint returned an invalid payload');
    throw new AppError(502, 'TWITCH_AUTH_UNAVAILABLE', 'Twitch authentication is temporarily unavailable');
  }

  tokenCache.accessToken = payload.access_token;
  tokenCache.expiresAt = Date.now() + payload.expires_in * 1000;

  logger.info('Twitch token refreshed', { expiresIn: payload.expires_in });

  return tokenCache.accessToken;
}

async function getTwitchAppAccessToken() {
  if (hasUsableToken()) {
    return tokenCache.accessToken;
  }

  if (!tokenCache.pendingPromise) {
    tokenCache.pendingPromise = requestTwitchAppAccessToken()
      .finally(() => {
        tokenCache.pendingPromise = null;
      });
  }

  return tokenCache.pendingPromise;
}

async function executeIgdbRequest({ path, body, retryOnUnauthorized = true }) {
  ensureIgdbConfig();

  if (isIgdbRateLimitCooldownActive()) {
    logIgdbCooldownActive(path);
    throw createIgdbRateLimitedError();
  }

  const accessToken = await getTwitchAppAccessToken();
  const endpointUrl = `${IGDB_BASE_URL}/${path}`;

  let response;

  try {
    response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Client-ID': env.twitchClientId,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'text/plain'
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    logger.error('IGDB request failed', {
      path,
      error
    });
    throw new AppError(502, 'IGDB_UPSTREAM_ERROR', 'IGDB is temporarily unavailable');
  }

  if ((response.status === 401 || response.status === 403) && retryOnUnauthorized) {
    logger.warn('Retrying IGDB request after upstream auth failure', {
      path,
      status: response.status
    });
    clearTokenCache();
    return executeIgdbRequest({
      path,
      body,
      retryOnUnauthorized: false
    });
  }

  if (response.status === 429) {
    const upstreamBody = await response.text();
    enterIgdbRateLimitCooldown({
      path,
      status: response.status,
      body: upstreamBody
    });
    throw createIgdbRateLimitedError();
  }

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error('IGDB upstream returned a non-OK response', {
      path,
      status: response.status,
      body: upstreamBody.slice(0, 300)
    });
    throw new AppError(502, 'IGDB_UPSTREAM_ERROR', 'IGDB is temporarily unavailable');
  }

  try {
    return await response.json();
  } catch (error) {
    logger.error('IGDB upstream returned invalid JSON', {
      path,
      error
    });
    throw new AppError(502, 'IGDB_UPSTREAM_ERROR', 'IGDB is temporarily unavailable');
  }
}

async function postGamesQuery(body) {
  return executeIgdbRequest({
    path: 'games',
    body
  });
}

async function postExternalGamesQuery(body) {
  return executeIgdbRequest({
    path: 'external_games',
    body
  });
}

async function getFilteredHomeCollection({
  endpoint,
  limit,
  defaultLimit,
  sort,
  filters
}) {
  const requestedLimit = limit ?? defaultLimit;
  const queryLimit = hasActiveHomeFilters(filters)
    ? Math.min(
      Math.max(requestedLimit * FILTERED_COLLECTION_MULTIPLIER, requestedLimit),
      FILTERED_COLLECTION_MAX_LIMIT
    )
    : requestedLimit;
  const rawGames = await postGamesQuery(buildGamesQuery({
    fields: GAME_LIST_FIELDS,
    limit: queryLimit,
    sort
  }));
  const filteredGames = applyHomeFiltersToGames(rawGames, filters);
  const selectedGames = filteredGames.slice(0, requestedLimit);
  const games = mapGameList(selectedGames);
  seedBatchCacheFromGames(games);

  logIgdbCounts(endpoint, rawGames, games);

  logger.info('home-filter-service', {
    endpoint,
    platform: filters.platform ?? null,
    category: filters.category ?? null,
    gameMode: filters.gameMode ?? null,
    rawCount: rawGames.length,
    filteredCount: selectedGames.length
  });

  return {
    games
  };
}

async function fetchCandidateResultSets({
  fields,
  candidateQueries,
  pipelineLimit,
  exactFloor,
  wildcardFloor,
  whereClause
}) {
  return Promise.all(
    candidateQueries.map((candidateQuery) => postGamesQuery(buildGamesQuery({
      fields,
      search: candidateQuery,
      limit: getCandidateFetchLimit(candidateQuery, exactFloor, wildcardFloor, pipelineLimit),
      sort: 'total_rating_count desc',
      where: whereClause
    })))
  );
}

async function resolveRankedGames({
  queryInfo,
  fields,
  pipelineLimit,
  candidateQueries,
  aliasBoost,
  exactFloor,
  wildcardFloor,
  whereClause
}) {
  let allCandidateQueries = [...candidateQueries];
  let rawResultSets = await fetchCandidateResultSets({
    fields,
    candidateQueries: allCandidateQueries,
    pipelineLimit,
    exactFloor,
    wildcardFloor,
    whereClause
  });
  let mergedGames = mergeGamesById(rawResultSets);

  if (mergedGames.length === 0) {
    const fallbackCandidates = buildFallbackCandidateQueries(queryInfo, allCandidateQueries);

    if (fallbackCandidates.length > 0) {
      const fallbackResultSets = await fetchCandidateResultSets({
        fields,
        candidateQueries: fallbackCandidates,
        pipelineLimit,
        exactFloor,
        wildcardFloor,
        whereClause
      });

      allCandidateQueries = allCandidateQueries.concat(fallbackCandidates);
      rawResultSets = rawResultSets.concat(fallbackResultSets);
      mergedGames = mergeGamesById(rawResultSets);
    }
  }

  return {
    candidateQueries: allCandidateQueries,
    mergedGames,
    rankedGames: rankGames(queryInfo, mergedGames, {
      aliasBoost
    }).slice(0, pipelineLimit)
  };
}

function buildSearchSuggestions(rawGames) {
  return mapGameSuggestions(rawGames).slice(0, SUGGESTION_MAX_LIMIT);
}

async function getSteamExternalGameCandidates({ steamAppId }) {
  const query = buildSteamExternalGamesQuery(steamAppId);

  if (!query) {
    return {
      externalGames: [],
      games: [],
      rateLimited: false,
      errorCode: null
    };
  }

  try {
    const externalGames = await postExternalGamesQuery(query);
    const gameIds = [...new Set(
      externalGames
        .map((externalGame) => (
          typeof externalGame?.game === 'number'
            ? String(externalGame.game)
            : String(externalGame?.game ?? '').trim()
        ))
        .filter((gameId) => /^\d+$/.test(gameId))
    )];

    if (gameIds.length === 0) {
      return {
        externalGames,
        games: [],
        rateLimited: false,
        errorCode: null
      };
    }

    const rawGames = await postGamesQuery(buildGamesByIdsQueryWithFields({
      gameIds,
      fields: STEAM_MATCH_FIELDS
    }));

    logger.info('IGDB steam external_games candidates resolved', {
      steamAppId,
      externalGameCount: externalGames.length,
      candidateGameCount: rawGames.length
    });

    return {
      externalGames,
      games: rawGames,
      rateLimited: false,
      errorCode: null
    };
  } catch (error) {
    if (error?.code === 'IGDB_RATE_LIMITED') {
      return {
        externalGames: [],
        games: [],
        rateLimited: true,
        errorCode: error.code
      };
    }

    throw error;
  }
}

function buildSearchResponse({
  searchResolution,
  rawGames,
  games
}) {
  return {
    query: searchResolution.originalQuery,
    games,
    results: games,
    suggestions: buildSearchSuggestions(rawGames),
    meta: buildSearchMeta({
      originalQuery: searchResolution.originalQuery,
      normalizedQuery: searchResolution.normalizedQuery,
      effectiveQuery: searchResolution.effectiveQuery,
      resultCount: games.length
    })
  };
}

function buildSuggestionResponse({
  searchResolution,
  suggestions
}) {
  return {
    suggestions,
    meta: buildSearchMeta({
      originalQuery: searchResolution.originalQuery,
      normalizedQuery: searchResolution.normalizedQuery,
      effectiveQuery: searchResolution.effectiveQuery,
      resultCount: suggestions.length
    })
  };
}

function trackSearchQuery({ query, normalizedQuery, resultCount }) {
  if (!normalizedQuery || normalizedQuery.length < 2 || searchAnalyticsDisabled) {
    return;
  }

  void prisma.searchQuery.create({
    data: {
      query,
      normalizedQuery,
      resultCount
    }
  }).catch((error) => {
    if (typeof error?.message === 'string' && error.message.includes('search_queries')) {
      searchAnalyticsDisabled = true;
    }

    console.warn(`[search-analytics] write_failed query=${JSON.stringify(normalizedQuery)} message=${error?.message ?? 'unknown'}`);
  });
}

async function getHighlights({ limit, platform, category, gameMode }) {
  return getFilteredHomeCollection({
    endpoint: 'highlights',
    limit,
    defaultLimit: HIGHLIGHTS_LIMIT,
    sort: 'total_rating desc',
    filters: {
      platform,
      category,
      gameMode
    }
  });
}

async function getPopularGames({ limit, platform, category, gameMode }) {
  return getFilteredHomeCollection({
    endpoint: 'popular',
    limit,
    defaultLimit: DEFAULT_LIMIT,
    sort: 'first_release_date desc',
    filters: {
      platform,
      category,
      gameMode
    }
  });
}

async function getRecommendedGames({ limit, platform, category, gameMode }) {
  return getFilteredHomeCollection({
    endpoint: 'recommended',
    limit,
    defaultLimit: DEFAULT_LIMIT,
    sort: 'total_rating desc',
    filters: {
      platform,
      category,
      gameMode
    }
  });
}

async function searchGames({ query, limit }) {
  const startedAt = Date.now();
  const requestedLimit = limit ?? SEARCH_LIMIT;
  const searchResolution = await searchQueryTranslationService.resolveSearchQuery(query);
  const queryInfo = getSearchQueryInfo(searchResolution);
  const normalizedOriginalQuery = searchResolution.normalizedQuery;
  const pipelineLimit = getSearchPipelineLimit(requestedLimit);
  const aliasBoost = buildAliasBoost(searchResolution);
  const candidatePlan = buildSearchCandidatePlan(searchResolution, queryInfo);
  const searchCacheKey = buildCanonicalCandidateCacheKey(candidatePlan.candidateQueries, normalizedOriginalQuery);
  const cachedResponse = getCachedSearch(searchCacheKey);

  console.info(
    `[igdb:search] originalQuery=${JSON.stringify(searchResolution.originalQuery)} normalizedQuery=${JSON.stringify(searchResolution.normalizedQuery)} compactQuery=${JSON.stringify(searchResolution.compactQuery)} aliasHits=${JSON.stringify(candidatePlan.aliasHits)} effectiveQuery=${JSON.stringify(searchResolution.effectiveQuery)} generatedCandidates=${JSON.stringify(candidatePlan.candidateQueries)}`
  );

  if (cachedResponse && cachedResponse.games.length >= requestedLimit) {
    console.info(`[igdb:search] cache_hit key=search:${searchCacheKey}`);
    trackSearchQuery({
      query: searchResolution.originalQuery,
      normalizedQuery: searchResolution.normalizedQuery,
      resultCount: cachedResponse.games.length
    });
    void appendSearchLog(buildSearchLogRecord({
      endpoint: 'search',
      originalQuery: searchResolution.originalQuery,
      normalizedQuery: searchResolution.normalizedQuery,
      compactQuery: searchResolution.compactQuery,
      sourceLanguage: searchResolution.sourceLanguage,
      aliasHits: candidatePlan.aliasHits,
      generatedCandidates: candidatePlan.candidateQueries,
      candidateQueriesActuallyUsed: candidatePlan.candidateQueries,
      igdbRawCount: cachedResponse.games.length,
      finalResultCount: cachedResponse.games.length,
      topResultTitles: cachedResponse.games.slice(0, 5).map((game) => game?.name).filter(Boolean),
      elapsedMs: Date.now() - startedAt,
      cached: true
    }));
    return sliceSearchResponse(cachedResponse, requestedLimit);
  }

  const { mergedGames, rankedGames, candidateQueries: usedCandidateQueries } = await resolveRankedGames({
    queryInfo,
    fields: GAME_LIST_FIELDS,
    pipelineLimit,
    candidateQueries: candidatePlan.candidateQueries,
    aliasBoost,
    exactFloor: SEARCH_EXACT_QUERY_FETCH_LIMIT,
    wildcardFloor: SEARCH_WILDCARD_QUERY_FETCH_LIMIT
  });
  const mappedGames = mapGameList(rankedGames);
  seedBatchCacheFromGames(mappedGames);
  const topRankedResultNames = getTopRankedResultNames(rankedGames);
  const rerankTopReasons = buildRerankTopReasons(queryInfo, rankedGames, aliasBoost);

  logIgdbCounts('search', mergedGames, mappedGames);
  console.info(`[igdb:search] usedCandidateQueries=${JSON.stringify(usedCandidateQueries)} topRankedResultNames=${JSON.stringify(topRankedResultNames)} igdbResultCount=${mergedGames.length} finalResultCount=${mappedGames.length} rerankTopReasons=${JSON.stringify(rerankTopReasons)}`);

  const response = buildSearchResponse({
    searchResolution,
    rawGames: rankedGames,
    games: mappedGames
  });

  setCachedSearch(searchCacheKey, response);
  trackSearchQuery({
    query: searchResolution.originalQuery,
    normalizedQuery: searchResolution.normalizedQuery,
    resultCount: mappedGames.length
  });
  void appendSearchLog(buildSearchLogRecord({
    endpoint: 'search',
    originalQuery: searchResolution.originalQuery,
    normalizedQuery: searchResolution.normalizedQuery,
    compactQuery: searchResolution.compactQuery,
    sourceLanguage: searchResolution.sourceLanguage,
    aliasHits: candidatePlan.aliasHits,
    generatedCandidates: candidatePlan.candidateQueries,
    candidateQueriesActuallyUsed: usedCandidateQueries,
    igdbRawCount: mergedGames.length,
    finalResultCount: mappedGames.length,
    topResultTitles: topRankedResultNames,
    elapsedMs: Date.now() - startedAt,
    cached: false,
    rerankTopReasons
  }));

  return sliceSearchResponse(response, requestedLimit);
}

async function getGameSuggestions({ query, limit }) {
  const startedAt = Date.now();
  const requestedLimit = Math.min(limit ?? SUGGESTION_LIMIT, SUGGESTION_MAX_LIMIT);
  const searchResolution = await searchQueryTranslationService.resolveSearchQuery(query);
  const queryInfo = getSearchQueryInfo(searchResolution);
  const normalizedOriginalQuery = searchResolution.normalizedQuery;
  const pipelineLimit = getSuggestionPipelineLimit(requestedLimit);
  const aliasBoost = buildAliasBoost(searchResolution);
  const candidatePlan = buildSearchCandidatePlan(searchResolution, queryInfo);
  const suggestionCacheKey = buildCanonicalCandidateCacheKey(candidatePlan.candidateQueries, normalizedOriginalQuery);
  const cachedResponse = getCachedSuggestions(suggestionCacheKey);

  console.info(
    `[igdb:suggestions] originalQuery=${JSON.stringify(searchResolution.originalQuery)} normalizedQuery=${JSON.stringify(searchResolution.normalizedQuery)} compactQuery=${JSON.stringify(searchResolution.compactQuery)} aliasHits=${JSON.stringify(candidatePlan.aliasHits)} effectiveQuery=${JSON.stringify(searchResolution.effectiveQuery)} generatedCandidates=${JSON.stringify(candidatePlan.candidateQueries)}`
  );

  if (cachedResponse && cachedResponse.suggestions.length >= requestedLimit) {
    console.info(`[igdb:suggestions] cache_hit key=suggestion:${suggestionCacheKey}`);
    void appendSearchLog(buildSearchLogRecord({
      endpoint: 'suggestions',
      originalQuery: searchResolution.originalQuery,
      normalizedQuery: searchResolution.normalizedQuery,
      compactQuery: searchResolution.compactQuery,
      sourceLanguage: searchResolution.sourceLanguage,
      aliasHits: candidatePlan.aliasHits,
      generatedCandidates: candidatePlan.candidateQueries,
      candidateQueriesActuallyUsed: candidatePlan.candidateQueries,
      igdbRawCount: cachedResponse.suggestions.length,
      finalResultCount: cachedResponse.suggestions.length,
      topResultTitles: cachedResponse.suggestions.slice(0, 5).map((game) => game?.name).filter(Boolean),
      elapsedMs: Date.now() - startedAt,
      cached: true
    }));
    return sliceSuggestionResponse(cachedResponse, requestedLimit);
  }

  const { mergedGames, rankedGames, candidateQueries: usedCandidateQueries } = await resolveRankedGames({
    queryInfo,
    fields: SUGGESTION_FIELDS,
    pipelineLimit,
    candidateQueries: candidatePlan.candidateQueries,
    aliasBoost,
    exactFloor: SUGGESTION_EXACT_QUERY_FETCH_LIMIT,
    wildcardFloor: SUGGESTION_WILDCARD_QUERY_FETCH_LIMIT
  });
  const suggestions = mapGameSuggestions(rankedGames).slice(0, pipelineLimit);
  seedBatchCacheFromGames(suggestions);
  const topRankedResultNames = getTopRankedResultNames(rankedGames);
  const rerankTopReasons = buildRerankTopReasons(queryInfo, rankedGames, aliasBoost);

  console.info(`[igdb:suggestions] usedCandidateQueries=${JSON.stringify(usedCandidateQueries)} topRankedResultNames=${JSON.stringify(topRankedResultNames)} igdbResultCount=${mergedGames.length} finalResultCount=${suggestions.length} rerankTopReasons=${JSON.stringify(rerankTopReasons)}`);

  const response = buildSuggestionResponse({
    searchResolution,
    suggestions
  });

  setCachedSuggestions(suggestionCacheKey, response);
  void appendSearchLog(buildSearchLogRecord({
    endpoint: 'suggestions',
    originalQuery: searchResolution.originalQuery,
    normalizedQuery: searchResolution.normalizedQuery,
    compactQuery: searchResolution.compactQuery,
    sourceLanguage: searchResolution.sourceLanguage,
    aliasHits: candidatePlan.aliasHits,
    generatedCandidates: candidatePlan.candidateQueries,
    candidateQueriesActuallyUsed: usedCandidateQueries,
    igdbRawCount: mergedGames.length,
    finalResultCount: suggestions.length,
    topResultTitles: topRankedResultNames,
    elapsedMs: Date.now() - startedAt,
    cached: false,
    rerankTopReasons
  }));

  return sliceSuggestionResponse(response, requestedLimit);
}

async function getGameDetail({ gameId }) {
  const normalizedGameId = normalizeGameId(gameId);

  if (!normalizedGameId) {
    throw new AppError(404, 'GAME_NOT_FOUND', 'Game could not be found');
  }

  const cachedGameDetail = getCachedGameDetail(normalizedGameId);

  if (cachedGameDetail) {
    logger.info('[GameDetailCache] hit', {
      gameId: normalizedGameId,
      source: 'detail_cache'
    });

    return {
      game: cachedGameDetail,
      meta: buildGameDetailMeta({
        cacheHit: true,
        liveFetchAttempted: false,
        liveFetchSkippedReason: 'cache_hit'
      })
    };
  }

  const existingPendingRequest = pendingGameDetailRequests.get(normalizedGameId);

  if (existingPendingRequest) {
    const pendingResult = await existingPendingRequest;

    return {
      game: cloneCacheValue(pendingResult.game),
      meta: buildGameDetailMeta({
        cacheHit: false,
        liveFetchAttempted: false,
        liveFetchSkippedReason: 'coalesced_inflight_request'
      })
    };
  }

  if (isIgdbRateLimitCooldownActive()) {
    logger.warn('[IGDBBackoff] suppress', {
      key: `game:${normalizedGameId}`,
      remainingMs: getRateLimitCooldownRemainingMs()
    });

    const fallbackResponse = await buildPartialDetailFallbackResponse({
      gameId: normalizedGameId,
      liveFetchAttempted: false,
      liveFetchSkippedReason: 'rate_limited',
      fallbackReason: 'cooldown_active'
    });

    if (fallbackResponse) {
      return fallbackResponse;
    }

    logger.warn('IGDB detail request skipped because no cached detail was available during rate limit cooldown', {
      gameId: normalizedGameId,
      cooldownRemainingMs: getRateLimitCooldownRemainingMs()
    });
    logger.warn('igdb-detail-hard-failed-no-fallback', {
      gameId: normalizedGameId,
      reason: 'cooldown_active_no_cached_sources'
    });
    throw createIgdbRateLimitedError();
  }

  const pendingRequest = (async () => {
    const rawGames = await postGamesQuery(buildDetailQuery(normalizedGameId));
    const game = rawGames[0];

    if (!game) {
      logIgdbCounts('detail', rawGames, null);
      throw new AppError(404, 'GAME_NOT_FOUND', 'Game could not be found');
    }

    const mappedGame = mapGameDetail(game);
    cacheGameDetail(normalizedGameId, mappedGame);

    logIgdbCounts('detail', rawGames, mappedGame);

    return {
      game: mappedGame
    };
  })();

  pendingGameDetailRequests.set(normalizedGameId, pendingRequest);

  try {
    const result = await pendingRequest;

    return {
      game: cloneCacheValue(result.game),
      meta: buildGameDetailMeta({
        cacheHit: false,
        liveFetchAttempted: true,
        liveFetchSkippedReason: null
      })
    };
  } catch (error) {
    if (error?.code === 'IGDB_RATE_LIMITED') {
      logger.warn('[IGDBBackoff] suppress', {
        key: `game:${normalizedGameId}`,
        remainingMs: getRateLimitCooldownRemainingMs()
      });

      const fallbackResponse = await buildPartialDetailFallbackResponse({
        gameId: normalizedGameId,
        liveFetchAttempted: true,
        liveFetchSkippedReason: 'rate_limited',
        fallbackReason: 'live_fetch_rate_limited'
      });

      if (fallbackResponse) {
        return fallbackResponse;
      }

      logger.warn('igdb-detail-hard-failed-no-fallback', {
        gameId: normalizedGameId,
        reason: 'live_fetch_rate_limited_no_cached_sources'
      });
    }

    throw error;
  } finally {
    pendingGameDetailRequests.delete(normalizedGameId);
  }
}

async function getGamesByIds({ gameIds }) {
  const normalizedGameIds = [...new Set(
    (gameIds ?? [])
      .map((candidateId) => normalizeGameId(candidateId))
      .filter(Boolean)
  )];

  if (normalizedGameIds.length === 0) {
    return {
      games: [],
      meta: {
        cacheHit: false,
        cacheCount: 0,
        liveFetchAttempted: false,
        liveFetchSkippedReason: 'empty_input'
      }
    };
  }

  const cachedGames = [];
  const missingGameIds = [];

  for (const normalizedGameId of normalizedGameIds) {
    const cachedGame = getCachedBatchGame(normalizedGameId);

    if (cachedGame) {
      cachedGames.push(cachedGame);
      continue;
    }

    missingGameIds.push(normalizedGameId);
  }

  if (missingGameIds.length === 0) {
    logger.info('IGDB batch served fully from cache', {
      gameCount: normalizedGameIds.length
    });

    return {
      games: cachedGames,
      meta: {
        cacheHit: true,
        cacheCount: cachedGames.length,
        liveFetchAttempted: false,
        liveFetchSkippedReason: 'cache_hit'
      }
    };
  }

  if (isIgdbRateLimitCooldownActive()) {
    logger.warn('IGDB batch partially served from cache during rate limit cooldown', {
      requestedCount: normalizedGameIds.length,
      cachedCount: cachedGames.length,
      missingCount: missingGameIds.length,
      cooldownRemainingMs: getRateLimitCooldownRemainingMs()
    });

    return {
      games: cachedGames,
      meta: {
        cacheHit: cachedGames.length > 0,
        cacheCount: cachedGames.length,
        liveFetchAttempted: false,
        liveFetchSkippedReason: 'rate_limited',
        missingGameIds
      }
    };
  }

  const requestKey = [...missingGameIds].sort((left, right) => Number(left) - Number(right) || left.localeCompare(right)).join(',');
  const existingPendingRequest = pendingGamesByIdsRequests.get(requestKey);

  if (existingPendingRequest) {
    const pendingGames = await existingPendingRequest;

    return {
      games: [...cachedGames, ...cloneCacheValue(pendingGames)],
      meta: {
        cacheHit: cachedGames.length > 0,
        cacheCount: cachedGames.length,
        liveFetchAttempted: false,
        liveFetchSkippedReason: 'coalesced_inflight_request'
      }
    };
  }

  const pendingRequest = (async () => {
    const query = buildGamesByIdsQuery(missingGameIds);

    if (!query) {
      return [];
    }

    const rawGames = await postGamesQuery(query);
    const games = mapGameList(rawGames);

    for (const game of games) {
      cacheBatchGame(game);
    }

    logIgdbCounts('batch', rawGames, games);

    return games;
  })();

  pendingGamesByIdsRequests.set(requestKey, pendingRequest);

  try {
    const fetchedGames = await pendingRequest;

    return {
      games: [...cachedGames, ...cloneCacheValue(fetchedGames)],
      meta: {
        cacheHit: cachedGames.length > 0,
        cacheCount: cachedGames.length,
        liveFetchAttempted: true,
        liveFetchSkippedReason: null
      }
    };
  } catch (error) {
    if (error?.code === 'IGDB_RATE_LIMITED' && cachedGames.length > 0) {
      logger.warn('IGDB batch fell back to cached subset after rate limit', {
        requestedCount: normalizedGameIds.length,
        cachedCount: cachedGames.length,
        missingCount: missingGameIds.length
      });

      return {
        games: cachedGames,
        meta: {
          cacheHit: true,
          cacheCount: cachedGames.length,
          liveFetchAttempted: true,
          liveFetchSkippedReason: 'rate_limited',
          missingGameIds
        }
      };
    }

    throw error;
  } finally {
    pendingGamesByIdsRequests.delete(requestKey);
  }
}

async function searchGamesForSteamMatch({ query, candidateQueries: providedCandidateQueries, limit }) {
  const rawCandidateQueries = Array.isArray(providedCandidateQueries)
    ? providedCandidateQueries
    : null;
  const baseQuery = typeof query === 'string' && query.trim()
    ? query
    : rawCandidateQueries?.find((candidateQuery) => typeof candidateQuery === 'string' && candidateQuery.trim())?.replace(/^"+|"+$/g, '') ?? '';
  const normalizedQuery = normalizeQuery(baseQuery).normalized;
  const requestedLimit = Math.max(limit ?? SEARCH_LIMIT, 1);

  if (!normalizedQuery && (!rawCandidateQueries || rawCandidateQueries.length === 0)) {
    return {
      games: [],
      candidateQueries: [],
      rateLimited: false,
      errorCode: null
    };
  }

  const candidateQueries = rawCandidateQueries?.length
    ? mergeCandidateQueries(
      rawCandidateQueries
        .map((candidateQuery) => (typeof candidateQuery === 'string' ? candidateQuery.trim() : ''))
        .filter(Boolean),
      [],
      12
    )
    : mergeCandidateQueries(
      buildSearchCandidateQueries(normalizedQuery),
      buildFallbackCandidateQueries(normalizedQuery),
      12
    );
  try {
    const { mergedGames } = await resolveRankedGames({
      queryInfo: normalizeQuery(normalizedQuery),
      fields: STEAM_MATCH_FIELDS,
      pipelineLimit: requestedLimit,
      candidateQueries,
      aliasBoost: null,
      whereClause: 'version_parent = null',
      exactFloor: requestedLimit,
      wildcardFloor: Math.max(requestedLimit, SEARCH_WILDCARD_QUERY_FETCH_LIMIT)
    });

    logger.info('IGDB steam match candidates resolved', {
      query: normalizedQuery,
      candidateQueries,
      candidateQueryCount: candidateQueries.length,
      candidateCount: mergedGames.length
    });

    return {
      games: mergedGames.slice(0, requestedLimit),
      candidateQueries,
      rateLimited: false,
      errorCode: null
    };
  } catch (error) {
    if (error?.code === 'IGDB_RATE_LIMITED') {
      return {
        games: [],
        candidateQueries,
        rateLimited: true,
        errorCode: error.code
      };
    }

    throw error;
  }
}

module.exports = {
  getCachedGameDetail,
  getGameDetail,
  getGamesByIds,
  getIgdbRateLimitState,
  getGameSuggestions,
  getHighlights,
  getPopularGames,
  getRecommendedGames,
  getSteamExternalGameCandidates,
  isIgdbRateLimitCooldownActive,
  searchGames,
  searchGamesForSteamMatch
};
