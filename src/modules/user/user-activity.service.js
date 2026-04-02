const { GameSource, UserActivityType } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const moderationService = require('../moderation/moderation.service');
const igdbService = require('../igdb/igdb.service');
const {
  buildGameImageResolverUrl,
  extractUsableIgdbCoverUrl
} = require('../library/library-image.service');
const { mapBasicUserProfile } = require('./user.mapper');
const {
  buildPresenceDto,
  derivePresenceMap,
  updatePresenceFromActivityEvent,
  updatePresenceFromSteamSync
} = require('./user-presence.service');
const {
  FRIEND_ACTIVITY_DEDUPE_WINDOW_MS,
  FRIEND_ACTIVITY_FEED_DEFAULT_LIMIT,
  FRIEND_ACTIVITY_FEED_MAX_LIMIT,
  FRIEND_WIDGET_CACHE_TTL_MS,
  SOCIAL_NOTIFICATION_THROTTLE_MS,
  SOCIAL_NOTIFICATION_TYPE,
  STEAM_ACTIVITY_EVENT_LIMIT,
  STEAM_ACTIVITY_FRESHNESS_WINDOW_MS,
  USER_ACTIVITY_TYPE
} = require('./user-social.constants');

const basicUserSelect = {
  id: true,
  nickname: true,
  profileImageUrl: true
};

const privacySettingsSelect = {
  userId: true,
  showLikedGames: true,
  showRecentlyPlayed: true,
  showReviews: true
};

const activitySummaryCache = new Map();

