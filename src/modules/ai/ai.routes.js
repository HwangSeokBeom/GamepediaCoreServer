const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const aiController = require('./ai.controller');
const aiSearchAssistRoutes = require('./ai-search-assist.routes');
const {
  aiGameRecommendationRequestSchema,
  aiReviewSummaryParamsSchema,
  buildAiValidationError
} = require('./ai.schema');

const router = express.Router();

router.use(aiSearchAssistRoutes);

router.get('/api/v1/ai/games/:gameId/review-summary', authenticateAccessToken, validate({
  params: aiReviewSummaryParamsSchema,
  errorMapper: buildAiValidationError
}), aiController.getGameReviewSummary);

router.post('/api/v1/ai/game-recommendations', authenticateAccessToken, validate({
  body: aiGameRecommendationRequestSchema,
  errorMapper: buildAiValidationError
}), aiController.createGameRecommendations);

module.exports = router;
