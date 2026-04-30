const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const aiController = require('./ai.controller');
const {
  aiGameRecommendationRequestSchema,
  buildAiValidationError
} = require('./ai.schema');

const router = express.Router();

router.post('/api/v1/ai/game-recommendations', authenticateAccessToken, validate({
  body: aiGameRecommendationRequestSchema,
  errorMapper: buildAiValidationError
}), aiController.createGameRecommendations);

module.exports = router;
