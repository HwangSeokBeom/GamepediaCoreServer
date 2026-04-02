const { env } = require('../../config/env');

function normalizeProfileImageUrl(profileImageUrl) {
  if (typeof profileImageUrl !== 'string') {
    return null;
  }

  const normalizedProfileImageUrl = profileImageUrl.trim();

  if (!normalizedProfileImageUrl) {
    return null;
  }

  if (/^https?:\/\//i.test(normalizedProfileImageUrl)) {
    return normalizedProfileImageUrl;
  }

  if (normalizedProfileImageUrl.startsWith('/')) {
    const apiPublicBaseUrl = env.apiPublicBaseUrl?.replace(/\/$/, '');

    return apiPublicBaseUrl
      ? `${apiPublicBaseUrl}${normalizedProfileImageUrl}`
      : normalizedProfileImageUrl;
  }

  return normalizedProfileImageUrl;
}

function mapUserToDto(user) {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    profileImageUrl: normalizeProfileImageUrl(user.profileImageUrl),
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function mapBasicUserProfile(user) {
  return {
    id: user.id,
    nickname: user.nickname,
    profileImageUrl: normalizeProfileImageUrl(user.profileImageUrl),
    bio: user.bio ?? null
  };
}

function mapUserSearchResult(user, relationshipState) {
  return {
    ...mapBasicUserProfile(user),
    isSelf: Boolean(relationshipState?.isSelf),
    canRequest: Boolean(relationshipState?.canRequest),
    alreadyFriend: Boolean(relationshipState?.alreadyFriend),
    pendingSent: Boolean(relationshipState?.pendingSent),
    pendingReceived: Boolean(relationshipState?.pendingReceived)
  };
}

function mapFriendRequestDto(friendRequest) {
  return {
    id: friendRequest.id,
    status: typeof friendRequest.status === 'string' ? friendRequest.status.toLowerCase() : null,
    createdAt: friendRequest.createdAt,
    updatedAt: friendRequest.updatedAt,
    fromUser: friendRequest.fromUser ? mapBasicUserProfile(friendRequest.fromUser) : null,
    toUser: friendRequest.toUser ? mapBasicUserProfile(friendRequest.toUser) : null
  };
}

function mapFriendshipDto(friendship) {
  const friend = friendship.friend ?? friendship.user;

  return {
    id: friend?.id ?? null,
    nickname: friend?.nickname ?? null,
    profileImageUrl: normalizeProfileImageUrl(friend?.profileImageUrl),
    friendSince: friendship.createdAt
  };
}

function mapNotificationToDto(notification) {
  const payload = notification?.payload && typeof notification.payload === 'object'
    ? notification.payload
    : null;

  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    createdAt: notification.createdAt,
    isRead: Boolean(notification.isRead),
    relatedGameId: notification.relatedGameId ?? null,
    deepLink: typeof payload?.deepLink === 'string' ? payload.deepLink : null,
    payload
  };
}

module.exports = {
  mapBasicUserProfile,
  mapFriendRequestDto,
  mapFriendshipDto,
  mapNotificationToDto,
  mapUserSearchResult,
  mapUserToDto,
  normalizeProfileImageUrl
};
