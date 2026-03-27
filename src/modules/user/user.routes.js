const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const userController = require('./user.controller');
const {
  buildUserValidationError,
  updateCurrentUserProfileSchema
} = require('./user.validator');
const {
  requireProfileImageFile,
  uploadProfileImage
} = require('./profile-image.storage');

const router = express.Router();

router.get('/users/me', authenticateAccessToken, userController.getCurrentUserProfile);

router.patch('/users/me', authenticateAccessToken, validate({
  body: updateCurrentUserProfileSchema,
  errorMapper: buildUserValidationError
}), userController.updateCurrentUserProfile);

router.patch(
  '/users/me/profile-image',
  authenticateAccessToken,
  uploadProfileImage,
  requireProfileImageFile,
  userController.updateCurrentUserProfileImage
);

router.delete('/users/me/profile-image', authenticateAccessToken, userController.removeCurrentUserProfileImage);

router.patch('/auth/me', authenticateAccessToken, validate({
  body: updateCurrentUserProfileSchema,
  errorMapper: buildUserValidationError
}), userController.updateCurrentUserProfile);

router.patch(
  '/auth/me/profile-image',
  authenticateAccessToken,
  uploadProfileImage,
  requireProfileImageFile,
  userController.updateCurrentUserProfileImage
);

router.delete('/auth/me/profile-image', authenticateAccessToken, userController.removeCurrentUserProfileImage);

module.exports = router;
