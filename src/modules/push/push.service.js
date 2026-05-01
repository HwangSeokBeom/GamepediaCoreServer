const firebaseAdmin = require('../../config/firebase-admin');
const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const { maskPushToken } = require('./push-token.utils');

const FCM_MULTICAST_LIMIT = 500;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;
const INVALID_TOKEN_ERROR_CODES = new Set([
  'messaging/invalid-argument',
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered'
]);

function truncateText(value, maxLength) {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return normalizedValue.slice(0, Math.max(maxLength - 1, 0)).trimEnd();
}

function stringifyDataValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) {
    return String(value);
  }

  return JSON.stringify(value);
}

function normalizeDataPayload(data = {}) {
  const normalizedData = {};

  for (const [key, value] of Object.entries(data ?? {})) {
    const stringValue = stringifyDataValue(value);

    if (stringValue !== null) {
      normalizedData[key] = stringValue;
    }
  }

  normalizedData.source = 'push';
  return normalizedData;
}

function chunkArray(values, size) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

async function getUnreadBadgeCount(userId) {
  try {
    return await prisma.userNotification.count({
      where: {
        userId,
        isRead: false
      }
    });
  } catch (error) {
    logger.warn('[Push] badge count skipped', {
      userId,
      message: error?.message ?? 'Unread badge count failed'
    });
    return null;
  }
}

function isTestPushAllowed() {
  return env.nodeEnv !== 'production' && env.appEnv !== 'production';
}

function buildApnsConfig({ badge, contentAvailable = false } = {}) {
  const aps = {
    sound: 'default'
  };

  if (Number.isInteger(badge) && badge >= 0) {
    aps.badge = badge;
  }

  if (contentAvailable) {
    aps.contentAvailable = true;
  }

  return {
    payload: {
      aps
    }
  };
}

async function sendToUser(userId, payload = {}) {
  const messaging = firebaseAdmin.getFirebaseMessaging();

  if (!messaging) {
    const state = firebaseAdmin.getFirebaseAdminState();

    logger.warn('[Push] skipped', {
      reason: 'disabled',
      firebaseReason: state.reason,
      userId,
      type: payload?.data?.type ?? null,
      notificationId: payload?.data?.notificationId ?? null
    });

    return {
      sent: false,
      skippedReason: 'disabled',
      tokenCount: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokenCount: 0
    };
  }

  const tokens = await prisma.userPushToken.findMany({
    where: {
      userId,
      isActive: true
    },
    select: {
      id: true,
      token: true
    },
    orderBy: [{ lastSeenAt: 'desc' }]
  });

  if (tokens.length === 0) {
    logger.info('[Push] skipped', {
      reason: 'noActiveToken',
      userId,
      type: payload?.data?.type ?? null,
      notificationId: payload?.data?.notificationId ?? null
    });

    return {
      sent: false,
      skippedReason: 'noActiveToken',
      tokenCount: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokenCount: 0
    };
  }

  const data = normalizeDataPayload(payload.data);
  const title = truncateText(payload.notification?.title ?? payload.title, MAX_TITLE_LENGTH);
  const body = truncateText(payload.notification?.body ?? payload.body, MAX_BODY_LENGTH);
  const badge = payload.apns?.payload?.aps?.badge ?? await getUnreadBadgeCount(userId);
  let successCount = 0;
  let failureCount = 0;
  const invalidTokenIds = [];

  logger.info('[Push] sendToUser', {
    userId,
    tokenCount: tokens.length,
    type: data.type ?? null,
    notificationId: data.notificationId ?? null
  });

  for (const tokenChunk of chunkArray(tokens, FCM_MULTICAST_LIMIT)) {
    let response;

    try {
      response = await messaging.sendEachForMulticast({
        tokens: tokenChunk.map((tokenRecord) => tokenRecord.token),
        notification: {
          title,
          body
        },
        data,
        apns: payload.apns ?? buildApnsConfig({
          badge,
          contentAvailable: payload.contentAvailable
        })
      });
    } catch (error) {
      failureCount += tokenChunk.length;
      logger.warn('[Push] multicast failed', {
        userId,
        tokenCount: tokenChunk.length,
        type: data.type ?? null,
        notificationId: data.notificationId ?? null,
        code: error?.code ?? null,
        message: error?.message ?? 'FCM multicast send failed'
      });
      continue;
    }

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((sendResponse, index) => {
      if (sendResponse.success) {
        return;
      }

      const code = sendResponse.error?.code ?? null;

      if (INVALID_TOKEN_ERROR_CODES.has(code)) {
        invalidTokenIds.push(tokenChunk[index].id);
      }
    });
  }

  if (invalidTokenIds.length > 0) {
    await prisma.userPushToken.updateMany({
      where: {
        id: {
          in: invalidTokenIds
        }
      },
      data: {
        isActive: false
      }
    });
  }

  logger.info('[Push] result', {
    userId,
    successCount,
    failureCount,
    invalidTokenCount: invalidTokenIds.length
  });

  return {
    sent: true,
    tokenCount: tokens.length,
    successCount,
    failureCount,
    invalidTokenCount: invalidTokenIds.length
  };
}

async function sendTestPushNotification({ userId, title, body, route = 'notification_list' }) {
  if (!isTestPushAllowed()) {
    throw new AppError(403, 'TEST_PUSH_NOT_ALLOWED', 'Test push is not allowed in production');
  }

  const notification = await prisma.userNotification.create({
    data: {
      userId,
      type: 'test_push',
      title,
      message: body,
      payload: {
        route,
        test: true
      }
    }
  });

  return sendToUser(userId, {
    notification: {
      title,
      body
    },
    data: {
      type: 'test_push',
      notificationId: notification.id,
      route
    }
  });
}

module.exports = {
  buildApnsConfig,
  isTestPushAllowed,
  maskPushToken,
  normalizeDataPayload,
  sendTestPushNotification,
  sendToUser,
  truncateText
};
