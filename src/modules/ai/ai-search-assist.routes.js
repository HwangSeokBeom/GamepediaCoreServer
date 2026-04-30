const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const aiSearchAssistController = require('./ai-search-assist.controller');
const {
  aiSearchAssistRequestSchema,
  buildAiSearchValidationError
} = require('./ai-search-assist.schema');

const router = express.Router();

router.post('/api/v1/ai/search-assist', authenticateAccessToken, validate({
  body: aiSearchAssistRequestSchema,
  errorMapper: buildAiSearchValidationError
}), aiSearchAssistController.createSearchAssist);

module.exports = router;
