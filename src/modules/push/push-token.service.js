const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const {
  hashPushToken,
  maskPushToken,
  normalizeNullableString
} = require('./push-token.utils');

function buildTokenUpdateData({ token, tokenHash, platform, deviceId, appVersion, buildNumber, environment }) {
  return {
    token,
    tokenHash,
    platform,
    deviceId,
    appVersion,
    buildNumber,
    environment,
    isActive: true,
    lastSeenAt: new Date()
  };
}

async function registerPushToken({
  userId,
  token,
  platform,
  deviceId = null,
  appVersion = null,
  buildNumber = null,
  environment = null
}) {
  const normalizedToken = token.trim();
  const tokenHash = hashPushToken(normalizedToken);
  const normalizedPlatform = platform.toLowerCase();
  const normalizedDeviceId = normalizeNullableString(deviceId);
  const normalizedAppVersion = normalizeNullableString(appVersion, 50);
  const normalizedBuildNumber = normalizeNullableString(buildNumber, 50);
  const normalizedEnvironment = normalizeNullableString(environment, 50)?.toLowerCase() ?? null;
  const tokenMasked = maskPushToken(normalizedToken);

  try {
    const tokenRecord = await prisma.$transaction(async (tx) => {
      const data = buildTokenUpdateData({
        token: normalizedToken,
        tokenHash,
        platform: normalizedPlatform,
        deviceId: normalizedDeviceId,
        appVersion: normalizedAppVersion,
        buildNumber: normalizedBuildNumber,
        environment: normalizedEnvironment
      });

      if (normalizedDeviceId) {
        await tx.userPushToken.deleteMany({
          where: {
            userId,
            deviceId: normalizedDeviceId,
            platform: normalizedPlatform,
            environment: normalizedEnvironment,
            tokenHash: { not: tokenHash }
          }
        });
      }

      return tx.userPushToken.upsert({
        where: { tokenHash },
        update: {
          userId,
          ...data
        },
        create: {
          userId,
          ...data
        }
      });
    });

    logger.info('[PushToken] upsert', {
      userId,
      platform: normalizedPlatform,
      environment: normalizedEnvironment,
      deviceId: normalizedDeviceId,
      tokenMasked
    });

    return {
      registered: true,
      tokenId: tokenRecord.id
    };
  } catch (error) {
    logger.warn('[PushToken] registration failed', {
      userId,
      platform: normalizedPlatform,
      environment: normalizedEnvironment,
      tokenMasked,
      code: error?.code ?? null,
      message: error?.message ?? 'Push token registration failed'
    });

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(409, 'PUSH_TOKEN_REGISTRATION_FAILED', 'Push token registration conflicted');
    }

    throw new AppError(500, 'PUSH_TOKEN_REGISTRATION_FAILED', 'Push token registration failed');
  }
}

async function deletePushToken({ userId, deviceId = null, token = null }) {
  const normalizedDeviceId = normalizeNullableString(deviceId);
  const normalizedToken = normalizeNullableString(token, 4096);
  const tokenHash = normalizedToken ? hashPushToken(normalizedToken) : null;

  if (!normalizedDeviceId && !normalizedToken) {
    throw new AppError(400, 'PUSH_TOKEN_INVALID', 'deviceId or token is required');
  }

  const filters = [];

  if (normalizedDeviceId) {
    filters.push({ deviceId: normalizedDeviceId });
  }

  if (normalizedToken) {
    filters.push({ tokenHash });
  }

  const result = await prisma.userPushToken.updateMany({
    where: {
      userId,
      OR: filters
    },
    data: {
      isActive: false
    }
  });

  logger.info('[PushToken] deactivated', {
    reason: 'logout',
    userId,
    deviceId: normalizedDeviceId,
    tokenMasked: normalizedToken ? maskPushToken(normalizedToken) : null,
    updatedCount: result.count
  });

  return {
    deactivated: true,
    updatedCount: result.count
  };
}

module.exports = {
  deletePushToken,
  registerPushToken
};
