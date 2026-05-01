const aiService = require('./ai.service');
const aiLibraryCuratorService = require('./ai-library-curator.service');
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
    limit: req.body.limit,
    personalization: req.body.personalization,
    includeOwned: req.body.includeOwned,
    includeReviewed: req.body.includeReviewed,
    includeFavorites: req.body.includeFavorites
  });

  res.status(200).json(successResponse(result));
});

const getGameReviewSummary = asyncHandler(async (req, res) => {
  const result = await aiService.getGameReviewSummary({
    gameId: req.params.gameId
  });

  res.status(200).json(successResponse(result));
});

const createLibraryCuratorRecommendation = asyncHandler(async (req, res) => {
  if (!req.auth?.userId) {
    throw new AppError(401, 'UNAUTHORIZED', 'A valid bearer access token is required');
  }

  const result = await aiLibraryCuratorService.createLibraryCuratorRecommendation({
    userId: req.auth.userId,
    query: req.body.query,
    mode: req.body.mode,
    limit: req.body.limit,
    locale: req.body.locale,
    candidateScope: req.body.candidateScope,
    excludedGameIds: req.body.excludedGameIds,
    enforceDailyLimit: true
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  createGameRecommendations,
  createLibraryCuratorRecommendation,
  getGameReviewSummary
};
