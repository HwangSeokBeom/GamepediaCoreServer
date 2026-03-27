const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const moderationController = require('./moderation.controller');
const {
  blockUserParamsSchema,
  buildModerationValidationError,
  createReportSchema
} = require('./moderation.validator');

const router = express.Router();

router.post('/reports', authenticateAccessToken, validate({
  body: createReportSchema,
  errorMapper: buildModerationValidationError
}), moderationController.submitReport);

router.post('/users/:userId/block', authenticateAccessToken, validate({
  params: blockUserParamsSchema,
  errorMapper: buildModerationValidationError
}), moderationController.blockUser);

router.delete('/users/:userId/block', authenticateAccessToken, validate({
  params: blockUserParamsSchema,
  errorMapper: buildModerationValidationError
}), moderationController.unblockUser);

module.exports = router;
