const { UserStatus } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { buildAccountStatusError } = require('../../utils/auth-error');
const { AppError } = require('../../utils/error-response');
const { deleteStoredProfileImage, buildStoredProfileImagePath } = require('./profile-image.storage');
const { mapUserToDto } = require('./user.mapper');

async function getEditableCurrentUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  if (!user) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'User account could not be found');
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw buildAccountStatusError(user.status);
  }

  return user;
}

async function safelyDeleteProfileImage(profileImageUrl, context) {
  try {
    const deleted = await deleteStoredProfileImage(profileImageUrl);

    if (deleted) {
      console.info(
        `[profile-image] cleanup userId=${context.userId} action=${context.action}`
      );
    }
  } catch (error) {
    console.warn(
      `[profile-image] cleanup_failed userId=${context.userId} action=${context.action} message=${error?.message ?? 'unknown'}`
    );
  }
}

async function getCurrentUserProfile({ userId }) {
  const user = await getEditableCurrentUser(userId);

  return {
    user: mapUserToDto(user)
  };
}

async function updateCurrentUserProfile({ userId, nickname }) {
  await getEditableCurrentUser(userId);

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      nickname: nickname.trim()
    }
  });

  console.info(`[profile] updated userId=${userId} fields=nickname`);

  return {
    user: mapUserToDto(updatedUser)
  };
}

async function updateCurrentUserProfileImage({ userId, fileName }) {
  const user = await getEditableCurrentUser(userId);
  const profileImageUrl = buildStoredProfileImagePath(fileName);

  let updatedUser;

  try {
    updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        profileImageUrl
      }
    });
  } catch (error) {
    await safelyDeleteProfileImage(profileImageUrl, {
      userId,
      action: 'rollback'
    });
    throw error;
  }

  if (user.profileImageUrl && user.profileImageUrl !== profileImageUrl) {
    await safelyDeleteProfileImage(user.profileImageUrl, {
      userId,
      action: 'replace'
    });
  }

  console.info(`[profile-image] uploaded userId=${userId} profileImageUrl=${profileImageUrl}`);

  return {
    user: mapUserToDto(updatedUser)
  };
}

async function removeCurrentUserProfileImage({ userId }) {
  const user = await getEditableCurrentUser(userId);

  if (!user.profileImageUrl) {
    console.info(`[profile-image] removed userId=${userId} hadImage=false`);

    return {
      user: mapUserToDto(user)
    };
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      profileImageUrl: null
    }
  });

  await safelyDeleteProfileImage(user.profileImageUrl, {
    userId,
    action: 'remove'
  });

  console.info(`[profile-image] removed userId=${userId} hadImage=true`);

  return {
    user: mapUserToDto(updatedUser)
  };
}

module.exports = {
  getCurrentUserProfile,
  removeCurrentUserProfileImage,
  updateCurrentUserProfile,
  updateCurrentUserProfileImage
};
