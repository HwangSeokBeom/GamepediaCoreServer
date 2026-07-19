const { FriendRequestStatus, GameSource, UserActivityType, UserStatus } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const { buildAccountStatusError } = require('../../utils/auth-error');
const { AppError } = require('../../utils/error-response');
const moderationService = require('../moderation/moderation.service');
const igdbService = require('../igdb/igdb.service');
const libraryService = require('../library/library.service');
const { buildGameImageResolverUrl, extractUsableIgdbCoverUrl } = require('../library/library-image.service');
const steamService = require('../../services/steam.service');
const { DELETE_STATUS, deleteOwnedProfileImage, buildStoredProfileImagePath } = require('./profile-image.storage');
const userActivityService = require('./user-activity.service');
const userPresenceService = require('./user-presence.service');
const { publishNotificationPush } = require('../notifications/notification-push.publisher');
const {
  RECOMMENDATION_WIDGET_CACHE_TTL_MS
} = require('./user-social.constants');
const {
  mapBasicUserProfile,
  mapFriendRequestDto,
  mapFriendshipDto,
  mapNotificationToDto,
  mapUserSearchResult,
  mapUserToDto,
  normalizeProfileImageUrl
} = require('./user.mapper');

const NOTIFICATIONS_DEFAULT_LIMIT = 20;
const NOTIFICATIONS_MAX_LIMIT = 50;
const FRIEND_SEARCH_LIMIT = 20;
const FRIEND_LIBRARY_PREVIEW_LIMIT = 3;
const FRIEND_REVIEW_PREVIEW_LIMIT = 3;
const FRIEND_ACTIVITY_LIMIT = 20;
const FRIEND_COMMON_INTEREST_LIMIT = 4;
const HIGH_RATED_REVIEW_THRESHOLD = 4;
const SOCIAL_ACTIVITY_NOTIFICATION_LIMIT = 5;
const SHARED_GAMES_LIMIT = 12;
const FRIEND_RECOMMENDATION_LIMIT = 12;
const FRIEND_PROFILE_PREVIEW_LIMIT = 4;
const TASTE_PROFILE_TOP_LABEL_LIMIT = 4;
const STEAM_TAG_FETCH_LIMIT = 16;
const PROFILE_RECENTLY_PLAYED_LIMIT = 5;
const STEAM_MULTIPLAYER_TAG_KEYS = ['multiplayer', 'online pvp', 'local multiplayer', 'massively multiplayer', 'player versus player'];
const STEAM_COOP_TAG_KEYS = ['co-op', 'coop', 'online co-op', 'local co-op', 'shared/split screen co-op'];
const recommendationWidgetCache = new Map();
const USER_TITLE_CATALOG = [
  { key: 'pro_reviewer', label: 'Pro Reviewer' },
  { key: 'early_adopter', label: 'Early Adopter' },
  { key: 'hardcore_gamer', label: 'Hardcore Gamer' },
  { key: 'collector', label: 'Collector' },
  { key: 'rpg_lover', label: 'RPG Lover' },
  { key: 'soulslike_lover', label: 'Soulslike Lover' },
  { key: 'social_player', label: 'Social Player' }
];
const USER_TITLE_KEY_SET = new Set(USER_TITLE_CATALOG.map((title) => title.key));

const defaultPrivacySettings = {
  showFriendsList: true,
  showRecentlyPlayed: true,
  showLikedGames: true,
  showReviews: true
};

function normalizePositiveInteger(value, fallbackValue) {
  const numericValue = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    return fallbackValue;
  }

  return numericValue;
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

  if (cache.size > 100) {
    const oldestKey = cache.keys().next().value;

    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
}

const basicUserSelect = {
  id: true,
  nickname: true,
  profileImageUrl: true,
  status: true
};

const privacySettingsSelect = {
  userId: true,
  showFriendsList: true,
  showRecentlyPlayed: true,
  showLikedGames: true,
  showReviews: true,
  createdAt: true,
  updatedAt: true
};

const steamAccountSelect = {
  id: true,
  userId: true,
  providerSubject: true,
  personaName: true,
  profileUrl: true,
  avatarUrl: true,
  lastSteamSyncAt: true,
  steamRecentPlayedSnapshot: true
};

async function getActiveTargetUser(targetUserId) {
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: basicUserSelect
  });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User could not be found');
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User could not be found');
  }

  return user;
}

async function ensureNotHiddenRelationship(userId, targetUserId) {
  const hiddenUserIds = await moderationService.getHiddenUserIds(userId);

  if (hiddenUserIds.includes(targetUserId)) {
    throw new AppError(403, 'FRIEND_ACTION_FORBIDDEN', 'This user is not available for friend actions');
  }
}

function mapPrivacySettingsDto(settings) {
  return {
    showFriendsList: settings?.showFriendsList ?? true,
    showRecentlyPlayed: settings?.showRecentlyPlayed ?? true,
    showLikedGames: settings?.showLikedGames ?? true,
    showReviews: settings?.showReviews ?? true
  };
}

function buildPrivacySettingsResponse(settings) {
  const privacy = mapPrivacySettingsDto(settings);

  return {
    privacy,
    ...privacy
  };
}

