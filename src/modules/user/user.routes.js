const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const userController = require('./user.controller');
const {
  blockUserBodySchema,
  blockedUserParamsSchema,
  buildUserValidationError,
  friendActivityFeedQuerySchema,
  friendProfileParamsSchema,
  friendRemovalParamsSchema,
  friendRequestBodySchema,
  friendRequestParamsSchema,
  markNotificationsReadSchema,
  notificationsQuerySchema,
  privacySettingsSchema,
  updateMyTitlesSchema,
  userSearchQuerySchema,
  updateCurrentUserProfileSchema
} = require('./user.validator');
const {
  requireProfileImageFile,
  uploadProfileImage
} = require('./profile-image.storage');

const router = express.Router();

router.get('/users/search', authenticateAccessToken, validate({
  query: userSearchQuerySchema,
  errorMapper: buildUserValidationError
}), userController.searchUsersForFriend);

router.get('/users/me', authenticateAccessToken, userController.getCurrentUserProfile);
router.get('/users/me/profile', authenticateAccessToken, userController.getCurrentUserProfile);
router.get('/users/me/recently-played', authenticateAccessToken, userController.getMyRecentlyPlayedProfileGames);
router.get('/users/me/friends/count', authenticateAccessToken, userController.getMyFriendsCount);
router.get('/users/me/titles', authenticateAccessToken, userController.getMyTitles);
router.get('/users/me/privacy', authenticateAccessToken, userController.getMyPrivacySettings);
router.get('/users/me/blocks', authenticateAccessToken, userController.getMyBlocks);
router.get('/users/me/friends', authenticateAccessToken, userController.getMyFriends);
router.get('/users/me/friends/activity', authenticateAccessToken, validate({
  query: friendActivityFeedQuerySchema,
  errorMapper: buildUserValidationError
}), userController.getMyFriendsActivity);
router.get('/users/me/widgets/friends/activity-summary', authenticateAccessToken, userController.getMyFriendActivityWidgetSummary);
router.get('/users/me/widgets/recommendations/summary', authenticateAccessToken, userController.getMyRecommendationWidgetSummary);
router.get('/users/me/steam-friends', authenticateAccessToken, userController.getMySteamFriends);
router.get('/users/me/friend-requests/received', authenticateAccessToken, userController.getReceivedFriendRequests);
router.get('/users/me/friend-requests/sent', authenticateAccessToken, userController.getSentFriendRequests);
router.get('/users/me/recommendations/friends', authenticateAccessToken, userController.getMyFriendRecommendations);
router.get('/users/me/notifications', authenticateAccessToken, validate({
  query: notificationsQuerySchema,
  errorMapper: buildUserValidationError
}), userController.getMyNotifications);

router.patch('/users/me', authenticateAccessToken, validate({
  body: updateCurrentUserProfileSchema,
  errorMapper: buildUserValidationError
}), userController.updateCurrentUserProfile);
router.patch('/users/me/titles', authenticateAccessToken, validate({
  body: updateMyTitlesSchema,
  errorMapper: buildUserValidationError
}), userController.updateMyTitles);
router.patch('/users/me/privacy', authenticateAccessToken, validate({
  body: privacySettingsSchema,
  errorMapper: buildUserValidationError
}), userController.updateMyPrivacySettings);

router.post('/users/me/friend-requests', authenticateAccessToken, validate({
  body: friendRequestBodySchema,
  errorMapper: buildUserValidationError
}), userController.sendFriendRequest);
router.post('/users/me/blocks', authenticateAccessToken, validate({
  body: blockUserBodySchema,
  errorMapper: buildUserValidationError
}), userController.blockUserForCurrentUser);

router.patch('/users/me/notifications/read', authenticateAccessToken, validate({
  body: markNotificationsReadSchema,
  errorMapper: buildUserValidationError
}), userController.markNotificationsRead);

router.patch('/users/me/notifications/read-all', authenticateAccessToken, userController.markAllNotificationsRead);
router.patch('/users/me/friend-requests/:id/accept', authenticateAccessToken, validate({
  params: friendRequestParamsSchema,
  errorMapper: buildUserValidationError
}), userController.acceptFriendRequest);
router.patch('/users/me/friend-requests/:id/reject', authenticateAccessToken, validate({
  params: friendRequestParamsSchema,
  errorMapper: buildUserValidationError
}), userController.rejectFriendRequest);

router.patch(
  '/users/me/profile-image',
  authenticateAccessToken,
  uploadProfileImage,
  requireProfileImageFile,
  userController.updateCurrentUserProfileImage
);

router.delete('/users/me/profile-image', authenticateAccessToken, userController.removeCurrentUserProfileImage);
router.delete('/users/me/friends/:friendUserId', authenticateAccessToken, validate({
  params: friendRemovalParamsSchema,
  errorMapper: buildUserValidationError
}), userController.removeFriend);
router.delete('/users/me/friend-requests/:id', authenticateAccessToken, validate({
  params: friendRequestParamsSchema,
  errorMapper: buildUserValidationError
}), userController.cancelFriendRequest);
router.delete('/users/me/blocks/:blockedUserId', authenticateAccessToken, validate({
  params: blockedUserParamsSchema,
  errorMapper: buildUserValidationError
}), userController.unblockUserForCurrentUser);

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
router.get('/users/:userId/profile', authenticateAccessToken, validate({
  params: friendProfileParamsSchema,
  errorMapper: buildUserValidationError
}), userController.getFriendProfile);
router.get('/users/:userId/presence', authenticateAccessToken, validate({
  params: friendProfileParamsSchema,
  errorMapper: buildUserValidationError
}), userController.getUserPresence);
router.get('/users/:userId/library/preview', authenticateAccessToken, validate({
  params: friendProfileParamsSchema,
  errorMapper: buildUserValidationError
}), userController.getFriendLibraryPreview);
router.get('/users/:userId/reviews/preview', authenticateAccessToken, validate({
  params: friendProfileParamsSchema,
  errorMapper: buildUserValidationError
}), userController.getFriendReviewsPreview);
router.get('/users/:userId/taste-similarity', authenticateAccessToken, validate({
  params: friendProfileParamsSchema,
  errorMapper: buildUserValidationError
}), userController.getTasteSimilarity);
router.get('/users/:userId/taste-profile', authenticateAccessToken, validate({
  params: friendProfileParamsSchema,
  errorMapper: buildUserValidationError
}), userController.getTasteProfile);
router.get('/users/:userId/common-interests', authenticateAccessToken, validate({
  params: friendProfileParamsSchema,
  errorMapper: buildUserValidationError
}), userController.getCommonInterests);
router.get('/users/:userId/shared-games', authenticateAccessToken, validate({
  params: friendProfileParamsSchema,
  errorMapper: buildUserValidationError
}), userController.getSharedGames);

module.exports = router;
