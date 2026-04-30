const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const aiController = require('./ai.controller');
const aiReviewSummaryController = require('./ai-review-summary.controller');
const {
  aiGameRecommendationRequestSchema,
  buildAiValidationError
} = require('./ai.schema');
const {
  buildAiReviewSummaryValidationError,
  gameIdParamSchema
} = require('./ai-review-summary.schema');

const router = express.Router();

router.get('/api/v1/ai/games/:gameId/review-summary', authenticateAccessToken, validate({
  params: gameIdParamSchema,
  errorMapper: buildAiReviewSummaryValidationError
}), aiReviewSummaryController.getGameReviewSummary);

router.post('/api/v1/ai/game-recommendations', authenticateAccessToken, validate({
  body: aiGameRecommendationRequestSchema,
  errorMapper: buildAiValidationError
}), aiController.createGameRecommendations);

module.exports = router;
