const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const { logger } = require('../../utils/logger');
const { runWithLibraryRequestContext } = require('../library/library-request-context');
const libraryService = require('../library/library.service');
const userService = require('./user.service');

const getCurrentUserProfile = asyncHandler(async (req, res) => {
  const result = await userService.getCurrentUserProfile({
    userId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const getMyRecentlyPlayedProfileGames = asyncHandler(async (req, res) => {
  const result = await runWithLibraryRequestContext(() => userService.getMyRecentlyPlayedProfileGames({
    userId: req.auth.userId
  }));
  const games = Array.isArray(result?.games) ? result.games : [];

  res.status(200).json(successResponse({
    ...result,
    games,
    recentGames: Array.isArray(result?.recentGames) ? result.recentGames : games,
    recentlyPlayed: Array.isArray(result?.recentlyPlayed) ? result.recentlyPlayed : games,
    recentPlayedPreview: Array.isArray(result?.recentPlayedPreview) ? result.recentPlayedPreview : games,
    hasMoreRecentPlayed: Boolean(result?.hasMoreRecentPlayed)
  }));
});

const getMyFriendsCount = asyncHandler(async (req, res) => {
  const result = await userService.getMyFriendsCount({
    userId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const getMyTitles = asyncHandler(async (req, res) => {
  const result = await userService.getMyTitles({
    userId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const updateMyTitles = asyncHandler(async (req, res) => {
  const result = await userService.updateMyTitles({
    userId: req.auth.userId,
    selectedTitleKeys: req.body.selectedTitleKeys ?? req.body.selectedTitles
  });

  res.status(200).json(successResponse(result));
});

const updateCurrentUserProfile = asyncHandler(async (req, res) => {
  const result = await userService.updateCurrentUserProfile({
    userId: req.auth.userId,
    nickname: req.body.nickname,
    selectedTitleKeys: req.body.selectedTitleKeys ?? req.body.selectedTitles
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

const getMyNotifications = asyncHandler(async (req, res) => {
  const result = await userService.getMyNotifications({
    userId: req.auth.userId,
    page: req.query.page,
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const markNotificationsRead = asyncHandler(async (req, res) => {
  const result = await userService.markNotificationsRead({
    userId: req.auth.userId,
    ids: req.body.ids
  });

  res.status(200).json(successResponse(result));
});

const markAllNotificationsRead = asyncHandler(async (req, res) => {
  const result = await userService.markAllNotificationsRead({
    userId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const searchUsersForFriend = asyncHandler(async (req, res) => {
  if (req.query.keywordAliasUsed) {
    logger.info('friend-search-alias-resolved', {
      userId: req.auth.userId,
      alias: 'nickname'
    });
  }

  const result = await userService.searchUsersForFriend({
    currentUserId: req.auth.userId,
    keyword: req.query.keyword
  });

  res.status(200).json(successResponse(result));
});

const sendFriendRequest = asyncHandler(async (req, res) => {
  if (req.body.aliasFieldUsed) {
    logger.info('friend-request-alias-resolved', {
      endpoint: 'POST /users/me/friend-requests',
      resolvedFromField: req.body.resolvedFromField,
      canonicalField: 'toUserId',
      userId: req.auth.userId
    });
  }

  const result = await userService.sendFriendRequest({
    currentUserId: req.auth.userId,
    toUserId: req.body.resolvedToUserId ?? req.body.toUserId
  });

  res.status(200).json(successResponse(result));
});

const getReceivedFriendRequests = asyncHandler(async (req, res) => {
  const result = await userService.getReceivedFriendRequests({
    currentUserId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const getSentFriendRequests = asyncHandler(async (req, res) => {
  const result = await userService.getSentFriendRequests({
    currentUserId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const acceptFriendRequest = asyncHandler(async (req, res) => {
  const result = await userService.acceptFriendRequest({
    currentUserId: req.auth.userId,
    requestId: req.params.id
  });

  res.status(200).json(successResponse(result));
});

const rejectFriendRequest = asyncHandler(async (req, res) => {
  const result = await userService.rejectFriendRequest({
    currentUserId: req.auth.userId,
    requestId: req.params.id
  });

  res.status(200).json(successResponse(result));
});

const cancelFriendRequest = asyncHandler(async (req, res) => {
  const result = await userService.cancelFriendRequest({
    currentUserId: req.auth.userId,
    requestId: req.params.id
  });

  res.status(200).json(successResponse(result));
});

const getMyFriends = asyncHandler(async (req, res) => {
  const result = await userService.getMyFriends({
    currentUserId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const getFriendProfile = asyncHandler(async (req, res) => {
  const result = await userService.getFriendProfile({
    currentUserId: req.auth.userId,
    targetUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

const getFriendLibraryPreview = asyncHandler(async (req, res) => {
  const result = await userService.getFriendLibraryPreview({
    currentUserId: req.auth.userId,
    targetUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

const getFriendReviewsPreview = asyncHandler(async (req, res) => {
  const result = await userService.getFriendReviewsPreview({
    currentUserId: req.auth.userId,
    targetUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

const getMyFriendsActivity = asyncHandler(async (req, res) => {
  const result = await runWithLibraryRequestContext(() => userService.getMyFriendsActivity({
    currentUserId: req.auth.userId,
    cursor: req.query.cursor,
    limit: req.query.limit
  }));

  res.status(200).json(successResponse(result));
});

const getMySteamFriends = asyncHandler(async (req, res) => {
  const result = await userService.getMySteamFriends({
    currentUserId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const getMySteamLinkStatus = asyncHandler(async (req, res) => {
  const result = await runWithLibraryRequestContext(() => libraryService.getMySteamLinkStatus({
    userId: req.auth.userId
  }));

  res.status(200).json(successResponse(result));
});

const getTasteSimilarity = asyncHandler(async (req, res) => {
  const result = await userService.getTasteSimilarity({
    currentUserId: req.auth.userId,
    targetUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

const getTasteProfile = asyncHandler(async (req, res) => {
  const result = await userService.getTasteProfile({
    currentUserId: req.auth.userId,
    targetUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

const getCommonInterests = asyncHandler(async (req, res) => {
  const result = await userService.getCommonInterests({
    currentUserId: req.auth.userId,
    targetUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

const getSharedGames = asyncHandler(async (req, res) => {
  const result = await userService.getSharedGames({
    currentUserId: req.auth.userId,
    targetUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

const getMyFriendRecommendations = asyncHandler(async (req, res) => {
  const result = await runWithLibraryRequestContext(() => userService.getMyFriendRecommendations({
    currentUserId: req.auth.userId
  }));

  res.status(200).json(successResponse(result));
});

const getFriendRecommendations = asyncHandler(async (req, res) => {
  const result = await runWithLibraryRequestContext(() => userService.getFriendRecommendations({
    currentUserId: req.auth.userId,
    targetUserId: req.params.userId
  }));

  res.status(200).json(successResponse(result));
});

const getMyFriendActivityWidgetSummary = asyncHandler(async (req, res) => {
  const result = await runWithLibraryRequestContext(() => userService.getMyFriendActivityWidgetSummary({
    currentUserId: req.auth.userId
  }));

  res.status(200).json(successResponse(result));
});

const getMyRecommendationWidgetSummary = asyncHandler(async (req, res) => {
  const result = await runWithLibraryRequestContext(() => userService.getMyRecommendationWidgetSummary({
    currentUserId: req.auth.userId
  }));

  res.status(200).json(successResponse(result));
});

const removeFriend = asyncHandler(async (req, res) => {
  const result = await userService.removeFriend({
    currentUserId: req.auth.userId,
    friendUserId: req.params.friendUserId
  });

  res.status(200).json(successResponse(result));
});

const getMyBlocks = asyncHandler(async (req, res) => {
  const result = await userService.getMyBlocks({
    currentUserId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const blockUserForCurrentUser = asyncHandler(async (req, res) => {
  const result = await userService.blockUserForCurrentUser({
    currentUserId: req.auth.userId,
    blockedUserId: req.body.blockedUserId
  });

  res.status(200).json(successResponse(result));
});

const unblockUserForCurrentUser = asyncHandler(async (req, res) => {
  const result = await userService.unblockUserForCurrentUser({
    currentUserId: req.auth.userId,
    blockedUserId: req.params.blockedUserId
  });

  res.status(200).json(successResponse(result));
});

const getMyPrivacySettings = asyncHandler(async (req, res) => {
  const result = await userService.getMyPrivacySettings({
    currentUserId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const updateMyPrivacySettings = asyncHandler(async (req, res) => {
  const result = await userService.updateMyPrivacySettings({
    currentUserId: req.auth.userId,
    privacySettings: req.body
  });

  res.status(200).json(successResponse(result));
});

const getUserPresence = asyncHandler(async (req, res) => {
  const result = await userService.getUserPresence({
    currentUserId: req.auth.userId,
    targetUserId: req.params.userId
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  acceptFriendRequest,
  blockUserForCurrentUser,
  cancelFriendRequest,
  getCurrentUserProfile,
  getMyFriendsCount,
  getFriendLibraryPreview,
  getFriendProfile,
  getFriendReviewsPreview,
  getCommonInterests,
  getMyBlocks,
  getMyFriendActivityWidgetSummary,
  getMyFriends,
  getMyFriendsActivity,
  getMySteamFriends,
  getMySteamLinkStatus,
  getFriendRecommendations,
  getMyFriendRecommendations,
  getMyRecommendationWidgetSummary,
  getMyNotifications,
  getMyPrivacySettings,
  getMyRecentlyPlayedProfileGames,
  getReceivedFriendRequests,
  getSentFriendRequests,
  getSharedGames,
  getTasteProfile,
  getTasteSimilarity,
  getMyTitles,
  getUserPresence,
  markAllNotificationsRead,
  markNotificationsRead,
  removeFriend,
  removeCurrentUserProfileImage,
  rejectFriendRequest,
  searchUsersForFriend,
  sendFriendRequest,
  unblockUserForCurrentUser,
  updateCurrentUserProfile,
  updateMyTitles,
  updateMyPrivacySettings,
  updateCurrentUserProfileImage
};
