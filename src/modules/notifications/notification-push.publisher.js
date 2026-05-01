const pushService = require('../push/push.service');
const { logger } = require('../../utils/logger');

function getNotificationPayload(notification) {
  return notification?.payload && typeof notification.payload === 'object'
    ? notification.payload
    : {};
}

function normalizePushType(type) {
  switch (type) {
  case 'friend_request_received':
    return 'friend_request';
  case 'friend_request_accepted':
    return 'friend_accepted';
  case 'COMMENT_REPLY':
    return 'comment_replied';
  case 'COMMENT_REACTION_LIKE':
    return 'comment_liked';
  case 'COMMENT_REACTION_DISLIKE':
    return 'comment_disliked';
  default:
    return type;
  }
}

function inferRoute(notification) {
  const payload = getNotificationPayload(notification);

  if (typeof payload.route === 'string' && payload.route.trim()) {
    return payload.route.trim();
  }

  switch (notification?.type) {
  case 'review_liked':
  case 'COMMENT_REPLY':
  case 'COMMENT_REACTION_LIKE':
  case 'COMMENT_REACTION_DISLIKE':
    return 'review_detail';
  case 'friend_request_received':
    return 'friend_request';
  case 'friend_request_accepted':
    return 'profile';
  case 'friend_activity':
    return payload.deepLink ? 'game_detail' : 'notification_list';
  case 'recommendation_ready':
    return 'library_curator';
  case 'system_notice':
  default:
    return 'notification_list';
  }
}

function buildPushData(notification) {
  const payload = getNotificationPayload(notification);
  const actor = payload.actor && typeof payload.actor === 'object' ? payload.actor : null;
  const gameId = payload.gameId ?? notification.relatedGameId ?? payload.game?.igdbGameId ?? payload.game?.externalGameId ?? null;

  return {
    type: normalizePushType(notification.type),
    notificationId: notification.id,
    route: inferRoute(notification),
    gameId,
    reviewId: payload.reviewId ?? null,
    commentId: payload.commentId ?? null,
    actorId: actor?.id ?? payload.actorUserId ?? null,
    deepLink: payload.deepLink ?? null
  };
}

async function publishNotificationPush(notification) {
  if (!notification?.id || !notification?.userId) {
    return null;
  }

  try {
    return await pushService.sendToUser(notification.userId, {
      notification: {
        title: notification.title,
        body: notification.message
      },
      data: buildPushData(notification)
    });
  } catch (error) {
    logger.warn('[Push] notification publish failed', {
      userId: notification.userId,
      notificationId: notification.id,
      type: notification.type,
      code: error?.code ?? null,
      message: error?.message ?? 'Notification push publish failed'
    });
    return null;
  }
}

module.exports = {
  buildPushData,
  publishNotificationPush
};
