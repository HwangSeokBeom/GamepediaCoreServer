const moderationService = require('./moderation.service');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');

const submitReport = asyncHandler(async (req, res) => {
  const result = await moderationService.submitReport({
    reporterUserId: req.auth.userId,
    ...req.body
  });

  res.status(201).json(successResponse(result));
});

const blockUser = asyncHandler(async (req, res) => {
  const result = await moderationService.blockUser({
    userId: req.auth.userId,
    blockedUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

const unblockUser = asyncHandler(async (req, res) => {
  const result = await moderationService.unblockUser({
    userId: req.auth.userId,
    blockedUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  blockUser,
  submitReport,
  unblockUser
};