async function getOrCreatePrivacySettings(userId, { withMeta = false } = {}) {
  const existingSettings = await prisma.userPrivacySettings.findUnique({
    where: {
      userId
    },
    select: privacySettingsSelect
  });

  if (existingSettings) {
    return withMeta
      ? {
        settings: existingSettings,
        created: false,
        source: 'persisted'
      }
      : existingSettings;
  }

  try {
    const createdSettings = await prisma.userPrivacySettings.create({
      data: {
        userId,
        ...defaultPrivacySettings
      },
      select: privacySettingsSelect
    });

    logger.info('user-privacy-default-created', {
      userId
    });

    return withMeta
      ? {
        settings: createdSettings,
        created: true,
        source: 'created_default'
      }
      : createdSettings;
  } catch (error) {
    if (error?.code === 'P2002') {
      const concurrentSettings = await prisma.userPrivacySettings.findUnique({
        where: {
          userId
        },
        select: privacySettingsSelect
      });

      if (concurrentSettings) {
        return withMeta
          ? {
            settings: concurrentSettings,
            created: false,
            source: 'persisted_after_race'
          }
          : concurrentSettings;
      }
    }

    throw error;
  }
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

async function createNotification({
  userId,
  type,
  title,
  message,
  relatedGameId = null,
  payload = null,
  dedupeKey = null
}) {
  try {
    const notification = await prisma.userNotification.create({
      data: {
        userId,
        type,
        title,
        message,
        relatedGameId,
        payload,
        dedupeKey
      }
    });

    await publishNotificationPush(notification);
    return notification;
  } catch (error) {
    logger.warn('notification-create-failed', {
      userId,
      type,
      code: error?.code ?? null,
      message: error?.message ?? 'Notification create failed'
    });
    return null;
  }
}

async function getFriendship(userId, friendUserId) {
  return prisma.friendship.findUnique({
    where: {
      userId_friendUserId: {
        userId,
        friendUserId
      }
    }
  });
}

async function assertFriendAccess({ currentUserId, targetUserId }) {
  const targetUser = await getActiveTargetUser(targetUserId);

  if (currentUserId === targetUserId) {
    return {
      targetUser,
      friendship: null,
      isSelf: true
    };
  }

  await ensureNotHiddenRelationship(currentUserId, targetUserId);

  const friendship = await getFriendship(currentUserId, targetUserId);

  if (!friendship) {
    throw new AppError(403, 'FRIEND_PROFILE_FORBIDDEN', 'Friend profile preview is available only to accepted friends');
  }

  return {
    targetUser,
    friendship,
    isSelf: false
  };
}

async function assertFriendSectionAccess({
  currentUserId,
  targetUserId,
  settingKey,
  errorCode,
  errorMessage
}) {
  const accessContext = await assertFriendAccess({
    currentUserId,
    targetUserId
  });

  if (accessContext.isSelf) {
    return {
      ...accessContext,
      privacySettings: await getOrCreatePrivacySettings(targetUserId)
    };
  }

  const privacySettings = await getOrCreatePrivacySettings(targetUserId);

  if (!privacySettings?.[settingKey]) {
    throw new AppError(403, errorCode, errorMessage);
  }

  return {
    ...accessContext,
    privacySettings
  };
}

async function buildFriendPreviewPayload(targetUserId) {
  const [recentlyPlayedResult, likedResult, reviewedResult] = await Promise.all([
    libraryService.getMyRecentlyPlayedLibrary({
      userId: targetUserId,
      page: 1,
      limit: FRIEND_LIBRARY_PREVIEW_LIMIT
    }).catch(() => ({ recentlyPlayed: [] })),
    libraryService.getMyLikedLibrary({
      userId: targetUserId,
      page: 1,
      limit: FRIEND_LIBRARY_PREVIEW_LIMIT
    }).catch(() => ({ liked: [] })),
    libraryService.getMyReviewedLibrary({
      userId: targetUserId,
      page: 1,
      limit: FRIEND_REVIEW_PREVIEW_LIMIT
    }).catch(() => ({ reviews: [] }))
  ]);

  return {
    recentlyPlayed: Array.isArray(recentlyPlayedResult.recentlyPlayed) ? recentlyPlayedResult.recentlyPlayed : [],
    liked: Array.isArray(likedResult.liked) ? likedResult.liked : [],
    reviews: Array.isArray(reviewedResult.reviews) ? reviewedResult.reviews : []
  };
}

async function buildFriendWrittenReviewsPreview(targetUserId, limit = FRIEND_REVIEW_PREVIEW_LIMIT) {
  const reviews = await prisma.review.findMany({
    where: {
      userId: targetUserId
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit
  });
  const igdbGameMap = await buildIgdbGameMap(reviews.map((review) => review.gameId));

  return reviews.map((review) => ({
    id: review.id,
    gameId: review.gameId,
    gameTitle: igdbGameMap.get(review.gameId)?.name ?? review.gameId,
    rating: Number(review.rating),
    content: review.content,
    createdAt: review.createdAt.toISOString()
  }));
}

function uniqueStringValues(values) {
  return [...new Set(
    (values ?? [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  )];
}

function clampNormalizedScore(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function roundNormalizedScore(value) {
  return Number(clampNormalizedScore(value).toFixed(2));
}

function buildCanonicalGameKey({ gameSource, externalGameId, igdbGameId }) {
  if (igdbGameId) {
    return `igdb:${String(igdbGameId)}`;
  }

  if (String(gameSource).toUpperCase() === 'IGDB' && externalGameId) {
    return `igdb:${String(externalGameId)}`;
  }

  if (externalGameId) {
    return `steam:${String(externalGameId)}`;
  }

  return null;
}

function buildCanonicalGameKeyFromLibraryEntry(entry, steamMappingContext) {
  if (!entry) {
    return null;
  }

  if (entry.gameSource === 'IGDB') {
    return buildCanonicalGameKey({
      gameSource: 'IGDB',
      externalGameId: entry.externalGameId
    });
  }

  const mapping = steamMappingContext?.mappingMap?.get(entry.externalGameId) ?? null;

  return buildCanonicalGameKey({
    gameSource: 'STEAM',
    externalGameId: entry.externalGameId,
    igdbGameId: mapping?.igdbGameId ?? null
  });
}

function buildCanonicalGameKeyFromPreviewItem(item) {
  if (!item) {
    return null;
  }

  return buildCanonicalGameKey({
    gameSource: item.gameSource ?? item.source,
    externalGameId: item.externalGameId,
    igdbGameId: item.igdbGameId ?? null
  });
}

function buildTopWeightedLabels(weightMap, limit = TASTE_PROFILE_TOP_LABEL_LIMIT) {
  if (!(weightMap instanceof Map) || weightMap.size === 0) {
    return [];
  }

  return [...weightMap.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([label]) => label);
}

function buildCommonWeightedLabels(leftMap, rightMap, limit = TASTE_PROFILE_TOP_LABEL_LIMIT) {
  if (!(leftMap instanceof Map) || !(rightMap instanceof Map)) {
    return [];
  }

  const keys = new Set([...leftMap.keys(), ...rightMap.keys()]);

  return [...keys]
    .map((key) => ({
      label: key,
      score: Math.min(leftMap.get(key) ?? 0, rightMap.get(key) ?? 0)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.label);
}

function buildStringWeightMap(values) {
  const weightMap = new Map();

  for (const value of values ?? []) {
    const normalizedValue = typeof value === 'string' ? value.trim() : '';

    if (!normalizedValue) {
      continue;
    }

    weightMap.set(normalizedValue, (weightMap.get(normalizedValue) ?? 0) + 1);
  }

  return weightMap;
}

function buildSharedCount(leftValues, rightValues) {
  const leftSet = new Set(leftValues ?? []);
  const rightSet = new Set(rightValues ?? []);
  let count = 0;

  for (const value of leftSet) {
    if (rightSet.has(value)) {
      count += 1;
    }
  }

  return count;
}

function hasSteamSocialPlayTag(steamTags, allowedTagKeys) {
  const normalizedAllowedKeys = new Set((allowedTagKeys ?? []).map((tag) => String(tag).trim().toLowerCase()));

  return (steamTags ?? []).some((tag) => normalizedAllowedKeys.has(String(tag).trim().toLowerCase()));
}

async function getSteamTagMap(appIds, { userId = null, context = null, limit = STEAM_TAG_FETCH_LIMIT } = {}) {
  const normalizedAppIds = uniqueStringValues(appIds).slice(0, limit);

  if (normalizedAppIds.length === 0) {
    return new Map();
  }

  const tagResults = await Promise.allSettled(
    normalizedAppIds.map(async (appId) => {
      const result = await steamService.fetchSteamStoreGenres({ appId });
      return [appId, result.tags ?? []];
    })
  );
  const tagMap = new Map();

  for (const result of tagResults) {
    if (result.status !== 'fulfilled') {
      logger.warn('steam-tag-fetch-skipped', {
        userId,
        context,
        code: result.reason?.code ?? null,
        message: result.reason?.message ?? 'Steam tag fetch failed'
      });
      continue;
    }

    const [appId, tags] = result.value;
    tagMap.set(appId, uniqueStringValues(tags));
  }

  return tagMap;
}

async function getSteamSocialAccount(userId) {
  return prisma.socialAccount.findFirst({
    where: {
      userId,
      provider: steamService.STEAM_AUTH_PROVIDER
    },
    select: steamAccountSelect
  });
}

function normalizeSteamRecentPlayedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return [];
  }

  const games = Array.isArray(snapshot.games) ? snapshot.games : [];

  return games
    .map((game) => {
      const externalGameId = typeof game?.externalGameId === 'string'
        ? game.externalGameId.trim()
        : '';

      if (!externalGameId) {
        return null;
      }

      return {
        externalGameId,
        title: typeof game?.title === 'string' && game.title.trim() ? game.title.trim() : null,
        playtimeMinutes: Number.isInteger(game?.playtimeMinutes) ? game.playtimeMinutes : null,
        lastPlayedAt: typeof game?.lastPlayedAt === 'string' && game.lastPlayedAt.trim() ? game.lastPlayedAt.trim() : null,
        hasReliableLastPlayedAt: game?.hasReliableLastPlayedAt === true,
        snapshotRank: Number.isInteger(game?.snapshotRank) ? game.snapshotRank : Number.MAX_SAFE_INTEGER
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.snapshotRank - right.snapshotRank);
}

function resolveProfileRecentPlayTimestamp({
  libraryLastPlayedAt = null,
  snapshotLastPlayedAt = null,
  snapshotHasReliableLastPlayedAt = false
}) {
  if (libraryLastPlayedAt) {
    return {
      lastPlayedAt: new Date(libraryLastPlayedAt).toISOString(),
      lastPlayedAtSource: 'library_last_played_at',
      hasReliableLastPlayedAt: true,
      fallbackReason: null
    };
  }

  if (snapshotHasReliableLastPlayedAt && snapshotLastPlayedAt) {
    return {
      lastPlayedAt: new Date(snapshotLastPlayedAt).toISOString(),
      lastPlayedAtSource: 'trusted_snapshot_timestamp',
      hasReliableLastPlayedAt: true,
      fallbackReason: null
    };
  }

  return {
    lastPlayedAt: null,
    lastPlayedAtSource: 'snapshot_without_timestamp',
    hasReliableLastPlayedAt: false,
    fallbackReason: 'timestamp_unavailable'
  };
}

function mapUserTitleDto(titleKey, isSelected) {
  const titleDefinition = USER_TITLE_CATALOG.find((title) => title.key === titleKey);

  return {
    key: titleKey,
    label: titleDefinition?.label ?? titleKey,
    isSelected: Boolean(isSelected)
  };
}

async function getCurrentUserSelectedTitles(userId) {
  const rows = await prisma.userTitle.findMany({
    where: {
      userId,
      isSelected: true
    },
    select: {
      titleKey: true
    },
    orderBy: {
      createdAt: 'asc'
    }
  });
  const selectedKeys = new Set(rows.map((row) => row.titleKey));

  return USER_TITLE_CATALOG.map((title) => mapUserTitleDto(title.key, selectedKeys.has(title.key)));
}

function buildSelectedTitleCollections(titles) {
  const selectedTitleEntries = (titles ?? []).filter((title) => title.isSelected).slice(0, 1);

  return {
    selectedTitleKeys: selectedTitleEntries.map((title) => title.key),
    selectedTitles: selectedTitleEntries.map((title) => title.label)
  };
}

async function getCurrentUserFriendsCount(userId) {
  return prisma.friendship.count({
    where: {
      userId
    }
  });
}

function mapGenreLabelToProfileTag(genreLabel) {
  const normalizedGenre = normalizeGenreKey(genreLabel);

  if (!normalizedGenre) {
    return null;
  }

  if (normalizedGenre === 'role-playing (rpg)' || normalizedGenre === 'role playing (rpg)' || normalizedGenre === 'rpg') {
    return 'RPG';
  }

  if (normalizedGenre === 'hack and slash/beat \'em up') {
    return 'Action';
  }

  if (normalizedGenre === 'soulslike') {
    return 'Soulslike';
  }

  return genreLabel;
}

async function buildCurrentUserProfileTags({
  userId,
  favoriteGameIds,
  reviewGameIds,
  steamLibraryEntries
}) {
  const steamEntries = (steamLibraryEntries ?? []).filter((entry) => entry.gameSource === GameSource.STEAM);
  const steamMappingContext = await buildConfirmedSteamMappingContext(steamEntries.map((entry) => ({
    userId,
    externalGameId: entry.externalGameId,
    gameName: entry.gameName
  })), {
    userId,
    logLabel: 'profile-tags'
  });
  const steamMappedIgdbIds = steamEntries
    .map((entry) => steamMappingContext.mappingMap.get(entry.externalGameId)?.igdbGameId ?? null)
    .filter(Boolean);
  const igdbGameIds = uniqueStringValues([
    ...favoriteGameIds,
    ...reviewGameIds,
    ...steamMappedIgdbIds
  ]);
  const igdbGameMap = await buildIgdbGameMap(igdbGameIds);
  const tagWeights = new Map();

  for (const gameId of igdbGameIds) {
    const game = igdbGameMap.get(String(gameId));

    for (const genre of game?.genres ?? []) {
      const mappedTag = mapGenreLabelToProfileTag(genre);

      if (!mappedTag) {
        continue;
      }

      tagWeights.set(mappedTag, (tagWeights.get(mappedTag) ?? 0) + 1);
    }
  }

  const sortedTags = [...tagWeights.entries()]
    .filter(([, weight]) => weight > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([tag]) => tag)
    .slice(0, 3);

  logger.info('profile-tags-derived', {
    userId,
    tagCount: sortedTags.length,
    tags: sortedTags
  });

  return sortedTags;
}

function deriveAvailableTitleKeys({
  selectedTitleKeys,
  reviewCount,
  likeCount,
  friendCount,
  profileTags,
  createdAt,
  playedGameCount
}) {
  const availableKeys = new Set(selectedTitleKeys);
  const normalizedTags = new Set((profileTags ?? []).map((tag) => String(tag).trim().toLowerCase()));

  if (reviewCount >= 10) {
    availableKeys.add('pro_reviewer');
  }

  if (likeCount >= 20) {
    availableKeys.add('collector');
  }

  if (playedGameCount >= 25) {
    availableKeys.add('hardcore_gamer');
  }

  if (friendCount >= 5) {
    availableKeys.add('social_player');
  }

  if (createdAt instanceof Date && createdAt.getTime() <= Date.now() - (1000 * 60 * 60 * 24 * 180)) {
    availableKeys.add('early_adopter');
  }

  if (normalizedTags.has('rpg')) {
    availableKeys.add('rpg_lover');
  }

  if (normalizedTags.has('soulslike')) {
    availableKeys.add('soulslike_lover');
  }

  return [...availableKeys];
}

function deriveSelectedTitleKey({
  explicitSelectedTitleKey,
  availableTitleKeys,
  reviewCount,
  likeCount,
  profileTags
}) {
  if (explicitSelectedTitleKey) {
    return explicitSelectedTitleKey;
  }

  const availableKeySet = new Set(availableTitleKeys);
  const normalizedTags = new Set((profileTags ?? []).map((tag) => String(tag).trim().toLowerCase()));

  if (reviewCount >= 10 && availableKeySet.has('pro_reviewer')) {
    return 'pro_reviewer';
  }

  if (likeCount >= 20 && availableKeySet.has('collector')) {
    return 'collector';
  }

  if (normalizedTags.has('rpg') && availableKeySet.has('rpg_lover')) {
    return 'rpg_lover';
  }

  if (normalizedTags.has('soulslike') && availableKeySet.has('soulslike_lover')) {
    return 'soulslike_lover';
  }

  return null;
}

async function buildCurrentUserRecentPlayedSummary(userId, limit = PROFILE_RECENTLY_PLAYED_LIMIT) {
  const recentPlayedResult = await libraryService.getMyRecentlyPlayedLibrary({
    userId,
    page: 1,
    limit,
    endpoint: 'profile_recent_play'
  });
  const games = Array.isArray(recentPlayedResult?.recentlyPlayed) ? recentPlayedResult.recentlyPlayed : [];
  const recentPlayedCount = recentPlayedResult?.meta?.totalCount ?? games.length;
  const recentPlayedSource = recentPlayedResult?.steam?.recentlyPlayedSource ?? 'none';

  logger.info('profile-recent-play-source', {
    userId,
    recentPlayedSource,
    recentPlayedCount,
    reliableTimestampCount: games.filter((game) => game.hasReliableLastPlayedAt).length,
    snapshotOnlyWithoutTimestampCount: games.filter((game) => game.lastPlayedAtSource === 'snapshot_without_timestamp').length,
    noTimestampCount: games.filter((game) => !game.hasReliableLastPlayedAt).length
  });

  return {
    recentPlayedPreview: games,
    recentPlayedCount,
    hasMoreRecentPlayed: recentPlayedCount > games.length,
    recentPlayedSource
  };
}

async function buildCurrentUserRecentlyPlayedGames(userId, limit = PROFILE_RECENTLY_PLAYED_LIMIT) {
  const recentPlayedResult = await libraryService.getMyRecentlyPlayedLibrary({
    userId,
    page: 1,
    limit,
    endpoint: 'profile_recent_play'
  });

  return (recentPlayedResult?.recentlyPlayed ?? []).map((game) => ({
    gameId: Number.isInteger(game.gameId) && game.gameId > 0 ? game.gameId : null,
    externalGameId: game.externalGameId,
    gameSource: game.gameSource ?? 'steam',
    name: game.gameName ?? game.title ?? null,
    gameName: game.gameName ?? game.title ?? null,
    coverUrl: game.coverUrl ?? null,
    coverURL: game.coverUrl ?? null,
    playtimeMinutes: game.playtimeMinutes ?? null,
    recentPlaytimeMinutes: game.recentPlaytimeMinutes ?? null,
    lastPlayedAt: game.lastPlayedAt ?? null,
    lastPlayedAtSource: game.lastPlayedAtSource ?? null,
    hasReliableLastPlayedAt: game.hasReliableLastPlayedAt === true,
    fallbackReason: game.fallbackReason ?? null,
    recentPlayedSource: game.lastPlayedAtSource ?? null,
    inclusionSource: game.inclusionSource ?? null,
    igdbGameId: game.igdbGameId ?? null,
    detailAvailable: game.detailAvailable === true,
    rating: game.rating ?? null,
    aggregatedRating: game.aggregatedRating ?? null,
    totalRating: game.totalRating ?? null
  }));
}

function normalizeGenreKey(label) {
  return typeof label === 'string' ? label.trim().toLowerCase() : '';
}

function buildGenreWeightMap(games) {
  const genreWeightMap = new Map();

  for (const game of games ?? []) {
    for (const genre of game?.genres ?? []) {
      const normalizedGenre = normalizeGenreKey(genre);

      if (!normalizedGenre) {
        continue;
      }

      genreWeightMap.set(normalizedGenre, (genreWeightMap.get(normalizedGenre) ?? 0) + 1);
    }
  }

  return genreWeightMap;
}

function computeSetOverlapScore(leftValues, rightValues) {
  const leftSet = new Set(leftValues ?? []);
  const rightSet = new Set(rightValues ?? []);

  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }

  let intersectionCount = 0;

  for (const value of leftSet) {
    if (rightSet.has(value)) {
      intersectionCount += 1;
    }
  }

  return intersectionCount / Math.max(leftSet.size, rightSet.size);
}

function computeWeightedGenreOverlap(leftMap, rightMap) {
  if (!(leftMap instanceof Map) || !(rightMap instanceof Map) || leftMap.size === 0 || rightMap.size === 0) {
    return 0;
  }

  const genreKeys = new Set([...leftMap.keys(), ...rightMap.keys()]);
  let intersectionWeight = 0;
  let unionWeight = 0;

  for (const genreKey of genreKeys) {
    const leftWeight = leftMap.get(genreKey) ?? 0;
    const rightWeight = rightMap.get(genreKey) ?? 0;

    intersectionWeight += Math.min(leftWeight, rightWeight);
    unionWeight += Math.max(leftWeight, rightWeight);
  }

  return unionWeight > 0 ? intersectionWeight / unionWeight : 0;
}

function classifyPlayPattern(recentlyPlayedGames) {
  const recentPlaytimes = (recentlyPlayedGames ?? [])
    .map((game) => game.recentPlaytimeMinutes)
    .filter((value) => Number.isInteger(value) && value > 0);

  if (recentPlaytimes.length === 0) {
    return 'balanced';
  }

  const averageRecentPlaytime = recentPlaytimes.reduce((sum, value) => sum + value, 0) / recentPlaytimes.length;

  if (averageRecentPlaytime >= 240) {
    return 'long';
  }

  if (averageRecentPlaytime <= 90) {
    return 'short';
  }

  return 'balanced';
}

function computePlayPatternSimilarity(leftPattern, rightPattern) {
  if (leftPattern === rightPattern) {
    return 1;
  }

  if (leftPattern === 'balanced' || rightPattern === 'balanced') {
    return 0.55;
  }

  return 0.2;
}

async function buildIgdbGameMap(gameIds) {
  const normalizedIds = uniqueStringValues(gameIds).filter((gameId) => /^\d+$/.test(gameId));

  if (normalizedIds.length === 0) {
    return new Map();
  }

  try {
    const result = await igdbService.getGamesByIds({ gameIds: normalizedIds });
    return new Map(result.games.map((game) => [String(game.id), game]));
  } catch (error) {
    logger.warn('friend-igdb-hydration-skipped', {
      code: error?.code ?? null,
      message: error?.message ?? 'Friend IGDB hydration failed',
      gameCount: normalizedIds.length
    });

    return new Map();
  }
}

async function buildConfirmedSteamMappingContext(externalGameIds, {
  userId = null,
  logLabel = 'user-friend-recommendations'
} = {}) {
  const normalizedGames = (externalGameIds ?? [])
    .map((entry) => {
      if (typeof entry === 'string') {
        const externalGameId = entry.trim();

        return externalGameId
          ? {
            userId,
            externalGameId
          }
          : null;
      }

      const externalGameId = typeof entry?.externalGameId === 'string' ? entry.externalGameId.trim() : '';

      if (!externalGameId) {
        return null;
      }

      return {
        userId: typeof entry?.userId === 'string' && entry.userId.trim() ? entry.userId.trim() : userId,
        externalGameId,
        gameName: typeof entry?.gameName === 'string' && entry.gameName.trim() ? entry.gameName.trim() : null,
        title: typeof entry?.title === 'string' && entry.title.trim()
          ? entry.title.trim()
          : (typeof entry?.gameName === 'string' && entry.gameName.trim() ? entry.gameName.trim() : null)
      };
    })
    .filter(Boolean);
  const normalizedAppIds = uniqueStringValues(normalizedGames.map((entry) => entry.externalGameId));

  if (normalizedAppIds.length === 0) {
    return {
      mappingMap: new Map(),
      igdbGameMap: new Map()
    };
  }

  if (typeof libraryService.resolveSteamMappingContextForGames === 'function') {
    try {
      const resolution = await libraryService.resolveSteamMappingContextForGames({
        games: normalizedGames,
        activeResolution: false,
        createMissingMappingsWhenUncached: true,
        logLabel,
        userId
      });

      if (resolution?.mappingContext) {
        return resolution.mappingContext;
      }
    } catch (error) {
      logger.warn('friend-steam-mapping-resolution-degraded', {
        userId,
        logLabel,
        steamAppIdCount: normalizedAppIds.length,
        code: error?.code ?? null,
        message: error?.message ?? 'Steam mapping resolution failed'
      });
    }
  }

  const mappings = await prisma.steamIgdbMapping.findMany({
    where: {
      steamAppId: {
        in: normalizedAppIds
      },
      matchStatus: 'CONFIRMED'
    }
  });
  const mappingMap = new Map(mappings.map((mapping) => [mapping.steamAppId, mapping]));
  const igdbGameMap = await buildIgdbGameMap(mappings.map((mapping) => mapping.igdbGameId).filter(Boolean));

  return {
    mappingMap,
    igdbGameMap
  };
}

function buildGamePreviewFromIgdbGame(gameId, igdbGame) {
  const normalizedGameId = String(gameId);
  const title = igdbGame?.name ?? null;
  const coverUrl = igdbGame?.coverUrl ?? null;

  return {
    gameSource: 'igdb',
    externalGameId: normalizedGameId,
    title,
    gameName: title,
    coverUrl,
    igdbGameId: normalizedGameId,
    metadataEnriched: Boolean(igdbGame),
    detailAvailable: true
  };
}

function buildGamePreviewFromLibraryEntry(entry, steamMappingContext) {
  if (entry.gameSource === 'IGDB') {
    const igdbGame = steamMappingContext.igdbGameMap.get(String(entry.externalGameId)) ?? null;
    return buildGamePreviewFromIgdbGame(entry.externalGameId, igdbGame);
  }

  const mapping = steamMappingContext.mappingMap.get(entry.externalGameId) ?? null;
  const igdbGame = mapping?.igdbGameId
    ? steamMappingContext.igdbGameMap.get(String(mapping.igdbGameId)) ?? null
    : null;
  const coverUrl = buildGameImageResolverUrl({
    gameSource: 'steam',
    externalGameId: entry.externalGameId,
    igdbCoverUrl: extractUsableIgdbCoverUrl(igdbGame?.coverUrl ?? entry.coverUrl)
  });

  return {
    gameSource: 'steam',
    externalGameId: entry.externalGameId,
    title: entry.gameName,
    gameName: entry.gameName,
    coverUrl,
    igdbGameId: mapping?.igdbGameId ?? null,
    metadataEnriched: Boolean(mapping?.igdbGameId),
    detailAvailable: true,
    playtimeMinutes: Number.isInteger(entry.playtimeMinutes) ? entry.playtimeMinutes : null
  };
}

async function getFriendIds(currentUserId) {
  const friendships = await prisma.friendship.findMany({
    where: {
      userId: currentUserId
    },
    select: {
      friendUserId: true
    }
  });

  return friendships.map((friendship) => friendship.friendUserId);
}

async function buildTasteSimilarityContext(currentUserId, targetUserId) {
  await getEditableCurrentUser(currentUserId);
  await assertFriendAccess({
    currentUserId,
    targetUserId
  });
  const targetPrivacySettings = await getOrCreatePrivacySettings(targetUserId);

  const [currentLikedGames, targetLikedGames, currentReviews, targetReviews, currentHighRatedReviews, targetHighRatedReviews, currentLibraryEntries, targetLibraryEntries, currentRecentlyPlayed, targetRecentlyPlayed] = await Promise.all([
    prisma.favoriteGame.findMany({
      where: { userId: currentUserId },
      select: { gameId: true }
    }),
    prisma.favoriteGame.findMany({
      where: { userId: targetUserId },
      select: { gameId: true }
    }),
    prisma.review.findMany({
      where: { userId: currentUserId },
      select: { gameId: true }
    }),
    prisma.review.findMany({
      where: { userId: targetUserId },
      select: { gameId: true }
    }),
    prisma.review.findMany({
      where: {
        userId: currentUserId,
        rating: { gte: HIGH_RATED_REVIEW_THRESHOLD }
      },
      select: { gameId: true }
    }),
    prisma.review.findMany({
      where: {
        userId: targetUserId,
        rating: { gte: HIGH_RATED_REVIEW_THRESHOLD }
      },
      select: { gameId: true }
    }),
    prisma.userGameLibrary.findMany({
      where: { userId: currentUserId },
      select: {
        userId: true,
        gameSource: true,
        externalGameId: true,
        gameName: true,
        coverUrl: true,
        status: true,
        playtimeMinutes: true,
        lastPlayedAt: true,
        updatedAt: true
      }
    }),
    prisma.userGameLibrary.findMany({
      where: { userId: targetUserId },
      select: {
        userId: true,
        gameSource: true,
        externalGameId: true,
        gameName: true,
        coverUrl: true,
        status: true,
        playtimeMinutes: true,
        lastPlayedAt: true,
        updatedAt: true
      }
    }),
    libraryService.getMyRecentlyPlayedLibrary({
      userId: currentUserId,
      page: 1,
      limit: 10
    }).catch(() => ({ recentlyPlayed: [] })),
    libraryService.getMyRecentlyPlayedLibrary({
      userId: targetUserId,
      page: 1,
      limit: 10
    }).catch(() => ({ recentlyPlayed: [] }))
  ]);
  const currentLikedIds = uniqueStringValues(currentLikedGames.map((favorite) => favorite.gameId));
  const targetLikedIds = targetPrivacySettings.showLikedGames
    ? uniqueStringValues(targetLikedGames.map((favorite) => favorite.gameId))
    : [];
  const currentReviewedIds = uniqueStringValues(currentReviews.map((review) => review.gameId));
  const targetReviewedIds = targetPrivacySettings.showReviews
    ? uniqueStringValues(targetReviews.map((review) => review.gameId))
    : [];
  const currentHighRatedIds = uniqueStringValues(currentHighRatedReviews.map((review) => review.gameId));
  const targetHighRatedIds = targetPrivacySettings.showReviews
    ? uniqueStringValues(targetHighRatedReviews.map((review) => review.gameId))
    : [];
  const allSteamAppIds = uniqueStringValues([
    ...currentLibraryEntries.filter((entry) => entry.gameSource === 'STEAM').map((entry) => entry.externalGameId),
    ...targetLibraryEntries.filter((entry) => entry.gameSource === 'STEAM').map((entry) => entry.externalGameId),
    ...(currentRecentlyPlayed.recentlyPlayed ?? [])
      .filter((game) => String(game.gameSource ?? game.source).toUpperCase() === 'STEAM' || String(game.source).toLowerCase() === 'steam')
      .map((game) => game.externalGameId),
    ...(targetPrivacySettings.showRecentlyPlayed ? (targetRecentlyPlayed.recentlyPlayed ?? []) : [])
      .filter((game) => String(game.gameSource ?? game.source).toUpperCase() === 'STEAM' || String(game.source).toLowerCase() === 'steam')
      .map((game) => game.externalGameId)
  ]);
  const [steamMappingContext, steamTagMap] = await Promise.all([
    buildConfirmedSteamMappingContext(allSteamAppIds, {
      userId: currentUserId,
      logLabel: 'taste-profile'
    }),
    getSteamTagMap(allSteamAppIds, {
      userId: currentUserId,
      context: 'taste_profile'
    })
  ]);
  const allGenreSourceIds = uniqueStringValues([
    ...currentLikedIds,
    ...targetLikedIds,
    ...currentReviewedIds,
    ...targetReviewedIds,
    ...currentHighRatedIds,
    ...targetHighRatedIds,
    ...[...steamMappingContext.mappingMap.values()]
      .map((mapping) => mapping.igdbGameId)
      .filter(Boolean)
  ]);
  const igdbGameMap = await buildIgdbGameMap(allGenreSourceIds);
  const currentGenreMap = buildGenreWeightMap(
    [...currentLikedIds, ...currentReviewedIds, ...currentHighRatedIds]
      .map((gameId) => igdbGameMap.get(gameId))
      .filter(Boolean)
  );
  const targetGenreMap = buildGenreWeightMap(
    [...targetLikedIds, ...targetReviewedIds, ...targetHighRatedIds]
      .map((gameId) => igdbGameMap.get(gameId))
      .filter(Boolean)
  );
  const currentTagMap = buildStringWeightMap(
    uniqueStringValues([
      ...currentLibraryEntries
        .filter((entry) => entry.gameSource === 'STEAM')
        .flatMap((entry) => steamTagMap.get(entry.externalGameId) ?? []),
      ...(currentRecentlyPlayed.recentlyPlayed ?? [])
        .filter((game) => String(game.source).toLowerCase() === 'steam')
        .flatMap((game) => steamTagMap.get(game.externalGameId) ?? [])
    ])
  );
  const targetTagMap = buildStringWeightMap(
    uniqueStringValues([
      ...targetLibraryEntries
        .filter((entry) => entry.gameSource === 'STEAM')
        .flatMap((entry) => steamTagMap.get(entry.externalGameId) ?? []),
      ...(targetPrivacySettings.showRecentlyPlayed ? (targetRecentlyPlayed.recentlyPlayed ?? []) : [])
        .filter((game) => String(game.source).toLowerCase() === 'steam')
        .flatMap((game) => steamTagMap.get(game.externalGameId) ?? [])
    ])
  );
  const currentLibraryKeys = uniqueStringValues(
    currentLibraryEntries
      .map((entry) => buildCanonicalGameKeyFromLibraryEntry(entry, steamMappingContext))
      .filter(Boolean)
  );
  const targetLibraryKeys = uniqueStringValues(
    targetLibraryEntries
      .map((entry) => buildCanonicalGameKeyFromLibraryEntry(entry, steamMappingContext))
      .filter(Boolean)
  );
  const currentRecentKeys = uniqueStringValues(
    (currentRecentlyPlayed.recentlyPlayed ?? [])
      .map((game) => buildCanonicalGameKeyFromPreviewItem(game))
      .filter(Boolean)
  );
  const targetRecentKeys = targetPrivacySettings.showRecentlyPlayed
    ? uniqueStringValues(
      (targetRecentlyPlayed.recentlyPlayed ?? [])
        .map((game) => buildCanonicalGameKeyFromPreviewItem(game))
        .filter(Boolean)
    )
    : [];

  return {
    currentLikedIds,
    targetLikedIds,
    currentReviewedIds,
    targetReviewedIds,
    currentHighRatedIds,
    targetHighRatedIds,
    currentGenreMap,
    targetGenreMap,
    currentTagMap,
    targetTagMap,
    currentLibraryKeys,
    targetLibraryKeys,
    currentRecentKeys,
    targetRecentKeys,
    currentLibraryEntries,
    targetLibraryEntries,
    currentRecentlyPlayed: currentRecentlyPlayed.recentlyPlayed ?? [],
    targetRecentlyPlayed: targetPrivacySettings.showRecentlyPlayed ? (targetRecentlyPlayed.recentlyPlayed ?? []) : [],
    igdbGameMap,
    steamMappingContext,
    steamTagMap,
    targetPrivacySettings
  };
}

function buildTasteSimilarityResult(tasteContext) {
  const likedOverlapScore = computeSetOverlapScore(tasteContext.currentLikedIds, tasteContext.targetLikedIds);
  const reviewedOverlapScore = computeSetOverlapScore(tasteContext.currentReviewedIds, tasteContext.targetReviewedIds);
  const highRatedOverlapScore = computeSetOverlapScore(tasteContext.currentHighRatedIds, tasteContext.targetHighRatedIds);
  const genreOverlapScore = computeWeightedGenreOverlap(tasteContext.currentGenreMap, tasteContext.targetGenreMap);
  const tagOverlapScore = computeWeightedGenreOverlap(tasteContext.currentTagMap, tasteContext.targetTagMap);
  const sharedLibraryScore = computeSetOverlapScore(tasteContext.currentLibraryKeys, tasteContext.targetLibraryKeys);
  const recentOverlapScore = computeSetOverlapScore(tasteContext.currentRecentKeys, tasteContext.targetRecentKeys);
  const playPatternScore = computePlayPatternSimilarity(
    classifyPlayPattern(tasteContext.currentRecentlyPlayed),
    classifyPlayPattern(tasteContext.targetRecentlyPlayed)
  );
  const similarityScore = Math.round(
    (
      (likedOverlapScore * 0.22) +
      (reviewedOverlapScore * 0.08) +
      (highRatedOverlapScore * 0.18) +
      (genreOverlapScore * 0.20) +
      (tagOverlapScore * 0.12) +
      (sharedLibraryScore * 0.10) +
      (recentOverlapScore * 0.05) +
      (playPatternScore * 0.05)
    ) * 100
  );
  const matchedSignals = [];

  if (likedOverlapScore >= 0.15) {
    matchedSignals.push('liked_games_overlap');
  }

  if (highRatedOverlapScore >= 0.15) {
    matchedSignals.push('high_rated_overlap');
  }

  if (reviewedOverlapScore >= 0.15) {
    matchedSignals.push('review_overlap');
  }

  if (genreOverlapScore >= 0.2) {
    matchedSignals.push('genre_overlap');
  }

  if (tagOverlapScore >= 0.15) {
    matchedSignals.push('tag_overlap');
  }

  if (sharedLibraryScore >= 0.15) {
    matchedSignals.push('shared_library_overlap');
  }

  if (recentOverlapScore >= 0.15) {
    matchedSignals.push('recent_play_overlap');
  }

  if (playPatternScore >= 0.55) {
    matchedSignals.push('recent_play_pattern');
  }

  let explanation = '취향이 아직 뚜렷하게 겹치지 않아요';

  const dominantSignals = [
    ['highRated', highRatedOverlapScore],
    ['liked', likedOverlapScore],
    ['genre', genreOverlapScore],
    ['tag', tagOverlapScore],
    ['sharedLibrary', sharedLibraryScore]
  ].sort((left, right) => right[1] - left[1]);

  switch (dominantSignals[0]?.[0]) {
  case 'highRated':
    explanation = '높게 평가한 게임이 꽤 비슷해요';
    break;
  case 'liked':
    explanation = '좋아하는 게임 취향이 비슷해요';
    break;
  case 'tag':
    explanation = '협동 플레이나 선호 태그가 잘 맞아요';
    break;
  case 'sharedLibrary':
    explanation = '같이 즐길 수 있는 게임 풀이 많이 겹쳐요';
    break;
  case 'genre':
    explanation = '자주 즐기는 장르가 비슷해요';
    break;
  default:
    break;
  }

  return {
    similarityScore,
    explanation,
    matchedSignals,
    scores: {
      likedOverlapScore,
      reviewedOverlapScore,
      highRatedOverlapScore,
      genreOverlapScore,
      tagOverlapScore,
      sharedLibraryScore,
      recentOverlapScore,
      playPatternScore
    }
  };
}

function buildTasteProfileSummary(tasteResult) {
  if (tasteResult.scores.sharedLibraryScore >= 0.25 && tasteResult.scores.tagOverlapScore >= 0.2) {
    return '비슷한 장르와 협동 플레이 게임을 자주 즐겨요';
  }

  if (tasteResult.scores.highRatedOverlapScore >= 0.2) {
    return '높게 평가한 게임 취향이 잘 맞아요';
  }

  if (tasteResult.scores.likedOverlapScore >= 0.2) {
    return '좋아하는 게임과 장르가 꽤 비슷해요';
  }

  if (tasteResult.scores.genreOverlapScore >= 0.2) {
    return '비슷한 장르를 꾸준히 즐겨요';
  }

  if (tasteResult.scores.tagOverlapScore >= 0.15) {
    return '선호하는 플레이 태그가 겹쳐요';
  }

  return tasteResult.explanation;
}

function buildTasteProfileResult(tasteContext) {
  const tasteResult = buildTasteSimilarityResult(tasteContext);

  return {
    similarityScore: roundNormalizedScore(tasteResult.similarityScore / 100),
    topGenres: buildCommonWeightedLabels(tasteContext.currentGenreMap, tasteContext.targetGenreMap),
    topTags: buildCommonWeightedLabels(tasteContext.currentTagMap, tasteContext.targetTagMap),
    overlap: {
      likedGamesCount: buildSharedCount(tasteContext.currentLikedIds, tasteContext.targetLikedIds),
      reviewedGamesCount: buildSharedCount(tasteContext.currentReviewedIds, tasteContext.targetReviewedIds),
      highRatedGamesCount: buildSharedCount(tasteContext.currentHighRatedIds, tasteContext.targetHighRatedIds),
      sharedLibraryCount: buildSharedCount(tasteContext.currentLibraryKeys, tasteContext.targetLibraryKeys),
      recentPlayedCount: buildSharedCount(tasteContext.currentRecentKeys, tasteContext.targetRecentKeys)
    },
    summary: buildTasteProfileSummary(tasteResult),
    matchedSignals: tasteResult.matchedSignals
  };
}

function buildCommonGenres(currentGenreMap, targetGenreMap) {
  const genreKeys = new Set([
    ...currentGenreMap.keys(),
    ...targetGenreMap.keys()
  ]);

  return [...genreKeys]
    .map((genreKey) => ({
      key: genreKey,
      score: Math.min(currentGenreMap.get(genreKey) ?? 0, targetGenreMap.get(genreKey) ?? 0)
    }))
    .filter((genre) => genre.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((genre) => genre.key);
}

function buildFriendRecommendationReason(candidate) {
  if (candidate.similarHighRatedCount > 0) {
    return '비슷한 취향의 친구가 높게 평가했어요';
  }

  if (candidate.playingFriendCount > 0) {
    return `친구 ${candidate.playingFriendCount}명이 플레이 중이에요`;
  }

  if (candidate.friendCount > 1) {
    return `친구 ${candidate.friendCount}명이 관심을 보였어요`;
  }

  return '친구가 좋아한 게임이에요';
}

function buildSocialPlayReason({ isRecentlyPlayedByBoth, hasCoopSupport, hasMultiplayerSupport, bothHighPlaytime }) {
  if (isRecentlyPlayedByBoth) {
    return '둘 다 최근 플레이했어요';
  }

  if (hasCoopSupport) {
    return '둘 다 보유한 협동 플레이 게임이에요';
  }

  if (hasMultiplayerSupport) {
    return '둘 다 보유한 멀티플레이 게임이에요';
  }

  if (bothHighPlaytime) {
    return '둘 다 오래 플레이한 게임이에요';
  }

  return '둘 다 보유한 게임이에요';
}

function wrapRecommendationGame(preview, payload) {
  return {
    ...preview,
    game: preview,
    ...payload
  };
}

async function buildSteamFriendsResponse({ currentUserId }) {
  await getEditableCurrentUser(currentUserId);

  const steamAccount = await getSteamSocialAccount(currentUserId);

  if (!steamAccount) {
    logger.debug('steam-friend-import', {
      userId: currentUserId,
      steamConnected: false,
      steamFriendsAvailable: false,
      reason: 'steam_not_connected'
    });

    return {
      friends: [],
      skipped: true,
      reason: 'steam_not_connected',
      steamFriendsAvailable: false,
      steamFriendsLimitedByPrivacy: false,
      syncWarningCode: 'STEAM_NOT_CONNECTED'
    };
  }

  if (!steamService.isSteamSyncConfigured()) {
    logger.info('steam-friend-import', {
      userId: currentUserId,
      steamConnected: true,
      steamFriendsAvailable: false,
      reason: 'steam_api_not_configured'
    });

    return {
      friends: [],
      steamFriendsAvailable: false,
      steamFriendsLimitedByPrivacy: false,
      syncWarningCode: 'STEAM_API_NOT_CONFIGURED'
    };
  }

  const steamId64 = steamService.normalizeSteamId64(steamAccount.providerSubject);

  if (!steamId64) {
    logger.warn('steam-friend-import', {
      userId: currentUserId,
      steamConnected: true,
      steamFriendsAvailable: false,
      reason: 'invalid_steam_provider_subject',
      providerSubject: steamAccount.providerSubject ?? null
    });

    return {
      friends: [],
      steamFriendsAvailable: false,
      steamFriendsLimitedByPrivacy: false,
      syncWarningCode: 'STEAM_ID_INVALID'
    };
  }

  let friendListResult;

  try {
    friendListResult = await steamService.fetchFriendList({ steamId64 });
  } catch (error) {
    logger.warn('steam-friend-import', {
      userId: currentUserId,
      steamId64,
      steamConnected: true,
      steamFriendsAvailable: false,
      reason: 'steam_friend_fetch_failed',
      code: error?.code ?? null,
      message: error?.message ?? 'Steam friend list fetch failed'
    });

    return {
      friends: [],
      steamFriendsAvailable: false,
      steamFriendsLimitedByPrivacy: false,
      syncWarningCode: error?.code ?? 'STEAM_FRIENDS_UNAVAILABLE'
    };
  }

  const friendSteamIds = friendListResult.steamIds ?? [];

  if (friendSteamIds.length === 0 || friendListResult.syncWarningCode) {
    logger.info('steam-friend-import', {
      userId: currentUserId,
      steamId64,
      steamConnected: true,
      steamFriendsAvailable: false,
      importedFriendCount: 0,
      linkedGamePediaFriendCount: 0,
      reason: friendListResult.syncWarningCode ?? 'no_friends'
    });

    return {
      friends: [],
      steamFriendsAvailable: false,
      steamFriendsLimitedByPrivacy: friendListResult.syncWarningCode === 'STEAM_FRIENDS_UNAVAILABLE',
      syncWarningCode: friendListResult.syncWarningCode ?? null
    };
  }

  const hiddenUserIds = await moderationService.getHiddenUserIds(currentUserId);
  const [linkedAccounts, playerSummaries] = await Promise.all([
    prisma.socialAccount.findMany({
      where: {
        provider: steamService.STEAM_AUTH_PROVIDER,
        providerSubject: {
          in: friendSteamIds
        },
        user: {
          status: UserStatus.ACTIVE,
          id: {
            notIn: [...hiddenUserIds, currentUserId]
          }
        }
      },
      select: {
        userId: true,
        providerSubject: true,
        personaName: true,
        avatarUrl: true,
        profileUrl: true,
        user: {
          select: basicUserSelect
        }
      }
    }),
    steamService.fetchPlayerSummaries({ steamIds64: friendSteamIds }).catch((error) => {
      logger.warn('steam-friend-import', {
        userId: currentUserId,
        steamId64,
        reason: 'steam_friend_summary_fetch_failed',
        code: error?.code ?? null,
        message: error?.message ?? 'Steam friend summaries fetch failed'
      });

      return {
        players: [],
        missingSteamIds: friendSteamIds
      };
    })
  ]);

  const linkedAccountMap = new Map(linkedAccounts.map((account) => [account.providerSubject, account]));
  const playerSummaryMap = new Map((playerSummaries.players ?? []).map((player) => [player.steamId64, player]));
  const friends = friendSteamIds.map((friendSteamId) => {
    const linkedAccount = linkedAccountMap.get(friendSteamId) ?? null;
    const playerSummary = playerSummaryMap.get(friendSteamId) ?? null;

    return {
      steamId64: friendSteamId,
      isLinkedToGamePedia: Boolean(linkedAccount?.userId),
      userId: linkedAccount?.userId ?? null,
      nickname: linkedAccount?.user?.nickname ?? null,
      profileImageUrl: normalizeProfileImageUrl(linkedAccount?.user?.profileImageUrl),
      personaName: linkedAccount?.personaName ?? playerSummary?.personaName ?? null,
      avatarUrl: linkedAccount?.avatarUrl ?? playerSummary?.avatarUrl ?? null,
      profileUrl: linkedAccount?.profileUrl ?? playerSummary?.profileUrl ?? null
    };
  });
  const linkedGamePediaFriendCount = friends.filter((friend) => friend.isLinkedToGamePedia).length;

  logger.info('steam-friend-import', {
    userId: currentUserId,
    steamId64,
    steamConnected: true,
    steamFriendsAvailable: true,
    importedFriendCount: friends.length,
    linkedGamePediaFriendCount
  });

  return {
    friends,
    steamFriendsAvailable: true,
    steamFriendsLimitedByPrivacy: false,
    syncWarningCode: null
  };
}

async function buildSharedGamesResult({ currentUserId, targetUserId, limit = SHARED_GAMES_LIMIT }) {
  await assertFriendAccess({
    currentUserId,
    targetUserId
  });
  const targetPrivacySettings = await getOrCreatePrivacySettings(targetUserId);
  const [currentLibraryEntries, targetLibraryEntries, currentRecentlyPlayed, targetRecentlyPlayed] = await Promise.all([
    prisma.userGameLibrary.findMany({
      where: { userId: currentUserId },
      select: {
        userId: true,
        gameSource: true,
        externalGameId: true,
        gameName: true,
        coverUrl: true,
        status: true,
        playtimeMinutes: true,
        lastPlayedAt: true,
        updatedAt: true
      }
    }),
    prisma.userGameLibrary.findMany({
      where: { userId: targetUserId },
      select: {
        userId: true,
        gameSource: true,
        externalGameId: true,
        gameName: true,
        coverUrl: true,
        status: true,
        playtimeMinutes: true,
        lastPlayedAt: true,
        updatedAt: true
      }
    }),
    libraryService.getMyRecentlyPlayedLibrary({
      userId: currentUserId,
      page: 1,
      limit: 20
    }).catch(() => ({ recentlyPlayed: [] })),
    targetPrivacySettings.showRecentlyPlayed
      ? libraryService.getMyRecentlyPlayedLibrary({
        userId: targetUserId,
        page: 1,
        limit: 20
      }).catch(() => ({ recentlyPlayed: [] }))
      : Promise.resolve({ recentlyPlayed: [] })
  ]);
  const steamMappingContext = await buildConfirmedSteamMappingContext([
    ...currentLibraryEntries.filter((entry) => entry.gameSource === 'STEAM'),
    ...targetLibraryEntries.filter((entry) => entry.gameSource === 'STEAM')
  ], {
    userId: currentUserId,
    logLabel: 'shared-games'
  });

  const currentByKey = new Map();
  const targetByKey = new Map();
  const upsertEntry = (targetMap, entry) => {
    const key = buildCanonicalGameKeyFromLibraryEntry(entry, steamMappingContext);

    if (!key) {
      return;
    }

    const existingValue = targetMap.get(key);
    const preview = buildGamePreviewFromLibraryEntry(entry, steamMappingContext);
    const steamAppIds = new Set([
      ...(existingValue?.steamAppIds ?? []),
      ...(entry.gameSource === 'STEAM' ? [entry.externalGameId] : [])
    ]);
    const nextValue = {
      preview: existingValue?.preview?.metadataEnriched ? existingValue.preview : preview,
      playtimeMinutes: Number.isInteger(entry.playtimeMinutes) ? entry.playtimeMinutes : (existingValue?.playtimeMinutes ?? null),
      lastPlayedAt: entry.lastPlayedAt ?? existingValue?.lastPlayedAt ?? null,
      status: entry.status ?? existingValue?.status ?? null,
      steamAppIds: [...steamAppIds]
    };

    if (!nextValue.preview?.metadataEnriched && preview?.metadataEnriched) {
      nextValue.preview = preview;
    }

    targetMap.set(key, nextValue);
  };

  for (const entry of currentLibraryEntries) {
    upsertEntry(currentByKey, entry);
  }

  for (const entry of targetLibraryEntries) {
    upsertEntry(targetByKey, entry);
  }

  const currentRecentKeys = new Set(
    (currentRecentlyPlayed.recentlyPlayed ?? [])
      .map((game) => buildCanonicalGameKeyFromPreviewItem(game))
      .filter(Boolean)
  );
  const targetRecentKeys = new Set(
    (targetRecentlyPlayed.recentlyPlayed ?? [])
      .map((game) => buildCanonicalGameKeyFromPreviewItem(game))
      .filter(Boolean)
  );
  const sharedKeys = [...currentByKey.keys()].filter((key) => targetByKey.has(key));
  const sharedSteamAppIds = uniqueStringValues(sharedKeys.flatMap((key) => [
    ...(currentByKey.get(key)?.steamAppIds ?? []),
    ...(targetByKey.get(key)?.steamAppIds ?? [])
  ]));
  const steamTagMap = await getSteamTagMap(sharedSteamAppIds, {
    userId: currentUserId,
    context: 'shared_games',
    limit: SHARED_GAMES_LIMIT
  });
  const sharedGames = sharedKeys
    .map((key) => {
      const currentEntry = currentByKey.get(key);
      const targetEntry = targetByKey.get(key);
      const preview = currentEntry?.preview?.metadataEnriched
        ? currentEntry.preview
        : (targetEntry?.preview ?? currentEntry?.preview ?? null);

      if (!preview) {
        return null;
      }

      const steamTags = uniqueStringValues([
        ...(currentEntry?.steamAppIds ?? []).flatMap((appId) => steamTagMap.get(appId) ?? []),
        ...(targetEntry?.steamAppIds ?? []).flatMap((appId) => steamTagMap.get(appId) ?? [])
      ]);
      const isRecentlyPlayedByBoth = currentRecentKeys.has(key) && targetRecentKeys.has(key);
      const hasMultiplayerSupport = hasSteamSocialPlayTag(steamTags, STEAM_MULTIPLAYER_TAG_KEYS);
      const hasCoopSupport = hasSteamSocialPlayTag(steamTags, STEAM_COOP_TAG_KEYS);
      const currentUserPlaytimeMinutes = Number.isInteger(currentEntry?.playtimeMinutes) ? currentEntry.playtimeMinutes : null;
      const friendPlaytimeMinutes = Number.isInteger(targetEntry?.playtimeMinutes) ? targetEntry.playtimeMinutes : null;
      const bothHighPlaytime = (currentUserPlaytimeMinutes ?? 0) >= 120 && (friendPlaytimeMinutes ?? 0) >= 120;
      const score = (
        (isRecentlyPlayedByBoth ? 1 : 0) * 0.45 +
        ((hasCoopSupport || hasMultiplayerSupport) ? 1 : 0) * 0.30 +
        (bothHighPlaytime ? 1 : 0) * 0.15 +
        (buildSharedCount(currentEntry?.steamAppIds ?? [], targetEntry?.steamAppIds ?? []) > 0 ? 1 : 0) * 0.10
      );

      return {
        game: preview,
        ...preview,
        sharedReason: buildSocialPlayReason({
          isRecentlyPlayedByBoth,
          hasCoopSupport,
          hasMultiplayerSupport,
          bothHighPlaytime
        }),
        currentUserPlaytimeMinutes,
        friendPlaytimeMinutes,
        isRecentlyPlayedByBoth,
        sharedScore: roundNormalizedScore(score)
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.sharedScore - left.sharedScore)
    .slice(0, limit);

  logger.info('friend-shared-games-query', {
    userId: currentUserId,
    targetUserId,
    candidateCount: sharedKeys.length,
    sharedGameCount: sharedGames.length,
    sharedGamesLimitedByPrivacy: !targetPrivacySettings.showRecentlyPlayed
  });

  return {
    sharedGames,
    sharedGamesLimitedByPrivacy: !targetPrivacySettings.showRecentlyPlayed,
    recentPlayedAvailable: targetPrivacySettings.showRecentlyPlayed,
    steamFriendsAvailable: currentLibraryEntries.some((entry) => entry.gameSource === 'STEAM')
      && targetLibraryEntries.some((entry) => entry.gameSource === 'STEAM')
  };
}

async function buildFriendRecommendations({ currentUserId, friendIds, limit = FRIEND_RECOMMENDATION_LIMIT }) {
  if (friendIds.length === 0) {
    return [];
  }

  const [currentFavorites, currentReviews, currentLibraryEntries, friendFavorites, friendReviews, friendLibraryEntries, friendActivityEvents, privacySettingsMap] = await Promise.all([
    prisma.favoriteGame.findMany({
      where: { userId: currentUserId },
      select: { gameId: true }
    }),
    prisma.review.findMany({
      where: { userId: currentUserId },
      select: { gameId: true }
    }),
    prisma.userGameLibrary.findMany({
      where: { userId: currentUserId },
      select: {
        gameSource: true,
        externalGameId: true
      }
    }),
    prisma.favoriteGame.findMany({
      where: { userId: { in: friendIds } },
      select: {
        gameId: true,
        userId: true
      }
    }),
    prisma.review.findMany({
      where: { userId: { in: friendIds } },
      select: {
        gameId: true,
        userId: true,
        rating: true
      }
    }),
    prisma.userGameLibrary.findMany({
      where: { userId: { in: friendIds } },
      select: {
        userId: true,
        gameSource: true,
        externalGameId: true,
        gameName: true,
        coverUrl: true,
        status: true,
        playtimeMinutes: true,
        lastPlayedAt: true,
        updatedAt: true
      }
    }),
    prisma.userActivityEvent.findMany({
      where: {
        actorUserId: { in: friendIds },
        createdAt: {
          gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
        }
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 120
    }).catch((error) => {
      logger.warn('friend-recommendation-activity-query-degraded', {
        userId: currentUserId,
        friendCount: friendIds.length,
        code: error?.code ?? null,
        message: error?.message ?? 'Friend activity query failed'
      });
      return [];
    }),
    getPrivacySettingsMap(friendIds)
  ]);
  const visibleFriendFavorites = friendFavorites.filter((favorite) => mapPrivacySettingsDto(privacySettingsMap.get(favorite.userId)).showLikedGames);
  const visibleFriendReviews = friendReviews.filter((review) => mapPrivacySettingsDto(privacySettingsMap.get(review.userId)).showReviews);
  const visibleOwnedFriendLibraryEntries = friendLibraryEntries;
  const visibleRecentFriendLibraryEntries = friendLibraryEntries.filter((entry) => mapPrivacySettingsDto(privacySettingsMap.get(entry.userId)).showRecentlyPlayed);
  const visibleFriendActivityEvents = friendActivityEvents.filter((event) => {
    const privacy = mapPrivacySettingsDto(privacySettingsMap.get(event.actorUserId));

    if (event.activityType === UserActivityType.LIKED_GAME_ADDED || event.activityType === UserActivityType.LIKED_GAME_REMOVED) {
      return privacy.showLikedGames;
    }

    if (
      event.activityType === UserActivityType.REVIEW_CREATED ||
      event.activityType === UserActivityType.REVIEW_UPDATED ||
      event.activityType === UserActivityType.RATING_CHANGED
    ) {
      return privacy.showReviews;
    }

    return privacy.showRecentlyPlayed;
  });
  const currentSteamAppIds = uniqueStringValues(
    currentLibraryEntries
      .filter((entry) => entry.gameSource === 'STEAM')
      .map((entry) => entry.externalGameId)
  );
  const [currentSteamMappings, friendSteamMappings] = await Promise.all([
    buildConfirmedSteamMappingContext(
      currentSteamAppIds.map((externalGameId) => ({
        userId: currentUserId,
        externalGameId
      })),
      {
        userId: currentUserId,
        logLabel: 'friend-recommendations-current'
      }
    ),
    buildConfirmedSteamMappingContext(
      visibleOwnedFriendLibraryEntries
        .filter((entry) => entry.gameSource === 'STEAM')
        .map((entry) => ({
          userId: entry.userId,
          externalGameId: entry.externalGameId,
          gameName: entry.gameName ?? null,
          title: entry.gameName ?? null
        })),
      {
        userId: currentUserId,
        logLabel: 'friend-recommendations-friend'
      }
    )
  ]);
  const presenceMap = await userPresenceService.derivePresenceMap(friendIds).catch((error) => {
    logger.warn('friend-recommendation-presence-degraded', {
      userId: currentUserId,
      friendCount: friendIds.length,
      code: error?.code ?? null,
      message: error?.message ?? 'Friend presence derivation failed'
    });
    return new Map();
  });
  const currentExcludedKeys = new Set([
    ...currentFavorites.map((favorite) => buildCanonicalGameKey({
      gameSource: 'IGDB',
      externalGameId: favorite.gameId
    })),
    ...currentReviews.map((review) => buildCanonicalGameKey({
      gameSource: 'IGDB',
      externalGameId: review.gameId
    })),
    ...currentLibraryEntries.map((entry) => buildCanonicalGameKeyFromLibraryEntry(entry, currentSteamMappings))
  ].filter(Boolean));
  const tasteScoresByFriend = new Map();

  await Promise.all(friendIds.map(async (friendUserId) => {
    try {
      const tasteContext = await buildTasteSimilarityContext(currentUserId, friendUserId);
      const tasteProfile = buildTasteProfileResult(tasteContext);
      tasteScoresByFriend.set(friendUserId, tasteProfile.similarityScore);
    } catch (error) {
      tasteScoresByFriend.set(friendUserId, 0);
    }
  }));

  const candidateMap = new Map();
  const upsertCandidate = ({
    key,
    preview,
    userId,
    signalType,
    rating = null,
    activityBoost = false,
    presenceBoost = false
  }) => {
    if (!key || currentExcludedKeys.has(key) || !preview) {
      return;
    }

    const existingCandidate = candidateMap.get(key) ?? {
      preview,
      friendIds: new Set(),
      ownedFriendIds: new Set(),
      recentFriendIds: new Set(),
      likedFriendIds: new Set(),
      highRatedFriendIds: new Set(),
      activityFriendIds: new Set(),
      presenceFriendIds: new Set(),
      matchedSignals: new Set(),
      ratingSum: 0,
      ratingCount: 0,
      similarityWeightedActions: 0
    };
    const similarityWeight = tasteScoresByFriend.get(userId) ?? 0;

    existingCandidate.friendIds.add(userId);
    existingCandidate.similarityWeightedActions += similarityWeight;

    if (activityBoost) {
      existingCandidate.activityFriendIds.add(userId);
      existingCandidate.matchedSignals.add('friend_activity');
    }

    if (presenceBoost) {
      existingCandidate.presenceFriendIds.add(userId);
      existingCandidate.matchedSignals.add('friend_presence');
    }

    switch (signalType) {
    case 'owned':
      existingCandidate.ownedFriendIds.add(userId);
      existingCandidate.matchedSignals.add('friend_ownership');
      break;
    case 'recent':
      existingCandidate.recentFriendIds.add(userId);
      existingCandidate.matchedSignals.add('recent_friend_activity');
      break;
    case 'liked':
      existingCandidate.likedFriendIds.add(userId);
      existingCandidate.matchedSignals.add('friend_like');
      break;
    case 'highRated':
      existingCandidate.highRatedFriendIds.add(userId);
      existingCandidate.matchedSignals.add('high_friend_rating');
      break;
    default:
      break;
    }

    if (Number.isFinite(rating)) {
      existingCandidate.ratingSum += Number(rating);
      existingCandidate.ratingCount += 1;
    }

    candidateMap.set(key, existingCandidate);
  };

  for (const favorite of visibleFriendFavorites) {
    const preview = buildGamePreviewFromIgdbGame(favorite.gameId, null);
    const key = buildCanonicalGameKey({
      gameSource: 'IGDB',
      externalGameId: favorite.gameId
    });

    upsertCandidate({
      key,
      preview,
      userId: favorite.userId,
      signalType: 'liked'
    });
  }

  for (const review of visibleFriendReviews) {
    const preview = buildGamePreviewFromIgdbGame(review.gameId, null);
    const key = buildCanonicalGameKey({
      gameSource: 'IGDB',
      externalGameId: review.gameId
    });

    upsertCandidate({
      key,
      preview,
      userId: review.userId,
      signalType: Number(review.rating) >= HIGH_RATED_REVIEW_THRESHOLD ? 'highRated' : 'liked',
      rating: Number(review.rating)
    });
  }

  for (const entry of visibleOwnedFriendLibraryEntries) {
    const preview = buildGamePreviewFromLibraryEntry(entry, friendSteamMappings);
    const key = buildCanonicalGameKeyFromLibraryEntry(entry, friendSteamMappings);

    upsertCandidate({
      key,
      preview,
      userId: entry.userId,
      signalType: 'owned'
    });

  }

  for (const entry of visibleRecentFriendLibraryEntries) {
    const preview = buildGamePreviewFromLibraryEntry(entry, friendSteamMappings);
    const key = buildCanonicalGameKeyFromLibraryEntry(entry, friendSteamMappings);

    if (entry.status === 'PLAYING' || entry.lastPlayedAt) {
      upsertCandidate({
        key,
        preview,
        userId: entry.userId,
        signalType: 'recent'
      });
    }
  }

  for (const event of visibleFriendActivityEvents) {
    const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};

    if (
      event.activityType === UserActivityType.LIKED_GAME_REMOVED ||
      event.activityType === UserActivityType.REVIEW_UPDATED
    ) {
      continue;
    }

    const key = buildCanonicalGameKey({
      gameSource: event.gameSource,
      externalGameId: event.externalGameId,
      igdbGameId: event.igdbGameId ?? null
    });

    if (!key) {
      continue;
    }

    const preview = String(event.gameSource ?? '').toUpperCase() === 'STEAM'
      ? {
        gameSource: 'steam',
        externalGameId: event.externalGameId,
        title: metadata.gameName ?? null,
        gameName: metadata.gameName ?? null,
        coverUrl: metadata.coverUrl ?? null,
        igdbGameId: event.igdbGameId ?? null,
        metadataEnriched: Boolean(event.igdbGameId),
        detailAvailable: true
      }
      : buildGamePreviewFromIgdbGame(event.igdbGameId ?? event.externalGameId, null);
    let signalType = 'liked';
    let ratingValue = null;

    if (
      event.activityType === UserActivityType.PLAY_STATUS_CHANGED ||
      event.activityType === UserActivityType.STEAM_RECENTLY_PLAYED_SYNC
    ) {
      if (
        event.activityType === UserActivityType.PLAY_STATUS_CHANGED &&
        String(metadata.nextStatus ?? '').toUpperCase() !== 'PLAYING'
      ) {
        continue;
      }

      signalType = 'recent';
    } else if (
      event.activityType === UserActivityType.REVIEW_CREATED ||
      event.activityType === UserActivityType.RATING_CHANGED
    ) {
      ratingValue = Number(metadata.nextRating ?? metadata.rating ?? NaN);

      if (!Number.isFinite(ratingValue) || ratingValue < 3.5) {
        continue;
      }

      signalType = ratingValue >= HIGH_RATED_REVIEW_THRESHOLD ? 'highRated' : 'liked';
    }

    upsertCandidate({
      key,
      preview,
      userId: event.actorUserId,
      signalType,
      rating: Number.isFinite(ratingValue) ? ratingValue : null,
      activityBoost: true
    });
  }

  for (const [friendUserId, presence] of presenceMap.entries()) {
    if (!presence?.game?.externalGameId || !presence?.game?.gameSource) {
      continue;
    }

    if (presence.state !== 'playing' && presence.state !== 'lastPlayed') {
      continue;
    }

    const key = buildCanonicalGameKey({
      gameSource: presence.game.gameSource,
      externalGameId: presence.game.externalGameId
    });

    upsertCandidate({
      key,
      preview: {
        gameSource: presence.game.gameSource,
        externalGameId: presence.game.externalGameId,
        title: presence.game.title ?? null,
        gameName: presence.game.title ?? null,
        coverUrl: presence.game.coverUrl ?? null,
        igdbGameId: null,
        metadataEnriched: false,
        detailAvailable: true
      },
      userId: friendUserId,
      signalType: 'recent',
      presenceBoost: true
    });
  }

  const igdbCandidateIds = uniqueStringValues(
    [...candidateMap.keys()]
      .filter((key) => key.startsWith('igdb:'))
      .map((key) => key.replace(/^igdb:/, ''))
  );
  const igdbGameMap = await buildIgdbGameMap(igdbCandidateIds);
  const recommendations = [...candidateMap.entries()]
    .map(([key, candidate]) => {
      const resolvedPreview = key.startsWith('igdb:')
        ? buildGamePreviewFromIgdbGame(key.replace(/^igdb:/, ''), igdbGameMap.get(key.replace(/^igdb:/, '')) ?? null)
        : candidate.preview;
      const totalFriends = Math.max(friendIds.length, 1);
      const ownershipSignal = clampNormalizedScore(candidate.ownedFriendIds.size / Math.min(totalFriends, 4));
      const recentSignal = clampNormalizedScore(candidate.recentFriendIds.size / Math.min(totalFriends, 3));
      const likedSignal = clampNormalizedScore(candidate.likedFriendIds.size / Math.min(totalFriends, 4));
      const ratingSignal = candidate.ratingCount > 0
        ? clampNormalizedScore((candidate.ratingSum / candidate.ratingCount - HIGH_RATED_REVIEW_THRESHOLD) / 1)
        : 0;
      const similaritySignal = clampNormalizedScore(candidate.similarityWeightedActions / Math.max(candidate.friendIds.size, 1));
      const activitySignal = clampNormalizedScore(candidate.activityFriendIds.size / Math.min(totalFriends, 3));
      const presenceSignal = clampNormalizedScore(candidate.presenceFriendIds.size / Math.min(totalFriends, 2));
      const recommendationScore = roundNormalizedScore(
        (ownershipSignal * 0.22) +
        (recentSignal * 0.24) +
        (likedSignal * 0.12) +
        (ratingSignal * 0.16) +
        (similaritySignal * 0.18) +
        (activitySignal * 0.05) +
        (presenceSignal * 0.03)
      );
      const matchedSignals = [...candidate.matchedSignals];

      if (similaritySignal >= 0.55) {
        matchedSignals.push('taste_similarity');
      }

      if (resolvedPreview.metadataEnriched) {
        matchedSignals.push('shared_genre');
      }

      if (activitySignal >= 0.34) {
        matchedSignals.push('friend_activity');
      }

      if (presenceSignal >= 0.5) {
        matchedSignals.push('friend_presence');
      }

      return wrapRecommendationGame(resolvedPreview, {
        recommendationScore,
        reason: buildFriendRecommendationReason({
          friendCount: candidate.friendIds.size,
          playingFriendCount: candidate.recentFriendIds.size,
          similarHighRatedCount: candidate.highRatedFriendIds.size
        }),
        friendCount: candidate.friendIds.size,
        matchedSignals: uniqueStringValues(matchedSignals)
      });
    })
    .filter((recommendation) => recommendation.recommendationScore > 0)
    .sort((left, right) => right.recommendationScore - left.recommendationScore)
    .slice(0, limit);

  logger.info('friend-recommendation-candidates', {
    userId: currentUserId,
    friendCount: friendIds.length,
    candidateCount: candidateMap.size,
    recommendationCount: recommendations.length
  });

  return recommendations;
}

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

async function assertNicknameAvailable({ nickname, excludeUserId = null }) {
  const normalizedNickname = typeof nickname === 'string' ? nickname.trim() : '';

  if (!normalizedNickname) {
    return;
  }

  const existingUser = await prisma.user.findFirst({
    where: {
      nickname: normalizedNickname,
      ...(excludeUserId
        ? {
            id: {
              not: excludeUserId
            }
          }
        : {})
    },
    select: {
      id: true
    }
  });

  if (existingUser) {
    throw new AppError(409, 'NICKNAME_ALREADY_EXISTS', 'Nickname already exists');
  }
}

async function safelyDeleteProfileImage(profileImageUrl, context) {
  try {
    // Ownership and containment are proven against the acting user's id; a
    // foreign, other-user, or noncanonical reference is refused, not deleted.
    const outcome = await deleteOwnedProfileImage({
      storedPathname: profileImageUrl,
      userId: context.userId
    });

    if (outcome.status === DELETE_STATUS.DELETED) {
      console.info(
        `[profile-image] cleanup userId=${context.userId} action=${context.action}`
      );
    } else if (outcome.status === DELETE_STATUS.REJECTED) {
      // Sanitized: reason code only, never the URL or resolved path.
      console.warn(
        `[profile-image] cleanup_rejected userId=${context.userId} action=${context.action} reason=${outcome.reason}`
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
  const [friendsCount, reviewCount, favoriteCount, titles, recentPlayedSummary, favoriteGames, reviews, steamLibraryEntries] = await Promise.all([
    getCurrentUserFriendsCount(userId),
    prisma.review.count({
      where: {
        userId
      }
    }),
    prisma.favoriteGame.count({
      where: {
        userId
      }
    }),
    getCurrentUserSelectedTitles(userId),
    buildCurrentUserRecentPlayedSummary(userId),
    prisma.favoriteGame.findMany({
      where: {
        userId
      },
      select: {
        gameId: true
      }
    }),
    prisma.review.findMany({
      where: {
        userId
      },
      select: {
        gameId: true,
        rating: true
      }
    }),
    prisma.userGameLibrary.findMany({
      where: {
        userId
      },
      select: {
        gameSource: true,
        externalGameId: true,
        gameName: true,
        coverUrl: true,
        playtimeMinutes: true,
        lastPlayedAt: true,
        updatedAt: true
      }
    })
  ]);
  const {
    selectedTitleKeys,
    selectedTitles
  } = buildSelectedTitleCollections(titles);
  const profileTags = await buildCurrentUserProfileTags({
    userId,
    favoriteGameIds: favoriteGames.map((game) => game.gameId),
    reviewGameIds: reviews.map((review) => review.gameId),
    steamLibraryEntries
  });
  const availableTitleKeys = deriveAvailableTitleKeys({
    selectedTitleKeys,
    reviewCount,
    likeCount: favoriteCount,
    friendCount: friendsCount,
    profileTags,
    createdAt: user.createdAt,
    playedGameCount: steamLibraryEntries.length
  });
  const selectedTitleKey = deriveSelectedTitleKey({
    explicitSelectedTitleKey: selectedTitleKeys[0] ?? null,
    availableTitleKeys,
    reviewCount,
    likeCount: favoriteCount,
    profileTags
  });
  const selectedTitle = selectedTitleKey
    ? (USER_TITLE_CATALOG.find((title) => title.key === selectedTitleKey)?.label ?? selectedTitleKey)
    : null;
  const fallbackApplied = selectedTitleKeys.length === 0 && Boolean(selectedTitleKey);
  const fallbackReason = fallbackApplied
    ? 'no_explicit_selected_titles'
    : null;
  const resolvedSelectedTitleKeys = selectedTitleKeys.length > 0
    ? selectedTitleKeys
    : (selectedTitleKey ? [selectedTitleKey] : []);
  const resolvedSelectedTitles = selectedTitles.length > 0
    ? selectedTitles
    : (selectedTitle ? [selectedTitle] : []);
  const availableTitles = availableTitleKeys
    .map((titleKey) => USER_TITLE_CATALOG.find((title) => title.key === titleKey))
    .filter(Boolean)
    .map((title) => title.label);

  logger.info('profile-title-derived', {
    userId,
    reviewCount,
    likeCount: favoriteCount,
    tagCount: profileTags.length,
    availableTitleCount: availableTitleKeys.length
  });
  logger.info('profile-title-selected', {
    userId,
    selectedTitleKeys: resolvedSelectedTitleKeys,
    selectedTitles: resolvedSelectedTitles,
    selectedTitleKey,
    selectedTitle,
    explicitSelected: selectedTitleKeys.length > 0,
    fallbackApplied,
    fallbackReason
  });
  logger.info('profile-recent-play-response', {
    userId,
    recentPlayedSource: recentPlayedSummary.recentPlayedSource,
    recentPlayedCount: recentPlayedSummary.recentPlayedCount,
    previewCount: recentPlayedSummary.recentPlayedPreview.length,
    reliableTimestampCount: recentPlayedSummary.recentPlayedPreview.filter((game) => game.hasReliableLastPlayedAt).length,
    noTimestampCount: recentPlayedSummary.recentPlayedPreview.filter((game) => !game.hasReliableLastPlayedAt).length
  });
  logger.info('profile-summary-response', {
    userId,
    selectedTitles: resolvedSelectedTitles,
    selectedTitlesCount: resolvedSelectedTitles.length,
    selectedTitleKey,
    explicitSelected: selectedTitleKeys.length > 0,
    friendCount: friendsCount,
    likeCount: favoriteCount,
    reviewCount,
    selectedTitle,
    availableTitleCount: availableTitleKeys.length,
    recentPlayedSource: recentPlayedSummary.recentPlayedSource,
    recentPlayedCount: recentPlayedSummary.recentPlayedCount,
    tagCount: profileTags.length,
    fallbackApplied,
    fallbackReason
  });

  return {
    user: mapUserToDto(user),
    id: user.id,
    nickname: user.nickname,
    email: user.email,
    bio: null,
    selectedTitle,
    selectedTitleKey,
    selectedTitles: resolvedSelectedTitles,
    selectedTitleKeys: resolvedSelectedTitleKeys,
    availableTitles,
    availableTitleKeys,
    profileTags,
    friendCount: friendsCount,
    likeCount: favoriteCount,
    stats: {
      friendsCount,
      reviewCount,
      favoriteCount
    },
    titles,
    recentlyPlayed: recentPlayedSummary.recentPlayedPreview,
    recentPlayedPreview: recentPlayedSummary.recentPlayedPreview,
    recentPlayedCount: recentPlayedSummary.recentPlayedCount,
    hasMoreRecentPlayed: recentPlayedSummary.hasMoreRecentPlayed
  };
}

async function getMyRecentlyPlayedProfileGames({ userId }) {
  await getEditableCurrentUser(userId);

  return {
    games: await buildCurrentUserRecentlyPlayedGames(userId)
  };
}

async function getMyFriendsCount({ userId }) {
  await getEditableCurrentUser(userId);

  return {
    count: await getCurrentUserFriendsCount(userId)
  };
}

async function getMyTitles({ userId }) {
  await getEditableCurrentUser(userId);
  const titles = await getCurrentUserSelectedTitles(userId);
  const {
    selectedTitleKeys,
    selectedTitles
  } = buildSelectedTitleCollections(titles);

  return {
    titles,
    selectedTitleKeys,
    selectedTitles
  };
}

async function updateMyTitles({ userId, selectedTitleKeys }) {
  await getEditableCurrentUser(userId);
  const requestedTitleKeys = Array.isArray(selectedTitleKeys) ? selectedTitleKeys : [];
  const normalizedRequestedTitleKeys = [...new Set(
    requestedTitleKeys
      .map((titleKey) => String(titleKey).trim())
      .filter((titleKey) => USER_TITLE_KEY_SET.has(titleKey))
  )];
  const normalizedSelectedTitles = normalizedRequestedTitleKeys.slice(0, 1);

  logger.info('profile-title-save-request', {
    userId,
    requestSelectedTitleKeys: requestedTitleKeys,
    requestedCount: requestedTitleKeys.length,
    selectedTitleKey: normalizedSelectedTitles[0] ?? null
  });

  if (normalizedRequestedTitleKeys.length > 1) {
    logger.warn('profile-title-save-truncated', {
      userId,
      requestSelectedTitleKeys: normalizedRequestedTitleKeys,
      keptSelectedTitleKey: normalizedSelectedTitles[0] ?? null
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.userTitle.updateMany({
      where: {
        userId
      },
      data: {
        isSelected: false
      }
    });

    for (const titleKey of normalizedSelectedTitles) {
      await tx.userTitle.upsert({
        where: {
          userId_titleKey: {
            userId,
            titleKey
          }
        },
        update: {
          isSelected: true
        },
        create: {
          userId,
          titleKey,
          isSelected: true
        }
      });
    }
  });

  const titles = await getCurrentUserSelectedTitles(userId);
  const {
    selectedTitleKeys: finalSelectedTitleKeys,
    selectedTitles: selectedTitleLabels
  } = buildSelectedTitleCollections(titles);

  logger.info('profile-title-save-db-final', {
    userId,
    finalSelectedTitleKeys,
    finalSelectedTitles: selectedTitleLabels,
    finalSelectedCount: finalSelectedTitleKeys.length,
    selectedTitleKey: finalSelectedTitleKeys[0] ?? null,
    explicitSelected: finalSelectedTitleKeys.length > 0
  });

  return {
    titles,
    selectedTitleKeys: finalSelectedTitleKeys,
    selectedTitles: selectedTitleLabels
  };
}

async function updateCurrentUserProfile({ userId, nickname, selectedTitleKeys = undefined }) {
  const user = await getEditableCurrentUser(userId);
  const shouldUpdateNickname = typeof nickname === 'string';
  const shouldUpdateTitles = Array.isArray(selectedTitleKeys);
  let updatedUser = user;

  if (shouldUpdateNickname) {
    const normalizedNickname = nickname.trim();

    if (user.nickname !== normalizedNickname) {
      await assertNicknameAvailable({
        nickname: normalizedNickname,
        excludeUserId: userId
      });
    }

    try {
      updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          nickname: normalizedNickname
        }
      });
    } catch (error) {
      if (error?.code === 'P2002') {
        throw new AppError(409, 'NICKNAME_ALREADY_EXISTS', 'Nickname already exists');
      }

      throw error;
    }
  }

  let titleResult = null;

  if (shouldUpdateTitles) {
    titleResult = await updateMyTitles({
      userId,
      selectedTitleKeys
    });
  }

  console.info(`[profile] updated userId=${userId} fields=${[
    shouldUpdateNickname ? 'nickname' : null,
    shouldUpdateTitles ? 'titles' : null
  ].filter(Boolean).join(',')}`);

  return {
    user: mapUserToDto(updatedUser),
    ...(titleResult ?? {})
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

async function searchUsersForFriend({ currentUserId, keyword }) {
  await getEditableCurrentUser(currentUserId);

  const hiddenUserIds = await moderationService.getHiddenUserIds(currentUserId);
  const users = await prisma.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      nickname: {
        contains: keyword.trim(),
        mode: 'insensitive'
      },
      id: {
        notIn: [...hiddenUserIds, currentUserId]
      }
    },
    select: basicUserSelect,
    orderBy: [
      { nickname: 'asc' },
      { createdAt: 'desc' }
    ],
    take: FRIEND_SEARCH_LIMIT
  });
  const userIds = users.map((user) => user.id);

  if (userIds.length === 0) {
    return { users: [] };
  }

  const [friendships, sentRequests, receivedRequests] = await Promise.all([
    prisma.friendship.findMany({
      where: {
        userId: currentUserId,
        friendUserId: { in: userIds }
      },
      select: {
        friendUserId: true
      }
    }),
    prisma.friendRequest.findMany({
      where: {
        fromUserId: currentUserId,
        toUserId: { in: userIds },
        status: FriendRequestStatus.PENDING
      },
      select: {
        toUserId: true
      }
    }),
    prisma.friendRequest.findMany({
      where: {
        fromUserId: { in: userIds },
        toUserId: currentUserId,
        status: FriendRequestStatus.PENDING
      },
      select: {
        fromUserId: true
      }
    })
  ]);
  const friendIds = new Set(friendships.map((friendship) => friendship.friendUserId));
  const pendingSentIds = new Set(sentRequests.map((request) => request.toUserId));
  const pendingReceivedIds = new Set(receivedRequests.map((request) => request.fromUserId));

  return {
    users: users.map((user) => {
      const alreadyFriend = friendIds.has(user.id);
      const pendingSent = pendingSentIds.has(user.id);
      const pendingReceived = pendingReceivedIds.has(user.id);

      return mapUserSearchResult(user, {
        isSelf: false,
        canRequest: !alreadyFriend && !pendingSent && !pendingReceived,
        alreadyFriend,
        pendingSent,
        pendingReceived
      });
    })
  };
}

async function sendFriendRequest({ currentUserId, toUserId }) {
  await getEditableCurrentUser(currentUserId);

  if (currentUserId === toUserId) {
    throw new AppError(400, 'FRIEND_REQUEST_SELF_NOT_ALLOWED', 'You cannot send a friend request to yourself');
  }

  await Promise.all([
    getActiveTargetUser(toUserId),
    ensureNotHiddenRelationship(currentUserId, toUserId)
  ]);

  const [existingFriendship, existingSentRequest, existingReceivedRequest] = await Promise.all([
    getFriendship(currentUserId, toUserId),
    prisma.friendRequest.findFirst({
      where: {
        fromUserId: currentUserId,
        toUserId,
        status: FriendRequestStatus.PENDING
      }
    }),
    prisma.friendRequest.findFirst({
      where: {
        fromUserId: toUserId,
        toUserId: currentUserId,
        status: FriendRequestStatus.PENDING
      }
    })
  ]);

  if (existingFriendship) {
    throw new AppError(409, 'ALREADY_FRIENDS', 'You are already friends with this user');
  }

  if (existingSentRequest) {
    throw new AppError(409, 'FRIEND_REQUEST_ALREADY_SENT', 'A pending friend request already exists');
  }

  if (existingReceivedRequest) {
    throw new AppError(409, 'FRIEND_REQUEST_ALREADY_RECEIVED', 'You already have a pending request from this user');
  }

  const friendRequest = await prisma.friendRequest.create({
    data: {
      fromUserId: currentUserId,
      toUserId,
      status: FriendRequestStatus.PENDING
    },
    include: {
      fromUser: {
        select: basicUserSelect
      },
      toUser: {
        select: basicUserSelect
      }
    }
  });

  logger.info('friend-request-created', {
    userId: currentUserId,
    toUserId,
    requestId: friendRequest.id
  });

  await createNotification({
    userId: toUserId,
    type: 'friend_request_received',
    title: '친구 요청이 도착했어요',
    message: `${friendRequest.fromUser.nickname}님이 친구 요청을 보냈어요`
  });

  return {
    friendRequest: mapFriendRequestDto(friendRequest)
  };
}

async function getReceivedFriendRequests({ currentUserId }) {
  await getEditableCurrentUser(currentUserId);

  const requests = await prisma.friendRequest.findMany({
    where: {
      toUserId: currentUserId,
      status: FriendRequestStatus.PENDING
    },
    orderBy: [{ createdAt: 'desc' }],
    include: {
      fromUser: {
        select: basicUserSelect
      },
      toUser: {
        select: basicUserSelect
      }
    }
  });

  return {
    friendRequests: requests.map(mapFriendRequestDto)
  };
}

async function getSentFriendRequests({ currentUserId }) {
  await getEditableCurrentUser(currentUserId);

  const requests = await prisma.friendRequest.findMany({
    where: {
      fromUserId: currentUserId,
      status: FriendRequestStatus.PENDING
    },
    orderBy: [{ createdAt: 'desc' }],
    include: {
      fromUser: {
        select: basicUserSelect
      },
      toUser: {
        select: basicUserSelect
      }
    }
  });

  return {
    friendRequests: requests.map(mapFriendRequestDto)
  };
}

async function acceptFriendRequest({ currentUserId, requestId }) {
  const friendRequest = await prisma.friendRequest.findUnique({
    where: { id: requestId },
    include: {
      fromUser: {
        select: basicUserSelect
      },
      toUser: {
        select: basicUserSelect
      }
    }
  });

  if (!friendRequest) {
    throw new AppError(404, 'FRIEND_REQUEST_NOT_FOUND', 'Friend request could not be found');
  }

  if (friendRequest.toUserId !== currentUserId) {
    throw new AppError(403, 'FRIEND_REQUEST_FORBIDDEN', 'You cannot accept this friend request');
  }

  if (friendRequest.status !== FriendRequestStatus.PENDING) {
    throw new AppError(409, 'FRIEND_REQUEST_NOT_PENDING', 'This friend request is no longer pending');
  }

  await prisma.$transaction([
    prisma.friendRequest.update({
      where: { id: requestId },
      data: {
        status: FriendRequestStatus.ACCEPTED
      }
    }),
    prisma.friendship.upsert({
      where: {
        userId_friendUserId: {
          userId: friendRequest.fromUserId,
          friendUserId: friendRequest.toUserId
        }
      },
      update: {},
      create: {
        userId: friendRequest.fromUserId,
        friendUserId: friendRequest.toUserId
      }
    }),
    prisma.friendship.upsert({
      where: {
        userId_friendUserId: {
          userId: friendRequest.toUserId,
          friendUserId: friendRequest.fromUserId
        }
      },
      update: {},
      create: {
        userId: friendRequest.toUserId,
        friendUserId: friendRequest.fromUserId
      }
    })
  ]);

  logger.info('friend-request-accepted', {
    userId: currentUserId,
    requestId,
    fromUserId: friendRequest.fromUserId
  });

  await createNotification({
    userId: friendRequest.fromUserId,
    type: 'friend_request_accepted',
    title: '친구 요청이 수락되었어요',
    message: `${friendRequest.toUser.nickname}님과 이제 친구예요`
  });

  return {
    accepted: true,
    friendRequestId: requestId,
    friendUserId: friendRequest.fromUserId
  };
}

async function rejectFriendRequest({ currentUserId, requestId }) {
  const friendRequest = await prisma.friendRequest.findUnique({
    where: { id: requestId }
  });

  if (!friendRequest) {
    throw new AppError(404, 'FRIEND_REQUEST_NOT_FOUND', 'Friend request could not be found');
  }

  if (friendRequest.toUserId !== currentUserId) {
    throw new AppError(403, 'FRIEND_REQUEST_FORBIDDEN', 'You cannot reject this friend request');
  }

  if (friendRequest.status !== FriendRequestStatus.PENDING) {
    throw new AppError(409, 'FRIEND_REQUEST_NOT_PENDING', 'This friend request is no longer pending');
  }

  await prisma.friendRequest.update({
    where: { id: requestId },
    data: {
      status: FriendRequestStatus.REJECTED
    }
  });

  logger.info('friend-request-rejected', {
    userId: currentUserId,
    requestId,
    fromUserId: friendRequest.fromUserId
  });

  return {
    rejected: true,
    friendRequestId: requestId
  };
}

async function cancelFriendRequest({ currentUserId, requestId }) {
  const friendRequest = await prisma.friendRequest.findUnique({
    where: { id: requestId }
  });

  if (!friendRequest) {
    throw new AppError(404, 'FRIEND_REQUEST_NOT_FOUND', 'Friend request could not be found');
  }

  if (friendRequest.fromUserId !== currentUserId) {
    throw new AppError(403, 'FRIEND_REQUEST_FORBIDDEN', 'You can only cancel your own friend request');
  }

  if (friendRequest.status !== FriendRequestStatus.PENDING) {
    throw new AppError(409, 'FRIEND_REQUEST_NOT_PENDING', 'This friend request is no longer pending');
  }

  await prisma.friendRequest.update({
    where: { id: requestId },
    data: {
      status: FriendRequestStatus.CANCELED
    }
  });

  logger.info('friend-request-canceled', {
    userId: currentUserId,
    requestId,
    toUserId: friendRequest.toUserId
  });

  return {
    canceled: true,
    friendRequestId: requestId
  };
}

async function getMyFriends({ currentUserId }) {
  await getEditableCurrentUser(currentUserId);

  const friendships = await prisma.friendship.findMany({
    where: {
      userId: currentUserId
    },
    orderBy: [{ createdAt: 'desc' }],
    include: {
      friend: {
        select: basicUserSelect
      }
    }
  });

  logger.info('friendship-list-returned', {
    endpoint: 'GET /users/me/friends',
    userId: currentUserId,
    friendCount: friendships.length,
    isEmpty: friendships.length === 0
  });

  return {
    friends: friendships.map(mapFriendshipDto)
  };
}

async function removeFriend({ currentUserId, friendUserId }) {
  await getEditableCurrentUser(currentUserId);
  await getActiveTargetUser(friendUserId);
  await ensureNotHiddenRelationship(currentUserId, friendUserId).catch(() => null);

  if (currentUserId === friendUserId) {
    throw new AppError(400, 'FRIEND_REMOVE_SELF_NOT_ALLOWED', 'You cannot remove yourself from friends');
  }

  const deleteResult = await prisma.$transaction([
    prisma.friendship.deleteMany({
      where: {
        OR: [
          {
            userId: currentUserId,
            friendUserId
          },
          {
            userId: friendUserId,
            friendUserId: currentUserId
          }
        ]
      }
    }),
    prisma.friendRequest.updateMany({
      where: {
        status: 'PENDING',
        OR: [
          {
            fromUserId: currentUserId,
            toUserId: friendUserId
          },
          {
            fromUserId: friendUserId,
            toUserId: currentUserId
          }
        ]
      },
      data: {
        status: 'CANCELED'
      }
    })
  ]);

  logger.info('friend-removed', {
    userId: currentUserId,
    friendUserId,
    removedFriendshipCount: deleteResult[0].count
  });

  return {
    removed: true,
    friendUserId
  };
}

async function getMyBlocks({ currentUserId }) {
  await getEditableCurrentUser(currentUserId);

  const blocks = await prisma.userBlock.findMany({
    where: {
      userId: currentUserId
    },
    orderBy: [{ createdAt: 'desc' }],
    include: {
      blockedUser: {
        select: basicUserSelect
      }
    }
  });

  return {
    blocks: blocks.map((block) => ({
      createdAt: block.createdAt,
      user: mapBasicUserProfile(block.blockedUser)
    }))
  };
}

async function blockUserForCurrentUser({ currentUserId, blockedUserId }) {
  await getEditableCurrentUser(currentUserId);

  const result = await moderationService.blockUser({
    userId: currentUserId,
    blockedUserId
  });

  logger.info('user-block-created', {
    userId: currentUserId,
    blockedUserId
  });

  return result;
}

async function unblockUserForCurrentUser({ currentUserId, blockedUserId }) {
  await getEditableCurrentUser(currentUserId);

  const result = await moderationService.unblockUser({
    userId: currentUserId,
    blockedUserId
  });

  logger.info('user-block-removed', {
    userId: currentUserId,
    blockedUserId
  });

  return result;
}

async function getMyPrivacySettings({ currentUserId }) {
  await getEditableCurrentUser(currentUserId);
  const { settings, created, source } = await getOrCreatePrivacySettings(currentUserId, {
    withMeta: true
  });
  const response = buildPrivacySettingsResponse(settings);

  logger.info('user-privacy-fetched', {
    userId: currentUserId,
    source,
    created,
    ...response.privacy
  });

  return response;
}

async function updateMyPrivacySettings({ currentUserId, privacySettings }) {
  await getEditableCurrentUser(currentUserId);
  const settings = await prisma.userPrivacySettings.upsert({
    where: {
      userId: currentUserId
    },
    update: privacySettings,
    create: {
      userId: currentUserId,
      ...defaultPrivacySettings,
      ...privacySettings
    },
    select: privacySettingsSelect
  });

  logger.info('user-privacy-updated', {
    userId: currentUserId,
    ...mapPrivacySettingsDto(settings)
  });

  return buildPrivacySettingsResponse(settings);
}

async function getFriendProfile({ currentUserId, targetUserId }) {
  const { targetUser, friendship, isSelf } = await assertFriendAccess({
    currentUserId,
    targetUserId
  });
  const privacySettings = await getOrCreatePrivacySettings(targetUserId);
  const [tasteContextResult, previewResult, writtenReviewsResult, sharedGamesResult, friendRecommendationsResult, currentSteamAccountResult, targetSteamAccountResult, presenceResult] = await Promise.allSettled([
    buildTasteSimilarityContext(currentUserId, targetUserId),
    buildFriendPreviewPayload(targetUserId),
    privacySettings.showReviews
      ? buildFriendWrittenReviewsPreview(targetUserId, FRIEND_PROFILE_PREVIEW_LIMIT)
      : Promise.resolve([]),
    buildSharedGamesResult({
      currentUserId,
      targetUserId,
      limit: FRIEND_PROFILE_PREVIEW_LIMIT
    }),
    buildFriendRecommendations({
      currentUserId,
      friendIds: [targetUserId],
      limit: FRIEND_PROFILE_PREVIEW_LIMIT
    }),
    getSteamSocialAccount(currentUserId),
    getSteamSocialAccount(targetUserId),
    userPresenceService.derivePresenceForUser(targetUserId)
  ]);
  const degradedSections = [];
  const preview = previewResult.status === 'fulfilled'
    ? previewResult.value
    : (degradedSections.push('library_preview'), { recentlyPlayed: [], liked: [], reviews: [] });
  const writtenReviews = writtenReviewsResult.status === 'fulfilled'
    ? writtenReviewsResult.value
    : (degradedSections.push('written_reviews'), []);
  const sharedGamesPayload = sharedGamesResult.status === 'fulfilled'
    ? sharedGamesResult.value
    : (degradedSections.push('shared_games'), {
      sharedGames: [],
      sharedGamesLimitedByPrivacy: !privacySettings.showRecentlyPlayed,
      recentPlayedAvailable: privacySettings.showRecentlyPlayed,
      steamFriendsAvailable: false
    });
  const friendRecommendations = friendRecommendationsResult.status === 'fulfilled'
    ? friendRecommendationsResult.value
    : (degradedSections.push('friend_recommendations'), []);
  let tasteSimilarity = null;
  let tasteProfile = {
    similarityScore: 0,
    topGenres: [],
    topTags: [],
    overlap: {
      likedGamesCount: 0,
      reviewedGamesCount: 0,
      highRatedGamesCount: 0,
      sharedLibraryCount: 0,
      recentPlayedCount: 0
    },
    summary: '취향 정보를 아직 충분히 계산하지 못했어요',
    matchedSignals: []
  };
  let commonLikedGames = [];
  let commonHighlyRatedGames = [];
  let commonInterestGames = [];

  if (tasteContextResult.status === 'fulfilled') {
    const tasteContext = tasteContextResult.value;
    const similarityResult = buildTasteSimilarityResult(tasteContext);

    tasteSimilarity = {
      percentage: similarityResult.similarityScore,
      summary: similarityResult.explanation
    };
    tasteProfile = buildTasteProfileResult(tasteContext);
    const commonLikedGameIds = tasteContext.currentLikedIds.filter((gameId) => tasteContext.targetLikedIds.includes(gameId));
    const commonHighRatedGameIds = tasteContext.currentHighRatedIds.filter((gameId) => tasteContext.targetHighRatedIds.includes(gameId));
    commonLikedGames = commonLikedGameIds
      .slice(0, FRIEND_PROFILE_PREVIEW_LIMIT)
      .map((gameId) => buildGamePreviewFromIgdbGame(gameId, tasteContext.igdbGameMap.get(gameId) ?? null));
    commonHighlyRatedGames = commonHighRatedGameIds
      .slice(0, FRIEND_PROFILE_PREVIEW_LIMIT)
      .map((gameId) => buildGamePreviewFromIgdbGame(gameId, tasteContext.igdbGameMap.get(gameId) ?? null));
    commonInterestGames = (sharedGamesPayload.sharedGames ?? [])
      .slice(0, FRIEND_PROFILE_PREVIEW_LIMIT)
      .map((item) => item.game ?? item)
      .filter(Boolean);
  } else {
    degradedSections.push('taste_profile');
  }
  const currentSteamAccount = currentSteamAccountResult.status === 'fulfilled' ? currentSteamAccountResult.value : null;
  const targetSteamAccount = targetSteamAccountResult.status === 'fulfilled' ? targetSteamAccountResult.value : null;
  const presence = presenceResult.status === 'fulfilled' ? presenceResult.value : null;
  const steamFriendsContext = {
    steamFriendsAvailable: Boolean(currentSteamAccount && targetSteamAccount && steamService.isSteamSyncConfigured()),
    sharedGamesLimitedByPrivacy: Boolean(sharedGamesPayload.sharedGamesLimitedByPrivacy),
    recentPlayedAvailable: Boolean(sharedGamesPayload.recentPlayedAvailable)
  };

  logger.info('friend-profile-accessed', {
    userId: currentUserId,
    targetUserId,
    section: 'profile',
    isSelf,
    degradedSections
  });

  return {
    user: {
      ...mapBasicUserProfile(targetUser),
      isMe: isSelf,
      areFriends: Boolean(isSelf || friendship),
      friendSince: friendship?.createdAt ?? null,
      privacy: mapPrivacySettingsDto(privacySettings),
      presence
    },
    tasteSimilarity,
    tasteProfile,
    sharedGames: sharedGamesPayload.sharedGames ?? [],
    sharedLikedGames: commonLikedGames,
    commonLikedGames,
    commonInterestGames,
    bothHighlyRatedGames: commonHighlyRatedGames,
    commonHighlyRatedGames,
    recentlyPlayed: privacySettings.showRecentlyPlayed ? preview.recentlyPlayed : [],
    recentPlayedGames: privacySettings.showRecentlyPlayed ? preview.recentlyPlayed : [],
    likedGames: privacySettings.showLikedGames ? preview.liked : [],
    reviews: privacySettings.showReviews ? writtenReviews : [],
    writtenReviews: privacySettings.showReviews ? writtenReviews : [],
    friendRecommendations,
    steamFriendsContext
  };
}

async function getFriendLibraryPreview({ currentUserId, targetUserId }) {
  const { privacySettings } = await assertFriendAccess({
    currentUserId,
    targetUserId
  });
  const resolvedPrivacySettings = await getOrCreatePrivacySettings(targetUserId);
  const privacy = privacySettings ?? resolvedPrivacySettings;
  const preview = await buildFriendPreviewPayload(targetUserId);
  const visibleRecentlyPlayed = privacy.showRecentlyPlayed ? preview.recentlyPlayed : [];
  const visibleLiked = privacy.showLikedGames ? preview.liked : [];

  logger.info('friend-profile-accessed', {
    userId: currentUserId,
    targetUserId,
    section: 'library_preview',
    recentlyPlayedCount: visibleRecentlyPlayed.length,
    likedCount: visibleLiked.length
  });

  return {
    recentlyPlayed: visibleRecentlyPlayed,
    liked: visibleLiked
  };
}

async function getFriendReviewsPreview({ currentUserId, targetUserId }) {
  await assertFriendSectionAccess({
    currentUserId,
    targetUserId,
    settingKey: 'showReviews',
    errorCode: 'REVIEWS_HIDDEN',
    errorMessage: 'This user hides their reviews'
  });

  const preview = await buildFriendPreviewPayload(targetUserId);

  logger.info('friend-profile-accessed', {
    userId: currentUserId,
    targetUserId,
    section: 'reviews_preview',
    reviewCount: preview.reviews.length
  });

  return {
    reviews: preview.reviews
  };
}

async function getMyFriendsActivity({ currentUserId, cursor = null, limit = FRIEND_ACTIVITY_LIMIT }) {
  await getEditableCurrentUser(currentUserId);

  const result = await userActivityService.getFriendActivityFeed({
    currentUserId,
    cursor,
    limit
  });

  logger.info('friend-activity-query', {
    userId: currentUserId,
    activityCount: result.activities.length,
    nextCursor: result.nextCursor ?? null
  });

  return result;
}

async function getMySteamFriends({ currentUserId }) {
  return buildSteamFriendsResponse({ currentUserId });
}

async function getTasteSimilarity({ currentUserId, targetUserId }) {
  const tasteContext = await buildTasteSimilarityContext(currentUserId, targetUserId);
  const result = buildTasteSimilarityResult(tasteContext);

  logger.info('friend-similarity-query', {
    userId: currentUserId,
    targetUserId,
    similarityScore: result.similarityScore,
    matchedSignalCount: result.matchedSignals.length
  });

  return {
    similarityScore: result.similarityScore,
    explanation: result.explanation,
    matchedSignals: result.matchedSignals
  };
}

async function getTasteProfile({ currentUserId, targetUserId }) {
  const tasteContext = await buildTasteSimilarityContext(currentUserId, targetUserId);
  const tasteProfile = buildTasteProfileResult(tasteContext);

  logger.info('friend-taste-profile-query', {
    userId: currentUserId,
    targetUserId,
    similarityScore: tasteProfile.similarityScore,
    topGenreCount: tasteProfile.topGenres.length,
    topTagCount: tasteProfile.topTags.length
  });

  return tasteProfile;
}

async function getCommonInterests({ currentUserId, targetUserId }) {
  const tasteContext = await buildTasteSimilarityContext(currentUserId, targetUserId);
  const commonLikedGameIds = tasteContext.currentLikedIds.filter((gameId) => tasteContext.targetLikedIds.includes(gameId));
  const commonHighRatedGameIds = tasteContext.currentHighRatedIds.filter((gameId) => tasteContext.targetHighRatedIds.includes(gameId));
  const commonGenres = buildCommonGenres(tasteContext.currentGenreMap, tasteContext.targetGenreMap);

  logger.info('friend-common-interests-query', {
    userId: currentUserId,
    targetUserId,
    commonLikedCount: commonLikedGameIds.length,
    commonHighRatedCount: commonHighRatedGameIds.length,
    commonGenreCount: commonGenres.length
  });

  return {
    commonLikedGames: commonLikedGameIds
      .slice(0, FRIEND_COMMON_INTEREST_LIMIT)
      .map((gameId) => buildGamePreviewFromIgdbGame(gameId, tasteContext.igdbGameMap.get(gameId) ?? null)),
    commonHighlyRatedGames: commonHighRatedGameIds
      .slice(0, FRIEND_COMMON_INTEREST_LIMIT)
      .map((gameId) => buildGamePreviewFromIgdbGame(gameId, tasteContext.igdbGameMap.get(gameId) ?? null)),
    commonGenres
  };
}

async function getSharedGames({ currentUserId, targetUserId }) {
  return buildSharedGamesResult({
    currentUserId,
    targetUserId
  });
}

async function getMyFriendRecommendations({ currentUserId }) {
  await getEditableCurrentUser(currentUserId);

  const friendIds = await getFriendIds(currentUserId);

  if (friendIds.length === 0) {
    logger.info('friend-recommendation-query', {
      userId: currentUserId,
      friendCount: 0,
      recommendationCount: 0,
      appFriendRecommendationCount: 0,
      steamRecommendationCount: 0,
      fallbackUsed: false,
      finalSourceSelected: 'none'
    });

    return {
      recommendations: []
    };
  }
  const recommendations = await buildFriendRecommendations({
    currentUserId,
    friendIds,
    limit: FRIEND_RECOMMENDATION_LIMIT
  });

  logger.info('friend-recommendation-query', {
    userId: currentUserId,
    friendCount: friendIds.length,
    candidateCount: recommendations.length,
    recommendationCount: recommendations.length,
    appFriendRecommendationCount: recommendations.length,
    steamRecommendationCount: 0,
    fallbackUsed: false,
    finalSourceSelected: 'app_friends'
  });

  return {
    recommendations
  };
}

async function getMyFriendActivityWidgetSummary({ currentUserId }) {
  await getEditableCurrentUser(currentUserId);

  const summary = await userActivityService.getFriendActivitySummary({
    currentUserId
  });

  logger.info('friend-activity-widget-query', {
    userId: currentUserId,
    activityCount: summary.activities.length,
    totalRecentActivities: summary.totalRecentActivities
  });

  return summary;
}

async function getMyRecommendationWidgetSummary({ currentUserId }) {
  await getEditableCurrentUser(currentUserId);

  const cacheKey = `recommendation-widget:${currentUserId}`;
  const cachedValue = getCachedValue(recommendationWidgetCache, cacheKey);

  if (cachedValue) {
    return cachedValue;
  }

  const recommendationResult = await getMyFriendRecommendations({
    currentUserId
  });
  const result = {
    generatedAt: new Date().toISOString(),
    recommendations: (recommendationResult.recommendations ?? []).slice(0, 4)
  };

  setCachedValue(recommendationWidgetCache, cacheKey, result, RECOMMENDATION_WIDGET_CACHE_TTL_MS);

  logger.info('friend-recommendation-widget-query', {
    userId: currentUserId,
    recommendationCount: result.recommendations.length
  });

  return result;
}

async function getUserPresence({ currentUserId, targetUserId }) {
  if (currentUserId !== targetUserId) {
    await assertFriendAccess({
      currentUserId,
      targetUserId
    });
  } else {
    await getEditableCurrentUser(currentUserId);
  }

  const presence = await userPresenceService.derivePresenceForUser(targetUserId);

  logger.info('friend-presence-query', {
    userId: currentUserId,
    targetUserId,
    state: presence.state,
    source: presence.source
  });

  return {
    userId: targetUserId,
    presence
  };
}

async function getMyNotifications({ userId, page = 1, limit = NOTIFICATIONS_DEFAULT_LIMIT }) {
  await getEditableCurrentUser(userId);

  const resolvedPage = normalizePositiveInteger(page, 1);
  const resolvedLimit = Math.min(
    normalizePositiveInteger(limit, NOTIFICATIONS_DEFAULT_LIMIT),
    NOTIFICATIONS_MAX_LIMIT
  );
  const skip = (resolvedPage - 1) * resolvedLimit;
  const [notifications, totalCount, unreadCount] = await Promise.all([
    prisma.userNotification.findMany({
      where: { userId },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' }
      ],
      skip,
      take: resolvedLimit
    }),
    prisma.userNotification.count({
      where: { userId }
    }),
    prisma.userNotification.count({
      where: {
        userId,
        isRead: false
      }
    })
  ]);

  return {
    notifications: notifications.map(mapNotificationToDto),
    unreadCount,
    meta: {
      page: resolvedPage,
      limit: resolvedLimit,
      totalCount,
      totalPages: totalCount > 0 ? Math.ceil(totalCount / resolvedLimit) : 0
    }
  };
}

async function markNotificationsRead({ userId, ids }) {
  await getEditableCurrentUser(userId);

  const now = new Date();
  const result = await prisma.userNotification.updateMany({
    where: {
      userId,
      id: {
        in: ids
      },
      isRead: false
    },
    data: {
      isRead: true,
      readAt: now
    }
  });

  logger.info('notification-read', {
    userId,
    targetCount: ids.length,
    updatedCount: result.count
  });

  return {
    updatedCount: result.count
  };
}

async function markAllNotificationsRead({ userId }) {
  await getEditableCurrentUser(userId);

  const now = new Date();
  const result = await prisma.userNotification.updateMany({
    where: {
      userId,
      isRead: false
    },
    data: {
      isRead: true,
      readAt: now
    }
  });

  logger.info('notification-read-all', {
    userId,
    updatedCount: result.count
  });

  return {
    updatedCount: result.count
  };
}

module.exports = {
  acceptFriendRequest,
  blockUserForCurrentUser,
  cancelFriendRequest,
  getCurrentUserProfile,
  getCommonInterests,
  getFriendLibraryPreview,
  getFriendProfile,
  getFriendReviewsPreview,
  getMyBlocks,
  getMyFriendActivityWidgetSummary,
  getMyFriends,
  getMyFriendsCount,
  getMyFriendsActivity,
  getMyRecentlyPlayedProfileGames,
  getMySteamFriends,
  getMyFriendRecommendations,
  getMyRecommendationWidgetSummary,
  getMyNotifications,
  getMyPrivacySettings,
  getMyTitles,
  getReceivedFriendRequests,
  getSentFriendRequests,
  getSharedGames,
  getTasteProfile,
  getTasteSimilarity,
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
