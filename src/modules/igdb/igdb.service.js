const { env } = require('../../config/env');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const searchQueryTranslationService = require('../../services/search-query-translation.service');
const { translateSearchResults } = require('../../services/search-result-translation.service');
const {
  getCachedSearch,
  getCachedSuggestions,
  setCachedSearch,
  setCachedSuggestions
} = require('./igdb.search-cache');
const {
  buildFallbackCandidateQueries,
  buildSearchCandidateQueries,
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
const SEARCH_EXACT_QUERY_FETCH_LIMIT = 20;
const SEARCH_WILDCARD_QUERY_FETCH_LIMIT = 50;
const SUGGESTION_EXACT_QUERY_FETCH_LIMIT = 20;
const SUGGESTION_WILDCARD_QUERY_FETCH_LIMIT = 50;
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;

const GAME_LIST_FIELDS = [
  'id',
  'name',
  'summary',
  'cover.url',
  'genres.name',
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

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
  pendingPromise: null
};
let searchAnalyticsDisabled = false;

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

function clearTokenCache() {
  tokenCache = {
    accessToken: null,
    expiresAt: 0,
    pendingPromise: null
  };
}

function buildGamesQuery({ fields, search, limit, sort }) {
  const statements = [];

  if (search) {
    statements.push(`search "${escapeIgdbString(search)}";`);
  }

  statements.push(`fields ${fields};`);

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

function mergeCandidateQueries(frontCandidates, trailingCandidates) {
  const mergedCandidates = [];

  for (const candidateQuery of [...frontCandidates, ...trailingCandidates]) {
    if (!candidateQuery || mergedCandidates.includes(candidateQuery)) {
      continue;
    }

    mergedCandidates.push(candidateQuery);
  }

  return mergedCandidates.slice(0, 5);
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

  if (searchResolution.translationUsed && searchResolution.translatedQuery) {
    return normalizeQuery(searchResolution.translatedQuery);
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

function getTopRankedResultNames(games, limit = 3) {
  return games
    .slice(0, limit)
    .map((game) => game?.name)
    .filter(Boolean);
}

function logIgdbCounts(label, rawGames, mappedGames) {
  const rawCount = Array.isArray(rawGames) ? rawGames.length : 0;
  const mappedCount = Array.isArray(mappedGames) ? mappedGames.length : (mappedGames ? 1 : 0);

  console.log(`[igdb] ${label} raw count`, rawCount);
  console.log(`[igdb] ${label} mapped count`, mappedCount);
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
    console.error(`[igdb:twitch-token] network_error message=${error?.message ?? 'unknown'}`);
    throw new AppError(502, 'TWITCH_AUTH_UNAVAILABLE', 'Twitch authentication is temporarily unavailable');
  }

  if (!response.ok) {
    const upstreamBody = await response.text();
    console.error(`[igdb:twitch-token] upstream_error status=${response.status} body=${upstreamBody.slice(0, 300)}`);
    throw new AppError(502, 'TWITCH_AUTH_UNAVAILABLE', 'Twitch authentication is temporarily unavailable');
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    console.error('[igdb:twitch-token] invalid_json received from Twitch token endpoint');
    throw new AppError(502, 'TWITCH_AUTH_UNAVAILABLE', 'Twitch authentication is temporarily unavailable');
  }

  if (typeof payload?.access_token !== 'string' || typeof payload?.expires_in !== 'number') {
    console.error('[igdb:twitch-token] invalid_payload received from Twitch token endpoint');
    throw new AppError(502, 'TWITCH_AUTH_UNAVAILABLE', 'Twitch authentication is temporarily unavailable');
  }

  tokenCache.accessToken = payload.access_token;
  tokenCache.expiresAt = Date.now() + payload.expires_in * 1000;

  console.info(`[igdb:twitch-token] refreshed expiresIn=${payload.expires_in}`);

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
    console.error(`[igdb] network_error path=${path} message=${error?.message ?? 'unknown'}`);
    throw new AppError(502, 'IGDB_UPSTREAM_ERROR', 'IGDB is temporarily unavailable');
  }

  if ((response.status === 401 || response.status === 403) && retryOnUnauthorized) {
    console.warn(`[igdb] auth_retry path=${path} status=${response.status}`);
    clearTokenCache();
    return executeIgdbRequest({
      path,
      body,
      retryOnUnauthorized: false
    });
  }

  if (!response.ok) {
    const upstreamBody = await response.text();
    console.error(`[igdb] upstream_error path=${path} status=${response.status} body=${upstreamBody.slice(0, 300)}`);
    throw new AppError(502, 'IGDB_UPSTREAM_ERROR', 'IGDB is temporarily unavailable');
  }

  try {
    return await response.json();
  } catch (error) {
    console.error(`[igdb] invalid_json path=${path}`);
    throw new AppError(502, 'IGDB_UPSTREAM_ERROR', 'IGDB is temporarily unavailable');
  }
}

async function postGamesQuery(body) {
  return executeIgdbRequest({
    path: 'games',
    body
  });
}

async function fetchCandidateResultSets({
  fields,
  candidateQueries,
  pipelineLimit,
  exactFloor,
  wildcardFloor
}) {
  return Promise.all(
    candidateQueries.map((candidateQuery) => postGamesQuery(buildGamesQuery({
      fields,
      search: candidateQuery,
      limit: getCandidateFetchLimit(candidateQuery, exactFloor, wildcardFloor, pipelineLimit),
      sort: 'total_rating_count desc'
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
  wildcardFloor
}) {
  let allCandidateQueries = [...candidateQueries];
  let rawResultSets = await fetchCandidateResultSets({
    fields,
    candidateQueries: allCandidateQueries,
    pipelineLimit,
    exactFloor,
    wildcardFloor
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
        wildcardFloor
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

async function localizeSearchResults(games, searchResolution) {
  if (searchResolution.sourceLanguage !== 'ko') {
    return games;
  }

  return translateSearchResults(games, {
    targetLanguage: 'ko'
  });
}

function buildSearchResponse({
  searchResolution,
  rawGames,
  localizedGames
}) {
  return {
    query: searchResolution.originalQuery,
    games: localizedGames,
    results: localizedGames,
    suggestions: buildSearchSuggestions(rawGames),
    meta: buildSearchMeta({
      originalQuery: searchResolution.originalQuery,
      normalizedQuery: searchResolution.normalizedQuery,
      effectiveQuery: searchResolution.effectiveQuery,
      resultCount: localizedGames.length
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

async function getHighlights({ limit }) {
  const rawGames = await postGamesQuery(buildGamesQuery({
    fields: GAME_LIST_FIELDS,
    limit: limit ?? HIGHLIGHTS_LIMIT,
    sort: 'total_rating desc'
  }));
  const games = mapGameList(rawGames);

  logIgdbCounts('highlights', rawGames, games);

  return {
    games
  };
}

async function getPopularGames({ limit }) {
  const rawGames = await postGamesQuery(buildGamesQuery({
    fields: GAME_LIST_FIELDS,
    limit: limit ?? DEFAULT_LIMIT,
    sort: 'first_release_date desc'
  }));
  const games = mapGameList(rawGames);

  logIgdbCounts('popular', rawGames, games);

  return {
    games
  };
}

async function getRecommendedGames({ limit }) {
  const rawGames = await postGamesQuery(buildGamesQuery({
    fields: GAME_LIST_FIELDS,
    limit: limit ?? DEFAULT_LIMIT,
    sort: 'total_rating desc'
  }));
  const games = mapGameList(rawGames);

  logIgdbCounts('recommended', rawGames, games);

  return {
    games
  };
}

async function searchGames({ query, limit }) {
  const requestedLimit = limit ?? SEARCH_LIMIT;
  const searchResolution = await searchQueryTranslationService.resolveSearchQuery(query);
  const queryInfo = getSearchQueryInfo(searchResolution);
  const normalizedOriginalQuery = searchResolution.normalizedQuery;
  const pipelineLimit = getSearchPipelineLimit(requestedLimit);
  const aliasBoost = buildAliasBoost(searchResolution);
  const cachedResponse = getCachedSearch(normalizedOriginalQuery);

  console.info(
    `[igdb:search] originalQuery=${JSON.stringify(searchResolution.originalQuery)} normalizedQuery=${JSON.stringify(searchResolution.normalizedQuery)} compactQuery=${JSON.stringify(searchResolution.compactQuery)} exactAliasMatchedQuery=${JSON.stringify(searchResolution.exactAliasMatchedQuery)} exactAliasMatchedKey=${JSON.stringify(searchResolution.exactAliasMatchedKey)} prefixAliasMatchedQuery=${JSON.stringify(searchResolution.prefixAliasMatchedQuery)} prefixAliasMatchedKey=${JSON.stringify(searchResolution.prefixAliasMatchedKey)} aliasMatchType=${JSON.stringify(searchResolution.aliasMatchType)} aliasConfidence=${JSON.stringify(searchResolution.aliasConfidence)} translatedQuery=${JSON.stringify(searchResolution.translatedQuery)} effectiveQuery=${JSON.stringify(searchResolution.effectiveQuery)} translationUsed=${searchResolution.translationUsed}`
  );

  if (cachedResponse && cachedResponse.games.length >= requestedLimit) {
    console.info(`[igdb:search] cache_hit key=search:${normalizedOriginalQuery}`);
    trackSearchQuery({
      query: searchResolution.originalQuery,
      normalizedQuery: searchResolution.normalizedQuery,
      resultCount: cachedResponse.games.length
    });
    return sliceSearchResponse(cachedResponse, requestedLimit);
  }

  const candidateQueries = mergeCandidateQueries(
    searchResolution.aliasCandidateQueries,
    buildTrailingCandidateQueries(searchResolution, queryInfo)
  );
  console.info(`[igdb:search] candidateQueries=${JSON.stringify(candidateQueries)}`);

  const { mergedGames, rankedGames, candidateQueries: usedCandidateQueries } = await resolveRankedGames({
    queryInfo,
    fields: GAME_LIST_FIELDS,
    pipelineLimit,
    candidateQueries,
    aliasBoost,
    exactFloor: SEARCH_EXACT_QUERY_FETCH_LIMIT,
    wildcardFloor: SEARCH_WILDCARD_QUERY_FETCH_LIMIT
  });
  const mappedGames = mapGameList(rankedGames);
  const localizedGames = await localizeSearchResults(mappedGames, searchResolution);
  const topRankedResultNames = getTopRankedResultNames(rankedGames);

  logIgdbCounts('search', mergedGames, localizedGames);
  console.info(`[igdb:search] usedCandidateQueries=${JSON.stringify(usedCandidateQueries)} topRankedResultNames=${JSON.stringify(topRankedResultNames)} igdbResultCount=${mergedGames.length} finalResultCount=${localizedGames.length}`);

  const response = buildSearchResponse({
    searchResolution,
    rawGames: rankedGames,
    localizedGames
  });

  setCachedSearch(normalizedOriginalQuery, response);
  trackSearchQuery({
    query: searchResolution.originalQuery,
    normalizedQuery: searchResolution.normalizedQuery,
    resultCount: localizedGames.length
  });

  return sliceSearchResponse(response, requestedLimit);
}

async function getGameSuggestions({ query, limit }) {
  const requestedLimit = Math.min(limit ?? SUGGESTION_LIMIT, SUGGESTION_MAX_LIMIT);
  const searchResolution = await searchQueryTranslationService.resolveSearchQuery(query);
  const queryInfo = getSearchQueryInfo(searchResolution);
  const normalizedOriginalQuery = searchResolution.normalizedQuery;
  const pipelineLimit = getSuggestionPipelineLimit(requestedLimit);
  const aliasBoost = buildAliasBoost(searchResolution);
  const cachedResponse = getCachedSuggestions(normalizedOriginalQuery);

  console.info(
    `[igdb:suggestions] originalQuery=${JSON.stringify(searchResolution.originalQuery)} normalizedQuery=${JSON.stringify(searchResolution.normalizedQuery)} compactQuery=${JSON.stringify(searchResolution.compactQuery)} exactAliasMatchedQuery=${JSON.stringify(searchResolution.exactAliasMatchedQuery)} exactAliasMatchedKey=${JSON.stringify(searchResolution.exactAliasMatchedKey)} prefixAliasMatchedQuery=${JSON.stringify(searchResolution.prefixAliasMatchedQuery)} prefixAliasMatchedKey=${JSON.stringify(searchResolution.prefixAliasMatchedKey)} aliasMatchType=${JSON.stringify(searchResolution.aliasMatchType)} aliasConfidence=${JSON.stringify(searchResolution.aliasConfidence)} translatedQuery=${JSON.stringify(searchResolution.translatedQuery)} effectiveQuery=${JSON.stringify(searchResolution.effectiveQuery)} translationUsed=${searchResolution.translationUsed}`
  );

  if (cachedResponse && cachedResponse.suggestions.length >= requestedLimit) {
    console.info(`[igdb:suggestions] cache_hit key=suggestion:${normalizedOriginalQuery}`);
    return sliceSuggestionResponse(cachedResponse, requestedLimit);
  }

  const candidateQueries = mergeCandidateQueries(
    searchResolution.aliasCandidateQueries,
    buildTrailingCandidateQueries(searchResolution, queryInfo)
  );
  console.info(`[igdb:suggestions] candidateQueries=${JSON.stringify(candidateQueries)}`);

  const { mergedGames, rankedGames, candidateQueries: usedCandidateQueries } = await resolveRankedGames({
    queryInfo,
    fields: SUGGESTION_FIELDS,
    pipelineLimit,
    candidateQueries,
    aliasBoost,
    exactFloor: SUGGESTION_EXACT_QUERY_FETCH_LIMIT,
    wildcardFloor: SUGGESTION_WILDCARD_QUERY_FETCH_LIMIT
  });
  const suggestions = mapGameSuggestions(rankedGames).slice(0, pipelineLimit);
  const topRankedResultNames = getTopRankedResultNames(rankedGames);

  console.info(`[igdb:suggestions] usedCandidateQueries=${JSON.stringify(usedCandidateQueries)} topRankedResultNames=${JSON.stringify(topRankedResultNames)} igdbResultCount=${mergedGames.length} finalResultCount=${suggestions.length}`);

  const response = buildSuggestionResponse({
    searchResolution,
    suggestions
  });

  setCachedSuggestions(normalizedOriginalQuery, response);

  return sliceSuggestionResponse(response, requestedLimit);
}

async function getGameDetail({ gameId }) {
  const rawGames = await postGamesQuery(buildDetailQuery(gameId));
  const game = rawGames[0];

  if (!game) {
    logIgdbCounts('detail', rawGames, null);
    throw new AppError(404, 'GAME_NOT_FOUND', 'Game could not be found');
  }

  const mappedGame = mapGameDetail(game);

  logIgdbCounts('detail', rawGames, mappedGame);

  return {
    game: mappedGame
  };
}

module.exports = {
  getGameDetail,
  getGameSuggestions,
  getHighlights,
  getPopularGames,
  getRecommendedGames,
  searchGames
};
