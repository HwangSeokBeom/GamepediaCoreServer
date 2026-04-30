const aiService = require('./ai.service');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const { AppError } = require('../../utils/error-response');

const createGameRecommendations = asyncHandler(async (req, res) => {
  if (!req.auth?.userId) {
    throw new AppError(401, 'UNAUTHORIZED', 'A valid bearer access token is required');
  }

  await aiService.assertAndIncrementDailyUsage({
    userId: req.auth.userId
  });

  const result = await aiService.createGameRecommendations({
    userId: req.auth.userId,
    query: req.body.query,
    platforms: req.body.platforms,
    preferredGenres: req.body.preferredGenres,
    excludedGameIds: req.body.excludedGameIds,
    limit: req.body.limit
  });

  res.status(200).json(successResponse(result));
});

const getGameReviewSummary = asyncHandler(async (req, res) => {
  const result = await aiService.getGameReviewSummary({
    gameId: req.params.gameId
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  createGameRecommendations,
  getGameReviewSummary
};
