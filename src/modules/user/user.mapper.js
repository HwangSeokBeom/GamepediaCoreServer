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

module.exports = {
  mapUserToDto,
  normalizeProfileImageUrl
};