function uniqueStringValues(values) {
  return [...new Set(
    (values ?? [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  )];
}

function getCachedValue(cache, key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCachedValue(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });

  if (cache.size > 200) {
    const oldestKey = cache.keys().next().value;

    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
}

function mapActivityType(activityType) {
  if (typeof activityType !== 'string') {
    return null;
  }

  return activityType.toLowerCase();
}

function normalizeGameSource(gameSource) {
  if (gameSource === GameSource.STEAM || gameSource === 'STEAM' || gameSource === 'steam') {
    return 'steam';
  }

  if (gameSource === GameSource.IGDB || gameSource === 'IGDB' || gameSource === 'igdb') {
    return 'igdb';
  }

  return null;
}

function mapPrivacySettingsDto(settings) {
  return {
    showLikedGames: settings?.showLikedGames ?? true,
    showRecentlyPlayed: settings?.showRecentlyPlayed ?? true,
    showReviews: settings?.showReviews ?? true
  };
}

function buildStatusLabel(status) {
  switch (String(status ?? '').toUpperCase()) {
  case 'PLAYING':
    return '플레이 중';
  case 'BACKLOG':
    return '백로그';
  case 'COMPLETED':
    return '완료';
  case 'DROPPED':
    return '중단';
  default:
    return '상태';
  }
}

function buildActivityMessage(activityType, metadata = {}) {
  switch (activityType) {
  case UserActivityType.REVIEW_CREATED:
    return '리뷰를 남겼어요';
  case UserActivityType.REVIEW_UPDATED:
    return '리뷰를 수정했어요';
  case UserActivityType.LIKED_GAME_ADDED:
    return '게임을 찜했어요';
  case UserActivityType.LIKED_GAME_REMOVED:
    return '찜 목록에서 게임을 제거했어요';
  case UserActivityType.RATING_CHANGED:
    return metadata.previousRating != null && metadata.nextRating != null
      ? `평점을 ${metadata.previousRating}점에서 ${metadata.nextRating}점으로 바꿨어요`
      : '평점을 변경했어요';
  case UserActivityType.PLAY_STATUS_CHANGED:
    return metadata.nextStatus
      ? `${buildStatusLabel(metadata.nextStatus)} 상태로 바꿨어요`
      : '플레이 상태를 변경했어요';
  case UserActivityType.STEAM_RECENTLY_PLAYED_SYNC:
    return '최근 플레이한 게임이에요';
  default:
    return '최근 활동이 있어요';
  }
}

function buildActivityNotificationCopy({ actorNickname, activityType, targetGameTitle, metadata = {} }) {
  const titleLabel = actorNickname ? `${actorNickname}님의 최근 활동` : '친구의 최근 활동';
  let message = buildActivityMessage(activityType, metadata);

  if (targetGameTitle) {
    message = `${targetGameTitle} · ${message}`;
  }

  return {
    title: titleLabel,
    message
  };
}

function buildGameDeepLink({ gameSource, externalGameId, igdbGameId = null }) {
  const resolvedSource = normalizeGameSource(gameSource);
  const resolvedId = igdbGameId ?? externalGameId;

  if (!resolvedSource || !resolvedId) {
    return null;
  }

  return `gamepedia://games/${resolvedId}?source=${resolvedSource}`;
}

function buildNotificationPayload({ activityEvent, actor, targetGame }) {
  const { title, message } = buildActivityNotificationCopy({
    actorNickname: actor?.nickname ?? null,
    activityType: activityEvent.activityType,
    targetGameTitle: targetGame?.title ?? targetGame?.gameName ?? null,
    metadata: activityEvent.metadata ?? {}
  });
  const deepLink = buildGameDeepLink({
    gameSource: targetGame?.gameSource ?? normalizeGameSource(activityEvent.gameSource),
    externalGameId: targetGame?.externalGameId ?? activityEvent.externalGameId ?? null,
    igdbGameId: targetGame?.igdbGameId ?? activityEvent.igdbGameId ?? null
  });

  return {
    type: SOCIAL_NOTIFICATION_TYPE.FRIEND_ACTIVITY,
    title,
    message,
    relatedGameId: activityEvent.igdbGameId ?? activityEvent.externalGameId ?? null,
    dedupeKey: `social:${activityEvent.actorUserId}:${activityEvent.activityType}:${activityEvent.igdbGameId ?? activityEvent.externalGameId ?? 'unknown'}`,
    payload: {
      deepLink,
      actorUserId: activityEvent.actorUserId,
      activityEventId: activityEvent.id,
      activityType: mapActivityType(activityEvent.activityType),
      banner: {
        title,
        message
      },
      game: targetGame ?? null
    }
  };
}

function shouldExposeActivityByPrivacy(activityType, privacySettings) {
  const privacy = mapPrivacySettingsDto(privacySettings);

  switch (activityType) {
  case UserActivityType.LIKED_GAME_ADDED:
  case UserActivityType.LIKED_GAME_REMOVED:
    return privacy.showLikedGames;
  case UserActivityType.REVIEW_CREATED:
  case UserActivityType.REVIEW_UPDATED:
  case UserActivityType.RATING_CHANGED:
    return privacy.showReviews;
  case UserActivityType.PLAY_STATUS_CHANGED:
  case UserActivityType.STEAM_RECENTLY_PLAYED_SYNC:
    return privacy.showRecentlyPlayed;
  default:
    return true;
  }
}

function shouldDispatchNotificationForActivity(activityEvent) {
  const metadata = activityEvent?.metadata && typeof activityEvent.metadata === 'object'
    ? activityEvent.metadata
    : {};

  switch (activityEvent?.activityType) {
  case UserActivityType.REVIEW_CREATED:
  case UserActivityType.RATING_CHANGED:
  case UserActivityType.LIKED_GAME_ADDED:
  case UserActivityType.STEAM_RECENTLY_PLAYED_SYNC:
    return true;
  case UserActivityType.PLAY_STATUS_CHANGED:
    return String(metadata.nextStatus ?? '').toUpperCase() === 'PLAYING';
  default:
    return false;
  }
}

function buildGamePreviewFromIgdbGame(gameId, igdbGame) {
  const normalizedGameId = typeof gameId === 'string' ? gameId.trim() : String(gameId ?? '').trim();

  return {
    gameSource: 'igdb',
    externalGameId: normalizedGameId,
    title: igdbGame?.name ?? null,
    gameName: igdbGame?.name ?? null,
    coverUrl: igdbGame?.coverUrl ?? null,
    igdbGameId: normalizedGameId || null,
    metadataEnriched: Boolean(igdbGame),
    detailAvailable: Boolean(normalizedGameId)
  };
}

async function buildIgdbGameMap(gameIds) {
  const normalizedIds = uniqueStringValues(gameIds).filter((gameId) => /^\d+$/.test(gameId));

  if (normalizedIds.length === 0) {
    return new Map();
  }

  try {
    const result = await igdbService.getGamesByIds({
      gameIds: normalizedIds
    });

    return new Map(result.games.map((game) => [String(game.id), game]));
  } catch (error) {
    logger.warn('user-activity-igdb-hydration-skipped', {
      gameCount: normalizedIds.length,
      code: error?.code ?? null,
      message: error?.message ?? 'Activity IGDB hydration failed'
    });

    return new Map();
  }
}

async function buildActivityHydrationContext(activityEvents) {
  const normalizedEvents = Array.isArray(activityEvents) ? activityEvents : [];
  const igdbIds = uniqueStringValues(normalizedEvents.flatMap((event) => {
    const eventGameSource = normalizeGameSource(event.gameSource);

    if (event.igdbGameId) {
      return [event.igdbGameId];
    }

    if (eventGameSource === 'igdb' && event.externalGameId) {
      return [event.externalGameId];
    }

    return [];
  }));
  const steamAppIds = uniqueStringValues(normalizedEvents
    .filter((event) => normalizeGameSource(event.gameSource) === 'steam' && event.externalGameId)
    .map((event) => event.externalGameId));
  const actorIds = uniqueStringValues(normalizedEvents.map((event) => event.actorUserId));
  const [igdbGameMap, steamMappings, steamEntries] = await Promise.all([
    buildIgdbGameMap(igdbIds),
    steamAppIds.length > 0
      ? prisma.steamIgdbMapping.findMany({
        where: {
          steamAppId: {
            in: steamAppIds
          },
          matchStatus: 'CONFIRMED'
        }
      })
      : [],
    steamAppIds.length > 0 && actorIds.length > 0
      ? prisma.userGameLibrary.findMany({
        where: {
          userId: {
            in: actorIds
          },
          gameSource: GameSource.STEAM,
          externalGameId: {
            in: steamAppIds
          }
        },
        orderBy: [{ updatedAt: 'desc' }],
        select: {
          userId: true,
          externalGameId: true,
          gameName: true,
          coverUrl: true
        }
      })
      : []
  ]);
  const steamMappingMap = new Map(steamMappings.map((mapping) => [mapping.steamAppId, mapping]));
  const steamIgdbIds = uniqueStringValues(steamMappings.map((mapping) => mapping.igdbGameId).filter(Boolean));
  const steamIgdbGameMap = await buildIgdbGameMap(steamIgdbIds);
  const steamEntryMap = new Map();

  for (const entry of steamEntries) {
    const pairKey = `${entry.userId}:${entry.externalGameId}`;

    if (!steamEntryMap.has(pairKey)) {
      steamEntryMap.set(pairKey, entry);
    }
  }

  return {
    igdbGameMap: new Map([
      ...igdbGameMap.entries(),
      ...steamIgdbGameMap.entries()
    ]),
    steamMappingMap,
    steamEntryMap
  };
}

function buildGamePreviewFromActivityEvent(activityEvent, hydrationContext) {
  const metadata = activityEvent.metadata && typeof activityEvent.metadata === 'object'
    ? activityEvent.metadata
    : {};
  const eventGameSource = normalizeGameSource(activityEvent.gameSource);
  const snapshotTitle = typeof metadata.gameName === 'string' && metadata.gameName.trim()
    ? metadata.gameName.trim()
    : null;
  const snapshotCoverUrl = typeof metadata.coverUrl === 'string' && metadata.coverUrl.trim()
    ? metadata.coverUrl.trim()
    : null;

  if (activityEvent.igdbGameId || eventGameSource === 'igdb') {
    const resolvedGameId = activityEvent.igdbGameId ?? activityEvent.externalGameId;
    const igdbGame = resolvedGameId
      ? hydrationContext.igdbGameMap.get(String(resolvedGameId)) ?? null
      : null;
    const preview = buildGamePreviewFromIgdbGame(resolvedGameId, igdbGame);

    if (!preview.title && snapshotTitle) {
      preview.title = snapshotTitle;
      preview.gameName = snapshotTitle;
    }

    if (!preview.coverUrl && snapshotCoverUrl) {
      preview.coverUrl = snapshotCoverUrl;
    }

    return preview;
  }

  if (eventGameSource === 'steam' && activityEvent.externalGameId) {
    const mapping = hydrationContext.steamMappingMap.get(activityEvent.externalGameId) ?? null;
    const igdbGame = mapping?.igdbGameId
      ? hydrationContext.igdbGameMap.get(String(mapping.igdbGameId)) ?? null
      : null;
    const libraryEntry = hydrationContext.steamEntryMap.get(`${activityEvent.actorUserId}:${activityEvent.externalGameId}`) ?? null;
    const coverUrl = buildGameImageResolverUrl({
      gameSource: 'steam',
      externalGameId: activityEvent.externalGameId,
      igdbCoverUrl: extractUsableIgdbCoverUrl(igdbGame?.coverUrl ?? snapshotCoverUrl ?? libraryEntry?.coverUrl)
    });

    return {
      gameSource: 'steam',
      externalGameId: activityEvent.externalGameId,
      title: snapshotTitle ?? libraryEntry?.gameName ?? igdbGame?.name ?? null,
      gameName: snapshotTitle ?? libraryEntry?.gameName ?? igdbGame?.name ?? null,
      coverUrl,
      igdbGameId: mapping?.igdbGameId ?? null,
      metadataEnriched: Boolean(mapping?.igdbGameId),
      detailAvailable: true
    };
  }

  return null;
}

async function getVisibleFriendIds(currentUserId) {
  const [friendships, hiddenUserIds] = await Promise.all([
    prisma.friendship.findMany({
      where: {
        userId: currentUserId
      },
      select: {
        friendUserId: true
      }
    }),
    moderationService.getHiddenUserIds(currentUserId)
  ]);
  const hiddenSet = new Set(hiddenUserIds);

  return friendships
    .map((friendship) => friendship.friendUserId)
    .filter((friendUserId) => !hiddenSet.has(friendUserId));
}

async function getPrivacySettingsMap(userIds) {
  const normalizedUserIds = uniqueStringValues(userIds);

  if (normalizedUserIds.length === 0) {
    return new Map();
  }

  const settings = await prisma.userPrivacySettings.findMany({
    where: {
      userId: {
        in: normalizedUserIds
      }
    },
    select: privacySettingsSelect
  });

  return new Map(settings.map((item) => [item.userId, item]));
}

async function dispatchActivityNotifications({ activityEvent, actor = null }) {
  if (!shouldDispatchNotificationForActivity(activityEvent)) {
    logger.info('social-notification-generated', {
      activityEventId: activityEvent.id,
      actorUserId: activityEvent.actorUserId,
      recipientCount: 0,
      reason: 'suppressed_low_signal_activity'
    });
    return;
  }

  const friendIds = await getVisibleFriendIds(activityEvent.actorUserId);

  if (friendIds.length === 0) {
    logger.info('social-notification-generated', {
      activityEventId: activityEvent.id,
      actorUserId: activityEvent.actorUserId,
      recipientCount: 0,
      reason: 'no_friends'
    });
    return;
  }

  const [privacySettingsMap, hydrationContext, actorUser] = await Promise.all([
    getPrivacySettingsMap([activityEvent.actorUserId]),
    buildActivityHydrationContext([activityEvent]),
    actor
      ? Promise.resolve(actor)
      : prisma.user.findUnique({
        where: { id: activityEvent.actorUserId },
        select: basicUserSelect
      })
  ]);

  if (!shouldExposeActivityByPrivacy(activityEvent.activityType, privacySettingsMap.get(activityEvent.actorUserId))) {
    logger.info('social-notification-generated', {
      activityEventId: activityEvent.id,
      actorUserId: activityEvent.actorUserId,
      recipientCount: 0,
      reason: 'hidden_by_privacy'
    });
    return;
  }

  const targetGame = buildGamePreviewFromActivityEvent(activityEvent, hydrationContext);
  const notification = buildNotificationPayload({
    activityEvent,
    actor: actorUser,
    targetGame
  });
  const throttleWindowStart = new Date(Date.now() - SOCIAL_NOTIFICATION_THROTTLE_MS);
  let dispatchedCount = 0;

  for (const recipientUserId of friendIds) {
    const existingNotification = await prisma.userNotification.findFirst({
      where: {
        userId: recipientUserId,
        dedupeKey: notification.dedupeKey,
        createdAt: {
          gte: throttleWindowStart
        }
      },
      select: { id: true }
    });

    if (existingNotification) {
      continue;
    }

    await prisma.userNotification.create({
      data: {
        userId: recipientUserId,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        relatedGameId: notification.relatedGameId,
        dedupeKey: notification.dedupeKey,
        payload: notification.payload
      }
    });
    dispatchedCount += 1;
  }

  logger.info('social-notification-generated', {
    activityEventId: activityEvent.id,
    actorUserId: activityEvent.actorUserId,
    recipientCount: dispatchedCount,
    activityType: mapActivityType(activityEvent.activityType)
  });
}

async function createActivityEvent({
  actorUserId,
  activityType,
  gameSource = null,
  externalGameId = null,
  igdbGameId = null,
  metadata = null,
  dedupeKey = null,
  dedupeWindowMs = FRIEND_ACTIVITY_DEDUPE_WINDOW_MS,
  notifyFriends = true
}) {
  const resolvedMetadata = metadata && typeof metadata === 'object' ? metadata : null;

  if (!actorUserId || !activityType) {
    return null;
  }

  if (dedupeKey) {
    const existingActivity = await prisma.userActivityEvent.findFirst({
      where: {
        actorUserId,
        dedupeKey,
        createdAt: {
          gte: new Date(Date.now() - dedupeWindowMs)
        }
      },
      orderBy: [{ createdAt: 'desc' }]
    });

    if (existingActivity) {
      logger.info('activity-skipped', {
        actorUserId,
        activityType: mapActivityType(activityType),
        dedupeKey,
        reason: 'duplicate_within_window'
      });
      return existingActivity;
    }
  }

  const activityEvent = await prisma.userActivityEvent.create({
    data: {
      actorUserId,
      activityType,
      gameSource,
      externalGameId,
      igdbGameId,
      dedupeKey,
      metadata: resolvedMetadata
    }
  });

  logger.info('activity-created', {
    actorUserId,
    activityEventId: activityEvent.id,
    activityType: mapActivityType(activityType),
    gameSource: normalizeGameSource(gameSource),
    externalGameId: externalGameId ?? null,
    igdbGameId: igdbGameId ?? null
  });

  await updatePresenceFromActivityEvent(activityEvent);

  if (notifyFriends) {
    try {
      await dispatchActivityNotifications({ activityEvent });
    } catch (error) {
      logger.warn('social-notification-failed', {
        activityEventId: activityEvent.id,
        actorUserId,
        code: error?.code ?? null,
        message: error?.message ?? 'Social notification generation failed'
      });
    }
  }

  return activityEvent;
}

async function recordReviewCreatedActivity({ userId, review }) {
  return createActivityEvent({
    actorUserId: userId,
    activityType: USER_ACTIVITY_TYPE.REVIEW_CREATED,
    gameSource: GameSource.IGDB,
    externalGameId: review.gameId,
    igdbGameId: review.gameId,
    metadata: {
      rating: Number(review.rating),
      contentLength: typeof review.content === 'string' ? review.content.trim().length : 0
    },
    dedupeKey: `review-created:${userId}:${review.id}`
  });
}

async function recordReviewUpdatedActivity({
  userId,
  review,
  previousRating = null,
  previousContent = null
}) {
  const nextRating = Number(review.rating);
  const trimmedPreviousContent = typeof previousContent === 'string' ? previousContent.trim() : '';
  const trimmedNextContent = typeof review.content === 'string' ? review.content.trim() : '';
  const ratingChanged = previousRating != null && Number(previousRating) !== nextRating;
  const contentChanged = trimmedPreviousContent !== trimmedNextContent;

  if (!ratingChanged && !contentChanged) {
    logger.info('activity-skipped', {
      actorUserId: userId,
      activityType: 'review_update',
      reason: 'no_effective_change'
    });
    return null;
  }

  const activityType = ratingChanged ? USER_ACTIVITY_TYPE.RATING_CHANGED : USER_ACTIVITY_TYPE.REVIEW_UPDATED;

  return createActivityEvent({
    actorUserId: userId,
    activityType,
    gameSource: GameSource.IGDB,
    externalGameId: review.gameId,
    igdbGameId: review.gameId,
    metadata: ratingChanged
      ? {
        previousRating: previousRating != null ? Number(previousRating) : null,
        nextRating
      }
      : {
        contentLength: trimmedNextContent.length
      },
    dedupeKey: ratingChanged
      ? `rating-changed:${userId}:${review.id}:${nextRating}`
      : `review-updated:${userId}:${review.id}:${review.updatedAt ? new Date(review.updatedAt).toISOString() : 'unknown'}`
  });
}

async function recordFavoriteAddedActivity({ userId, gameId }) {
  return createActivityEvent({
    actorUserId: userId,
    activityType: USER_ACTIVITY_TYPE.LIKED_GAME_ADDED,
    gameSource: GameSource.IGDB,
    externalGameId: gameId,
    igdbGameId: gameId,
    dedupeKey: `liked-added:${userId}:${gameId}`
  });
}

async function recordFavoriteRemovedActivity({ userId, gameId }) {
  return createActivityEvent({
    actorUserId: userId,
    activityType: USER_ACTIVITY_TYPE.LIKED_GAME_REMOVED,
    gameSource: GameSource.IGDB,
    externalGameId: gameId,
    igdbGameId: gameId,
    dedupeKey: `liked-removed:${userId}:${gameId}`
  });
}

async function recordPlayStatusChangedActivity({ userId, previousEntry = null, libraryEntry }) {
  const previousStatus = typeof previousEntry?.status === 'string'
    ? previousEntry.status.trim().toUpperCase()
    : null;
  const nextStatus = typeof libraryEntry?.status === 'string'
    ? libraryEntry.status.trim().toUpperCase()
    : null;

  if (!libraryEntry || previousStatus === nextStatus) {
    logger.info('activity-skipped', {
      actorUserId: userId,
      activityType: 'play_status_changed',
      reason: 'no_effective_change'
    });
    return null;
  }

  return createActivityEvent({
    actorUserId: userId,
    activityType: USER_ACTIVITY_TYPE.PLAY_STATUS_CHANGED,
    gameSource: libraryEntry.gameSource,
    externalGameId: libraryEntry.externalGameId,
    metadata: {
      previousStatus,
      nextStatus,
      gameName: libraryEntry.gameName ?? null,
      coverUrl: libraryEntry.coverUrl ?? null,
      lastPlayedAt: libraryEntry.lastPlayedAt ? new Date(libraryEntry.lastPlayedAt).toISOString() : null
    },
    dedupeKey: `play-status:${userId}:${libraryEntry.gameSource}:${libraryEntry.externalGameId}:${nextStatus}`
  });
}

async function recordSteamRecentlyPlayedSyncActivities({
  userId,
  games = [],
  syncedAt = new Date()
}) {
  const normalizedGames = Array.isArray(games) ? games : [];
  const freshGames = normalizedGames
    .filter((game) => typeof game?.externalGameId === 'string' && game.externalGameId.trim())
    .slice(0, STEAM_ACTIVITY_EVENT_LIMIT);
  const synchronizedAt = syncedAt instanceof Date ? syncedAt : new Date(syncedAt);

  if (freshGames.length === 0) {
    await updatePresenceFromSteamSync({
      userId,
      recentGames: [],
      syncedAt: synchronizedAt
    });
    logger.info('steam-supplementation-decision', {
      userId,
      activityCount: 0,
      reason: 'no_recent_games'
    });
    return [];
  }

  const activityEvents = [];

  for (const game of freshGames) {
    const activityEvent = await createActivityEvent({
      actorUserId: userId,
      activityType: USER_ACTIVITY_TYPE.STEAM_RECENTLY_PLAYED_SYNC,
      gameSource: GameSource.STEAM,
      externalGameId: game.externalGameId,
      metadata: {
        gameName: game.gameName ?? game.title ?? null,
        coverUrl: game.coverUrl ?? null,
        playtimeMinutes: Number.isInteger(game.playtimeMinutes) ? game.playtimeMinutes : null,
        recentPlaytimeMinutes: Number.isInteger(game.recentPlaytimeMinutes) ? game.recentPlaytimeMinutes : null,
        syncedAt: synchronizedAt.toISOString()
      },
      dedupeKey: `steam-sync:${userId}:${game.externalGameId}:${Math.floor(synchronizedAt.getTime() / STEAM_ACTIVITY_FRESHNESS_WINDOW_MS)}`,
      dedupeWindowMs: STEAM_ACTIVITY_FRESHNESS_WINDOW_MS
    });

    if (activityEvent) {
      activityEvents.push(activityEvent);
    }
  }

  await updatePresenceFromSteamSync({
    userId,
    recentGames: freshGames,
    syncedAt: synchronizedAt
  });

  logger.info('steam-supplementation-decision', {
    userId,
    activityCount: activityEvents.length,
    reason: 'steam_recently_played_sync_recorded'
  });

  return activityEvents;
}

async function getFriendActivityFeed({ currentUserId, cursor = null, limit = FRIEND_ACTIVITY_FEED_DEFAULT_LIMIT }) {
  const resolvedLimit = Math.min(
    Math.max(Number.isInteger(limit) ? limit : Number.parseInt(String(limit ?? ''), 10) || FRIEND_ACTIVITY_FEED_DEFAULT_LIMIT, 1),
    FRIEND_ACTIVITY_FEED_MAX_LIMIT
  );
  const friendIds = await getVisibleFriendIds(currentUserId);

  if (friendIds.length === 0) {
    logger.info('friend-activity-feed-query', {
      userId: currentUserId,
      friendCount: 0,
      resultCount: 0
    });

    return {
      activities: [],
      nextCursor: null
    };
  }

  const queryArgs = {
    where: {
      actorUserId: {
        in: friendIds
      },
      isVisible: true
    },
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ],
    take: resolvedLimit + 1,
    include: {
      actor: {
        select: basicUserSelect
      }
    }
  };

  if (cursor) {
    queryArgs.cursor = { id: cursor };
    queryArgs.skip = 1;
  }

  const [events, privacySettingsMap] = await Promise.all([
    prisma.userActivityEvent.findMany(queryArgs),
    getPrivacySettingsMap(friendIds)
  ]);
  const visibleEvents = events.filter((event) => shouldExposeActivityByPrivacy(event.activityType, privacySettingsMap.get(event.actorUserId)));
  const hasMore = visibleEvents.length > resolvedLimit;
  const pageEvents = visibleEvents.slice(0, resolvedLimit);
  const [hydrationContext, presenceMap] = await Promise.all([
    buildActivityHydrationContext(pageEvents),
    derivePresenceMap(uniqueStringValues(pageEvents.map((event) => event.actorUserId)))
  ]);
  const activities = pageEvents.map((event) => {
    const targetGame = buildGamePreviewFromActivityEvent(event, hydrationContext);
    const metadata = event.metadata && typeof event.metadata === 'object'
      ? event.metadata
      : null;

    return {
      id: event.id,
      actor: mapBasicUserProfile(event.actor),
      activityType: mapActivityType(event.activityType),
      targetGame,
      relatedGame: targetGame,
      message: buildActivityMessage(event.activityType, metadata ?? {}),
      metadata,
      createdAt: event.createdAt,
      timestamp: event.createdAt,
      presence: presenceMap.get(event.actorUserId) ?? buildPresenceDto()
    };
  });

  logger.info('friend-activity-feed-query', {
    userId: currentUserId,
    friendCount: friendIds.length,
    resultCount: activities.length,
    hasMore
  });

  return {
    activities,
    nextCursor: hasMore ? activities[activities.length - 1]?.id ?? null : null
  };
}

async function getFriendActivitySummary({ currentUserId }) {
  const cacheKey = `activity-summary:${currentUserId}`;
  const cachedValue = getCachedValue(activitySummaryCache, cacheKey);

  if (cachedValue) {
    return cachedValue;
  }

  const friendIds = await getVisibleFriendIds(currentUserId);

  if (friendIds.length === 0) {
    const emptyResult = {
      generatedAt: new Date().toISOString(),
      totalRecentActivities: 0,
      activeFriendCount: 0,
      presenceCounts: {
        online: 0,
        recentlyActive: 0,
        playing: 0,
        lastPlayed: 0,
        unknown: 0
      },
      activities: []
    };

    setCachedValue(activitySummaryCache, cacheKey, emptyResult, FRIEND_WIDGET_CACHE_TTL_MS);
    return emptyResult;
  }

  const [feed, recentEvents, privacySettingsMap, presenceMap] = await Promise.all([
    getFriendActivityFeed({
      currentUserId,
      limit: 5
    }),
    prisma.userActivityEvent.findMany({
      where: {
        actorUserId: {
          in: friendIds
        },
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
        }
      },
      select: {
        actorUserId: true,
        activityType: true
      }
    }),
    getPrivacySettingsMap(friendIds),
    derivePresenceMap(friendIds)
  ]);
  const presenceCounts = {
    online: 0,
    recentlyActive: 0,
    playing: 0,
    lastPlayed: 0,
    unknown: 0
  };

  for (const presence of presenceMap.values()) {
    const stateKey = typeof presence?.state === 'string' ? presence.state : 'unknown';
    presenceCounts[stateKey] = (presenceCounts[stateKey] ?? 0) + 1;
  }

  const visibleRecentCount = recentEvents.filter((event) => shouldExposeActivityByPrivacy(
    event.activityType,
    privacySettingsMap.get(event.actorUserId)
  )).length;

  const result = {
    generatedAt: new Date().toISOString(),
    totalRecentActivities: visibleRecentCount,
    activeFriendCount: friendIds.length,
    presenceCounts,
    activities: feed.activities
  };

  setCachedValue(activitySummaryCache, cacheKey, result, FRIEND_WIDGET_CACHE_TTL_MS);
  return result;
}

module.exports = {
  buildActivityMessage,
  buildNotificationPayload,
  createActivityEvent,
  getFriendActivityFeed,
  getFriendActivitySummary,
  recordFavoriteAddedActivity,
  recordFavoriteRemovedActivity,
  recordPlayStatusChangedActivity,
  recordReviewCreatedActivity,
  recordReviewUpdatedActivity,
  recordSteamRecentlyPlayedSyncActivities
};
