const aiSearchAssistService = require('./ai-search-assist.service');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const { AppError } = require('../../utils/error-response');

const createSearchAssist = asyncHandler(async (req, res) => {
  if (!req.auth?.userId) {
    throw new AppError(401, 'UNAUTHORIZED', 'A valid bearer access token is required');
  }

  await aiSearchAssistService.assertAndIncrementDailyUsage({
    userId: req.auth.userId
  });

  const result = await aiSearchAssistService.createSearchAssist({
    userId: req.auth.userId,
    query: req.body.query,
    platforms: req.body.platforms,
    genres: req.body.genres,
    limit: req.body.limit
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  createSearchAssist
};
