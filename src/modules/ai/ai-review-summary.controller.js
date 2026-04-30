const aiReviewSummaryService = require('./ai-review-summary.service');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const { AppError } = require('../../utils/error-response');

const getGameReviewSummary = asyncHandler(async (req, res) => {
  if (!req.auth?.userId) {
    throw new AppError(401, 'UNAUTHORIZED', 'A valid bearer access token is required');
  }

  const result = await aiReviewSummaryService.getGameReviewSummary({
    currentUserId: req.auth.userId,
    gameId: req.params.gameId
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  getGameReviewSummary
};
