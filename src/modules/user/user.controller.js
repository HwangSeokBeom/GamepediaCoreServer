const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const userService = require('./user.service');

const getCurrentUserProfile = asyncHandler(async (req, res) => {
  const result = await userService.getCurrentUserProfile({
    userId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const updateCurrentUserProfile = asyncHandler(async (req, res) => {
  const result = await userService.updateCurrentUserProfile({
    userId: req.auth.userId,
    nickname: req.body.nickname
  });

  res.status(200).json(successResponse(result));
});

const updateCurrentUserProfileImage = asyncHandler(async (req, res) => {
  const result = await userService.updateCurrentUserProfileImage({
    userId: req.auth.userId,
    fileName: req.file.filename
  });

  res.status(200).json(successResponse(result));
});

const removeCurrentUserProfileImage = asyncHandler(async (req, res) => {
  const result = await userService.removeCurrentUserProfileImage({
    userId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  getCurrentUserProfile,
  removeCurrentUserProfileImage,
  updateCurrentUserProfile,
  updateCurrentUserProfileImage
};
