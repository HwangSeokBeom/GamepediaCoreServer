const igdbService = require('./igdb.service');
const libraryService = require('../library/library.service');
const { runWithLibraryRequestContext } = require('../library/library-request-context');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const { logger } = require('../../utils/logger');

function logHomeFilterResult({
  endpoint,
  filters,
  resultCount,
  elapsedMs
}) {
  logger.info('home-filter', {
    endpoint,
    platform: filters.platform ?? null,
    category: filters.category ?? null,
    gameMode: filters.gameMode ?? null,
    count: resultCount,
    elapsedMs
  });
}

const getHighlights = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await igdbService.getHighlights({
    limit: req.query.limit,
    platform: req.query.platform,
    category: req.query.category,
    gameMode: req.query.gameMode
  });
  logHomeFilterResult({
    endpoint: 'highlights',
    filters: req.query,
    resultCount: Array.isArray(result.games) ? result.games.length : 0,
    elapsedMs: Date.now() - startedAt
  });

  res.status(200).json(successResponse(result));
});

const getPopularGames = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await igdbService.getPopularGames({
    limit: req.query.limit,
    platform: req.query.platform,
    category: req.query.category,
    gameMode: req.query.gameMode
  });
  logHomeFilterResult({
    endpoint: 'popular',
    filters: req.query,
    resultCount: Array.isArray(result.games) ? result.games.length : 0,
    elapsedMs: Date.now() - startedAt
  });

  res.status(200).json(successResponse(result));
});

const getRecommendedGames = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await igdbService.getRecommendedGames({
    limit: req.query.limit,
    platform: req.query.platform,
    category: req.query.category,
    gameMode: req.query.gameMode
  });
  logHomeFilterResult({
    endpoint: 'recommended',
    filters: req.query,
    resultCount: Array.isArray(result.games) ? result.games.length : 0,
    elapsedMs: Date.now() - startedAt
  });

  res.status(200).json(successResponse(result));
});

const getGameSuggestions = asyncHandler(async (req, res) => {
  const result = await igdbService.getGameSuggestions({
    query: req.query.q,
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const searchGames = asyncHandler(async (req, res) => {
  const result = await igdbService.searchGames({
    query: req.query.q,
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const getGameDetail = asyncHandler(async (req, res) => {
  const result = await igdbService.getGameDetail({
    gameId: req.params.id
  });

  res.status(200).json(successResponse(result));
});

const getUnifiedGameDetail = asyncHandler(async (req, res) => {
  const result = await runWithLibraryRequestContext(() => libraryService.getLibraryGameDetail({
    userId: req.auth.userId,
    gameSource: req.query.gameSource,
    externalGameId: req.query.externalGameId,
    igdbGameId: req.query.igdbGameId
  }));

  res.status(200).json(successResponse(result));
});

module.exports = {
  getGameDetail,
  getUnifiedGameDetail,
  getGameSuggestions,
  getHighlights,
  getPopularGames,
  getRecommendedGames,
  searchGames
};
