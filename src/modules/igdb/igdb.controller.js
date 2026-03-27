const igdbService = require('./igdb.service');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');

const getHighlights = asyncHandler(async (req, res) => {
  const result = await igdbService.getHighlights({
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const getPopularGames = asyncHandler(async (req, res) => {
  const result = await igdbService.getPopularGames({
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const getRecommendedGames = asyncHandler(async (req, res) => {
  const result = await igdbService.getRecommendedGames({
    limit: req.query.limit
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

module.exports = {
  getGameDetail,
  getGameSuggestions,
  getHighlights,
  getPopularGames,
  getRecommendedGames,
  searchGames
};
