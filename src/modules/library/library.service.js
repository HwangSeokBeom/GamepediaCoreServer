const { GameLibraryStatus, GameSource, SteamIgdbMatchStatus } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const favoriteService = require('../favorite/favorite.service');
const igdbService = require('../igdb/igdb.service');
const reviewService = require('../review/review.service');
const steamService = require('../../services/steam.service');
const userActivityService = require('../user/user-activity.service');
const userPresenceService = require('../user/user-presence.service');
const { USER_ACTIVITY_TYPE } = require('../user/user-social.constants');
const {
  buildGameImageResolverUrl,
  extractUsableIgdbCoverUrl
} = require('./library-image.service');
const steamIgdbMatchService = require('./steam-igdb-match.service');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/error-response');
const {
  mapLibraryStatusEntry,
  mapReviewedItem,
  resolveSteamEnrichmentStatus,
  mapSteamLinkStatus,
  mapWishlistItem
} = require('./library.mapper');
const { normalizeRedirectBaseUrl } = require('./library.redirect');
const {
  buildNormalizedSetCacheKey,
  memoizeLibraryRequestPromise
} = require('./library-request-context');

const steamAccountSelect = {
  id: true,
  userId: true,
  providerSubject: true,
  personaName: true,
  profileUrl: true,
  avatarUrl: true,
  lastSteamSyncAt: true,
  steamRecentPlayedSnapshot: true,
  linkedAt: true
};

const sourceMap = {
  steam: GameSource.STEAM,
  igdb: GameSource.IGDB
};

const statusMap = {
  playing: GameLibraryStatus.PLAYING,
  backlog: GameLibraryStatus.BACKLOG,
  completed: GameLibraryStatus.COMPLETED,
  dropped: GameLibraryStatus.DROPPED
};
const LIBRARY_PREVIEW_LIMITS = {
  recentlyPlayed: 4,
  playing: 3,
  owned: 3,
  liked: 3,
  reviews: 3,
  friendRecommendations: 4,
  playtimeRecommendations: 4
};
const LIBRARY_FULL_DEFAULT_LIMIT = 20;
const LIBRARY_FULL_MAX_LIMIT = 50;
const STEAM_RECENTLY_PLAYED_LIVE_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const LIBRARY_SUMMARY_TAB = {
  PLAYING: 'playing',
  LIKED: 'liked',
  REVIEWED: 'reviewed'
};
const LIBRARY_SUMMARY_SOURCE = {
  [LIBRARY_SUMMARY_TAB.PLAYING]: 'play',
  [LIBRARY_SUMMARY_TAB.LIKED]: 'liked',
  [LIBRARY_SUMMARY_TAB.REVIEWED]: 'review'
};
const STEAM_FALLBACK_DESCRIPTION = 'Steam에서 가져온 게임입니다.';
const STEAM_SYNC_STATUS = {
  IDLE: 'idle',
  SYNCING: 'syncing',
  FAILED: 'failed',
  PRIVATE_PROFILE: 'private_profile',
  SUCCESS: 'success',
  TOKEN_EXPIRED: 'token_expired',
  NOT_CONNECTED: 'not_connected'
};

const STEAM_PRIVATE_PROFILE_WARNING_CODES = new Set([
  'STEAM_RECENTLY_PLAYED_UNAVAILABLE',
  'STEAM_OWNED_GAMES_UNAVAILABLE'
]);

const STEAM_TOKEN_EXPIRED_ERROR_CODES = new Set([
  'STEAM_CONNECTION_EXPIRED',
  'STEAM_ID_INVALID',
  'STEAM_PROFILE_NOT_FOUND'
]);
const STEAM_TAG_GENRE_MAP = new Map([
  ['action', '액션'],
  ['adventure', '어드벤처'],
  ['rpg', 'RPG'],
  ['roleplaying', 'RPG'],
  ['strategy', '전략'],
  ['simulation', '시뮬레이션'],
  ['simulator', '시뮬레이션'],
  ['survival', '생존'],
  ['indie', '인디'],
  ['casual', '캐주얼'],
  ['horror', '공포'],
  ['shooter', '슈팅'],
  ['multiplayer', '멀티플레이'],
  ['multiplayergame', '멀티플레이'],
  ['coop', '멀티플레이'],
  ['onlinecoop', '멀티플레이'],
  ['onlinepvp', '멀티플레이']
]);
const STEAM_FRIEND_RECOMMENDATION_LIMIT = 10;
const STEAM_FRIEND_RECOMMENDATION_FRIEND_LIMIT = 12;
const STEAM_FRIEND_RECOMMENDATION_METADATA_LIMIT = 15;
const STEAM_FRIEND_ACTIVITY_FETCH_CONCURRENCY = 4;
const STEAM_STORE_TAG_FETCH_CONCURRENCY = 4;
const IN_APP_FRIEND_RECOMMENDATION_LIMIT = 12;
// Keep these diagnostic thresholds aligned with steam-igdb-match.service.js.
const STEAM_IGDB_CONFIRMED_THRESHOLD = 0.90;
const STEAM_IGDB_CANDIDATE_THRESHOLD = 0.78;
const PLAYTIME_RECOMMENDATION_LIMIT = 10;
const PLAYTIME_RECOMMENDATION_CANDIDATE_LIMIT = 60;
const PLAYTIME_PROFILE_TOP_LIFETIME_COUNT = 6;
const PLAYTIME_PROFILE_TOP_RECENT_COUNT = 4;
const STEAM_MULTIPLAYER_TAG_KEYS = new Set([
  'multiplayer',
  'multiplayergame',
  'onlinepvp',
  'crossplatformmultiplayer',
  'sharedsplitscreen',
  'lanpvp'
]);
const STEAM_COOP_TAG_KEYS = new Set([
  'coop',
  'onlinecoop',
  'localcoop',
  'sharedsplitscreen',
  'crossplatformmultiplayer'
]);
const LONG_PACE_TAG_KEYS = new Set([
  'strategy',
  'simulation',
  'simulator',
  'rpg',
  'roleplaying',
  'survival',
  'openworld',
  'citybuilder',
  'grandstrategy'
]);
const SHORT_PACE_TAG_KEYS = new Set([
  'action',
  'shooter',
  'casual',
  'arcade',
  'party',
  'fighting',
  'horror'
]);
const activeSteamSyncUserIds = new Set();
const activeOwnedGamesFetches = new Map();
const activeRecentlyPlayedFetches = new Map();
const activeSteamSyncMarkPromises = new Map();
const activeIgdbBatchPromises = new Map();
const FRIEND_RECOMMENDATION_SOURCE = {
  IN_APP: 'inAppFriends',
  STEAM: 'steamFriends',
  NONE: 'none'
};
const FRIEND_RECOMMENDATION_EMPTY_REASON = {
  NO_APP_FRIENDS_AND_NO_STEAM: 'NO_APP_FRIENDS_AND_NO_STEAM',
  APP_FRIENDS_BUT_NOT_ENOUGH_ACTIVITY: 'APP_FRIENDS_BUT_NOT_ENOUGH_ACTIVITY',
  STEAM_FRIENDS_UNAVAILABLE_OR_PRIVATE: 'STEAM_FRIENDS_UNAVAILABLE_OR_PRIVATE',
  NO_RECOMMENDATION_DATA: 'NO_RECOMMENDATION_DATA'
};
const DEFAULT_FRIEND_PRIVACY_SETTINGS = {
  showRecentlyPlayed: true,
  showLikedGames: true,
  showReviews: true
};
const TARGET_STEAM_DEBUG_APP_IDS = new Set(['3321460']);
const STEAM_PRESENCE_SOURCES = [
  'steam_sync',
  'steam_recent_sync',
  'steam_library_sync',
  'steam_library_status'
];
const LIBRARY_RECENTLY_PLAYED_FALLBACK_CANDIDATE_LIMIT = 24;

function resolveTargetSteamMappingRejectedReason({
  mappingRowExists,
  igdbGameId,
  matchStatus,
  mappingAccepted
}) {
  if (!mappingRowExists) {
    return 'missing_local_mapping_row';
  }

  if (!igdbGameId) {
    return 'missing_igdb_game_id';
  }

  if (mappingAccepted) {
    return null;
  }

  if (matchStatus === 'CANDIDATE') {
    return 'confidence_below_confirmed_threshold';
  }

  if (matchStatus === 'UNMATCHED') {
    return 'marked_unmatched';
  }

  if (matchStatus === 'REJECTED') {
    return 'marked_rejected';
  }

  if (matchStatus) {
    return `unsupported_match_status_${String(matchStatus).toLowerCase()}`;
  }

  return 'rejected_by_acceptance_rule';
}

function logTargetSteamAppIdDebugSummary({
  userId = null,
  stage = null,
  context,
  externalGameId,
  rawSteamTitle = null,
  normalizedSteamTitle = null,
  mappingRow = null,
  mappingAccepted = false,
  cachedIgdbDetailExists = false,
  liveIgdbDetailAttempted = false,
  liveIgdbDetailFound = false,
  finalEnrichmentStatus = null,
  finalFallbackReason = null,
  steamOnlyFallbackCacheExists = false,
  steamOnlyFallbackCacheRead = false
}) {
  if (!TARGET_STEAM_DEBUG_APP_IDS.has(typeof externalGameId === 'string' ? externalGameId.trim() : '')) {
    return;
  }

  logger.info('steam-appid-3321460-debug', {
    userId,
    stage,
    context,
    externalGameId,
    rawSteamTitle: rawSteamTitle ?? null,
    normalizedSteamTitle: normalizedSteamTitle ?? null,
    mappingRowExists: Boolean(mappingRow),
    mappingRow: mappingRow
      ? {
        steamAppId: mappingRow.steamAppId ?? externalGameId ?? null,
        igdbGameId: mappingRow.igdbGameId ?? null,
        matchedTitle: mappingRow.matchedTitle ?? null,
        matchStatus: mappingRow.matchStatus ?? null,
        confidenceScore: typeof mappingRow.confidenceScore === 'number'
          ? Number(mappingRow.confidenceScore)
          : null
      }
      : null,
    mappingAccepted,
    mappingRejectedReason: resolveTargetSteamMappingRejectedReason({
      mappingRowExists: Boolean(mappingRow),
      igdbGameId: mappingRow?.igdbGameId ?? null,
      matchStatus: mappingRow?.matchStatus ?? null,
      mappingAccepted
    }),
    cachedIgdbDetailExists: Boolean(cachedIgdbDetailExists),
    liveIgdbDetailAttempted: Boolean(liveIgdbDetailAttempted),
    liveIgdbDetailFound: Boolean(liveIgdbDetailFound),
    finalEnrichmentStatus: finalEnrichmentStatus ?? null,
    finalFallbackReason: finalFallbackReason ?? null,
    steamOnlyFallbackCacheExists,
    steamOnlyFallbackCacheRead
  });
}

function logLibrarySummaryExcludedSteamData({
  userId,
  section,
  reason = 'steam_not_connected',
  excludedPlayingCount = 0,
  excludedOwnedCount = 0,
  excludedBacklogCount = 0
}) {
  const excludedTotalCount = excludedPlayingCount + excludedOwnedCount + excludedBacklogCount;

  if (excludedTotalCount <= 0) {
    return;
  }

  logger.info('library-summary-excluded-steam-data', {
    userId,
    section,
    reason,
    excludedPlayingCount,
    excludedOwnedCount,
    excludedBacklogCount,
    excludedTotalCount
  });
}

function normalizeLibrarySummarySelectedTab(selectedTab) {
  if (selectedTab === LIBRARY_SUMMARY_TAB.LIKED || selectedTab === 'wishlist') {
    return LIBRARY_SUMMARY_TAB.LIKED;
  }

  if (selectedTab === LIBRARY_SUMMARY_TAB.REVIEWED || selectedTab === 'reviews') {
    return LIBRARY_SUMMARY_TAB.REVIEWED;
  }

  return LIBRARY_SUMMARY_TAB.PLAYING;
}

function normalizeNullableAverageRating(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.round(numericValue * 10) / 10;
}

function convertMinutesToHours(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
    return 0;
  }

  return Number((totalMinutes / 60).toFixed(1));
}

function buildLibrarySummaryPayload({
  selectedTab,
  totalPlaytimeHours = 0,
  totalPlaytimeMinutes = 0,
  averageRating = null,
  reviewCount = 0,
  gameCount = 0
}) {
  const normalizedSelectedTab = normalizeLibrarySummarySelectedTab(selectedTab);

  return {
    source: LIBRARY_SUMMARY_SOURCE[normalizedSelectedTab],
    selectedTab: normalizedSelectedTab,
    totalPlaytimeHours: Number.isFinite(totalPlaytimeHours) ? totalPlaytimeHours : 0,
    totalPlaytimeMinutes: Number.isFinite(totalPlaytimeMinutes) ? totalPlaytimeMinutes : 0,
    averageRating: reviewCount > 0 ? normalizeNullableAverageRating(averageRating) : null,
    reviewCount: Number.isInteger(reviewCount) ? reviewCount : 0,
    gameCount: Number.isInteger(gameCount) ? gameCount : 0
  };
}

function resolveLibrarySectionItems({
  selectedTab,
  playing = [],
  liked = [],
  reviewed = []
}) {
  const normalizedSelectedTab = normalizeLibrarySummarySelectedTab(selectedTab);

  if (normalizedSelectedTab === LIBRARY_SUMMARY_TAB.LIKED) {
    return {
      section: LIBRARY_SUMMARY_TAB.LIKED,
      items: liked
    };
  }

  if (normalizedSelectedTab === LIBRARY_SUMMARY_TAB.REVIEWED) {
    return {
      section: LIBRARY_SUMMARY_TAB.REVIEWED,
      items: reviewed
    };
  }

  return {
    section: LIBRARY_SUMMARY_TAB.PLAYING,
    items: playing
  };
}

function buildLibrarySummaryFromItems({
  selectedTab,
  items = []
}) {
  const normalizedSelectedTab = normalizeLibrarySummarySelectedTab(selectedTab);
  const gameCount = Array.isArray(items) ? items.length : 0;

  if (normalizedSelectedTab === LIBRARY_SUMMARY_TAB.REVIEWED) {
    const ratings = (Array.isArray(items) ? items : [])
      .map((item) => Number(item?.rating))
      .filter((rating) => Number.isFinite(rating));
    const averageRating = ratings.length > 0
      ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length
      : null;

    return buildLibrarySummaryPayload({
      selectedTab: normalizedSelectedTab,
      gameCount,
      reviewCount: gameCount,
      averageRating
    });
  }

  const totalPlaytimeMinutes = (Array.isArray(items) ? items : []).reduce((sum, item) => {
    const playtimeMinutes = Number(item?.playtimeMinutes);

    if (!Number.isFinite(playtimeMinutes) || playtimeMinutes <= 0) {
      return sum;
    }

    return sum + playtimeMinutes;
  }, 0);

  return buildLibrarySummaryPayload({
    selectedTab: normalizedSelectedTab,
    gameCount,
    totalPlaytimeHours: convertMinutesToHours(totalPlaytimeMinutes),
    totalPlaytimeMinutes
  });
}

function logLibrarySummaryListConsistency({
  userId,
  scope,
  selectedTab,
  items = [],
  listItems = null,
  summaryItems = null,
  summary,
  collapseRules = [],
  sameDatasetPathUsed = true
}) {
  const normalizedSelectedTab = normalizeLibrarySummarySelectedTab(selectedTab);
  const effectiveListItems = Array.isArray(listItems) ? listItems : (Array.isArray(items) ? items : []);
  const effectiveSummaryItems = Array.isArray(summaryItems) ? summaryItems : (Array.isArray(items) ? items : []);
  const listTotalPlaytimeMinutes = effectiveListItems.reduce((sum, item) => {
    const playtimeMinutes = Number(item?.playtimeMinutes);

    if (!Number.isFinite(playtimeMinutes) || playtimeMinutes <= 0) {
      return sum;
    }

    return sum + playtimeMinutes;
  }, 0);
  const summaryTotalPlaytimeMinutes = effectiveSummaryItems.reduce((sum, item) => {
    const playtimeMinutes = Number(item?.playtimeMinutes);

    if (!Number.isFinite(playtimeMinutes) || playtimeMinutes <= 0) {
      return sum;
    }

    return sum + playtimeMinutes;
  }, 0);
  const listDatasetCount = effectiveListItems.length;
  const summaryDatasetCount = effectiveSummaryItems.length;

  logger.info('library-list-dataset', {
    userId,
    scope,
    section: normalizedSelectedTab,
    selectedTab: normalizedSelectedTab,
    listDatasetCount,
    totalPlaytimeMinutes: listTotalPlaytimeMinutes,
    collapseRules
  });

  logger.info('library-summary-dataset', {
    userId,
    scope,
    section: normalizedSelectedTab,
    selectedTab: normalizedSelectedTab,
    summaryDatasetCount,
    summaryTotalPlaytimeMinutes,
    collapseRules
  });

  logger.info('library-summary-list-consistency', {
    userId,
    scope,
    section: normalizedSelectedTab,
    selectedTab: normalizedSelectedTab,
    summaryDatasetCount,
    listDatasetCount,
    summaryTotalPlaytimeMinutes,
    listTotalPlaytimeMinutes,
    sameDatasetPathUsed,
    collapseRules
  });
}

function buildSteamConnectionState(steamAccount) {
  const isConnected = Boolean(steamAccount);

  return {
    isConnected,
    connected: isConnected,
    providerSubject: steamAccount?.providerSubject ?? null,
    personaName: steamAccount?.personaName ?? null,
    lastSteamSyncAt: steamAccount?.lastSteamSyncAt
      ? new Date(steamAccount.lastSteamSyncAt).toISOString()
      : null,
    canSync: isConnected,
    canDisconnect: isConnected
  };
}

function buildSteamSyncState({
  steamAccount,
  steamSyncStatus,
  recentlyPlayedSource = 'none',
  friendRecommendationPreviewDeferred = false
}) {
  const baseState = buildSteamConnectionState(steamAccount);

  return {
    ...baseState,
    syncStatus: steamSyncStatus === STEAM_SYNC_STATUS.SUCCESS ? 'success' : (
      steamSyncStatus === STEAM_SYNC_STATUS.SYNCING ? 'pending' : 'error'
    ),
    lastSyncAt: baseState.lastSteamSyncAt,
    recentlyPlayedSource,
    friendRecommendationPreviewDeferred: Boolean(friendRecommendationPreviewDeferred)
  };
}

function buildStandardSteamSyncPayload({
  steamAccount,
  steamSyncStatus
}) {
  return {
    connected: Boolean(steamAccount),
    lastSyncAt: steamAccount?.lastSteamSyncAt
      ? new Date(steamAccount.lastSteamSyncAt).toISOString()
      : null,
    syncStatus: steamSyncStatus === STEAM_SYNC_STATUS.SUCCESS ? 'success' : (
      steamSyncStatus === STEAM_SYNC_STATUS.SYNCING ? 'pending' : 'error'
    )
  };
}

function buildLibraryResponseMeta({ isPartialFailure = false, summaryDatasetBasis = null } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    isPartialFailure: Boolean(isPartialFailure),
    summaryDatasetBasis: typeof summaryDatasetBasis === 'string' && summaryDatasetBasis.trim()
      ? summaryDatasetBasis.trim()
      : null
  };
}

function normalizeSteamRecentPlayedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      syncedAt: null,
      games: []
    };
  }

  const rawGames = Array.isArray(snapshot.games) ? snapshot.games : [];

  return {
    syncedAt: typeof snapshot.syncedAt === 'string' && snapshot.syncedAt.trim()
      ? snapshot.syncedAt.trim()
      : null,
    games: rawGames
      .map((game) => {
        const externalGameId = typeof game?.externalGameId === 'string'
          ? game.externalGameId.trim()
          : '';

        if (!externalGameId) {
          return null;
        }

        const title = typeof game?.title === 'string' && game.title.trim()
          ? game.title.trim()
          : null;
        const playtimeMinutes = Number.isInteger(game?.playtimeMinutes)
          ? game.playtimeMinutes
          : null;
        const recentPlaytimeMinutes = Number.isInteger(game?.recentPlaytimeMinutes)
          ? game.recentPlaytimeMinutes
          : null;
        const lastPlayedAt = typeof game?.lastPlayedAt === 'string' && game.lastPlayedAt.trim()
          ? game.lastPlayedAt.trim()
          : null;
        const hasReliableLastPlayedAt = game?.hasReliableLastPlayedAt === true;
        const snapshotRank = Number.isInteger(game?.snapshotRank) ? game.snapshotRank : null;

        return {
          externalGameId,
          title,
          playtimeMinutes,
          recentPlaytimeMinutes,
          lastPlayedAt,
          hasReliableLastPlayedAt,
          snapshotRank
        };
      })
      .filter(Boolean)
  };
}

function resolveRecentPlayTimestamp({
  libraryLastPlayedAt = null,
  snapshotLastPlayedAt = null,
  snapshotHasReliableLastPlayedAt = false,
  sourceType = 'cached_snapshot'
}) {
  if (snapshotHasReliableLastPlayedAt && snapshotLastPlayedAt) {
    return {
      lastPlayedAt: new Date(snapshotLastPlayedAt).toISOString(),
      lastPlayedAtSource: sourceType === 'live_fetch'
        ? 'live_steam_recent_played'
        : 'trusted_snapshot_timestamp',
      hasReliableLastPlayedAt: true,
      fallbackReason: null
    };
  }

  if (sourceType === 'live_fetch') {
    return {
      lastPlayedAt: null,
      lastPlayedAtSource: 'live_steam_without_timestamp',
      hasReliableLastPlayedAt: false,
      fallbackReason: 'timestamp_unavailable'
    };
  }

  if (sourceType === 'cached_snapshot') {
    return {
      lastPlayedAt: null,
      lastPlayedAtSource: 'snapshot_without_timestamp',
      hasReliableLastPlayedAt: false,
      fallbackReason: 'timestamp_unavailable'
    };
  }

  if (libraryLastPlayedAt) {
    return {
      lastPlayedAt: new Date(libraryLastPlayedAt).toISOString(),
      lastPlayedAtSource: 'library_last_played_at',
      hasReliableLastPlayedAt: true,
      fallbackReason: null
    };
  }

  return {
    lastPlayedAt: null,
    lastPlayedAtSource: 'timestamp_unavailable',
    hasReliableLastPlayedAt: false,
    fallbackReason: 'timestamp_unavailable'
  };
}

async function getTargetSteamLibrarySourceSnapshot(externalGameId, userId = null) {
  if (!TARGET_STEAM_DEBUG_APP_IDS.has(typeof externalGameId === 'string' ? externalGameId.trim() : '')) {
    return null;
  }

  const [userScopedRow, anyScopedRows] = await Promise.all([
    typeof userId === 'string' && userId.trim()
      ? prisma.userGameLibrary.findUnique({
        where: {
          userId_gameSource_externalGameId: {
            userId,
            gameSource: GameSource.STEAM,
            externalGameId
          }
        },
        select: {
          userId: true,
          gameName: true,
          gameSource: true,
          coverUrl: true,
          updatedAt: true
        }
      })
      : Promise.resolve(null),
    prisma.userGameLibrary.findMany({
      where: {
        externalGameId,
        gameSource: GameSource.STEAM
      },
      orderBy: {
        updatedAt: 'desc'
      },
      take: 12,
      select: {
        userId: true,
        gameName: true,
        gameSource: true,
        coverUrl: true,
        updatedAt: true
      }
    })
  ]);
  const anyScopedTitledRow = anyScopedRows.find((row) => typeof row?.gameName === 'string' && row.gameName.trim().length > 0) ?? null;
  const anyScopedRow = anyScopedRows[0] ?? null;

  return {
    userScopedRow,
    anyScopedTitledRow,
    anyScopedRow
  };
}

function resolveGameSource(source) {
  return sourceMap[source];
}

function resolveGameStatus(status) {
  return statusMap[status];
}

function normalizeIgdbGameId(gameId) {
  const normalizedValue = typeof gameId === 'string'
    ? gameId.trim()
    : String(gameId ?? '').trim();

  return /^\d+$/.test(normalizedValue) ? normalizedValue : null;
}

function buildNormalizedDetailPayload({
  endpoint,
  title,
  externalGameId,
  igdbGameId,
  reason = null,
  mappingStatus = null,
  mappingSource = null
}) {
  const normalizedIgdbGameId = normalizeIgdbGameId(igdbGameId);
  const numericGameId = normalizedIgdbGameId ? Number.parseInt(normalizedIgdbGameId, 10) : null;
  const detailAvailable = Number.isInteger(numericGameId) && numericGameId > 0;

  if (!detailAvailable) {
    logger.info('[InvalidDetailPayloadBlocked]', {
      endpoint,
      title: title ?? null,
      externalGameId: externalGameId ?? null,
      igdbGameId: igdbGameId ?? null,
      reason: reason ?? 'missing_or_invalid_igdb_game_id'
    });
  }

  return {
    gameId: detailAvailable ? numericGameId : null,
    igdbGameId: detailAvailable ? normalizedIgdbGameId : null,
    detailAvailable,
    mappingStatus: mappingStatus ?? null,
    mappingSource: mappingSource ?? null
  };
}

function logRecommendationRatingPayload({
  endpoint,
  title,
  externalGameId,
  igdbGameId,
  aggregatedRating,
  totalRating,
  rating,
  detailAvailable
}) {
  logger.info('[RecommendationRatingPayload]', {
    endpoint,
    title: title ?? null,
    externalGameId: externalGameId ?? null,
    igdbGameId: igdbGameId ?? null,
    aggregatedRating: typeof aggregatedRating === 'number' ? aggregatedRating : null,
    totalRating: typeof totalRating === 'number' ? totalRating : null,
    rating: typeof rating === 'number' ? rating : null,
    detailAvailable: detailAvailable === true
  });
}

function logRecentPlayDetailPayload({
  endpoint,
  title,
  externalGameId,
  igdbGameId,
  detailAvailable,
  mappingStatus,
  mappingSource
}) {
  logger.info('[RecentPlayDetailPayload]', {
    endpoint,
    title: title ?? null,
    externalGameId: externalGameId ?? null,
    igdbGameId: igdbGameId ?? null,
    detailAvailable: detailAvailable === true,
    mappingStatus: mappingStatus ?? null,
    mappingSource: mappingSource ?? null
  });
}

function normalizeLibraryGameSource(source) {
  if (source === GameSource.STEAM || source === 'STEAM' || source === 'steam') {
    return 'steam';
  }

  return 'igdb';
}

function isAcceptedSteamIgdbMapping(mapping) {
  return mapping?.matchStatus === 'CONFIRMED' &&
    Boolean(normalizeIgdbGameId(mapping?.igdbGameId));
}

async function getSteamSocialAccount(userId) {
  return memoizeLibraryRequestPromise('socialAccountByUserId', userId, () => prisma.socialAccount.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: steamService.STEAM_AUTH_PROVIDER
      }
    },
    select: steamAccountSelect
  }));
}

async function getMyFavoritesMemoized({ userId, sort = 'latest', limit = null }) {
  const resolutionKey = [userId, sort, Number.isInteger(limit) && limit > 0 ? String(limit) : 'all'].join('|');

  return memoizeLibraryRequestPromise('favoriteGamesByUserQuery', resolutionKey, () => favoriteService.getMyFavorites({
    currentUserId: userId,
    sort,
    limit
  }));
}

async function getMyReviewsMemoized({ userId, sort = 'latest', limit = null }) {
  const resolutionKey = [userId, sort, Number.isInteger(limit) && limit > 0 ? String(limit) : 'all'].join('|');

  return memoizeLibraryRequestPromise('reviewsByUserQuery', resolutionKey, () => reviewService.getMyReviews({
    currentUserId: userId,
    sort,
    limit
  }));
}

async function getFriendRowsMemoized(userId) {
  return memoizeLibraryRequestPromise('friendshipsByUserId', userId, () => prisma.friendship.findMany({
    where: { userId },
    select: { friendUserId: true }
  }));
}

async function getSteamLibraryEntriesMemoized({
  userId,
  gameSource = GameSource.STEAM,
  select,
  orderBy = { updatedAt: 'desc' }
}) {
  const resolutionKey = [
    userId,
    String(gameSource),
    JSON.stringify(select ?? {}),
    JSON.stringify(orderBy ?? {})
  ].join('|');

  return memoizeLibraryRequestPromise('steamLibraryEntriesByUserQuery', resolutionKey, () => prisma.userGameLibrary.findMany({
    where: {
      userId,
      gameSource
    },
    ...(select ? { select } : {}),
    ...(orderBy ? { orderBy } : {})
  }));
}

function invalidateSteamLibraryRuntimeCaches({ steamId64 = null } = {}) {
  const normalizedSteamId64 = buildSteamApiRequestKey(steamId64);

  if (normalizedSteamId64) {
    activeOwnedGamesFetches.delete(normalizedSteamId64);
    activeRecentlyPlayedFetches.delete(normalizedSteamId64);
  }

  logger.info('library-steam-sync-cache-invalidated', {
    steamId64: normalizedSteamId64 || null,
    clearedOwnedGamesCache: Boolean(normalizedSteamId64),
    clearedRecentPlayedCache: Boolean(normalizedSteamId64)
  });
}

async function getFavoriteGameIdsMemoized(userId) {
  return memoizeLibraryRequestPromise('favoriteGameIdsByUserId', userId, () => prisma.favoriteGame.findMany({
    where: { userId },
    select: { gameId: true }
  }));
}

async function getReviewGameIdsMemoized(userId) {
  return memoizeLibraryRequestPromise('reviewGameIdsByUserId', userId, () => prisma.review.findMany({
    where: { userId },
    select: { gameId: true }
  }));
}

async function buildPlayedLibrarySummaryDataset({
  userId,
  steamConnected = true,
  selectedTab = LIBRARY_SUMMARY_TAB.PLAYING
}) {
  // Summary for the "playing" tab uses the persisted played-library set, not preview cards.
  const playedRows = await memoizeLibraryRequestPromise(
    'playedLibrarySummaryDatasetByUserId',
    [userId, steamConnected ? 'steam-on' : 'steam-off'].join('|'),
    () => prisma.userGameLibrary.findMany({
      where: {
        userId,
        playtimeMinutes: {
          gt: 0
        },
        ...(!steamConnected
          ? {
            gameSource: {
              not: GameSource.STEAM
            }
          }
          : {})
      },
      select: {
        gameSource: true,
        externalGameId: true,
        playtimeMinutes: true
      }
    })
  );

  const dedupedRowMap = new Map();

  for (const row of playedRows) {
    const identityKey = `${String(row.gameSource).toLowerCase()}|${row.externalGameId}`;
    const existingRow = dedupedRowMap.get(identityKey);

    if (!existingRow || ((row.playtimeMinutes ?? 0) > (existingRow.playtimeMinutes ?? 0))) {
      dedupedRowMap.set(identityKey, row);
    }
  }

  const distinctRows = [...dedupedRowMap.values()];
  const totalPlaytimeMinutes = distinctRows.reduce((sum, row) => sum + (row.playtimeMinutes ?? 0), 0);
  const ownedWithPlaytimeCount = distinctRows.filter((row) => String(row.gameSource).toLowerCase() === GameSource.STEAM).length;
  const mismatchReason = distinctRows.length === ownedWithPlaytimeCount
    ? null
    : 'includes_non_steam_played_entries';

  logger.info('played-library-summary-source', {
    userId,
    selectedTab: normalizeLibrarySummarySelectedTab(selectedTab),
    datasetCount: playedRows.length,
    distinctGameCount: distinctRows.length,
    totalPlaytimeMinutes,
    sampleExternalGameIds: distinctRows.slice(0, 10).map((row) => row.externalGameId),
    inclusionRule: 'playtime_minutes > 0'
  });

  logger.info('played-library-summary-vs-owned', {
    userId,
    playedSummaryCount: distinctRows.length,
    ownedWithPlaytimeCount,
    sameCount: distinctRows.length === ownedWithPlaytimeCount,
    mismatchReason
  });

  return {
    items: distinctRows,
    summary: buildLibrarySummaryPayload({
      selectedTab: LIBRARY_SUMMARY_TAB.PLAYING,
      gameCount: distinctRows.length,
      totalPlaytimeHours: convertMinutesToHours(totalPlaytimeMinutes),
      totalPlaytimeMinutes
    }),
    datasetBasis: 'played_library_nonzero_playtime',
    totalPlaytimeMinutes,
    distinctGameCount: distinctRows.length
  };
}

function logLibrarySummaryDatasetBasis({
  userId,
  selectedTab,
  summaryDatasetBasis,
  summaryDatasetCount,
  summaryTotalPlaytimeMinutes
}) {
  logger.info('library-summary-dataset-basis', {
    userId,
    selectedTab: normalizeLibrarySummarySelectedTab(selectedTab),
    summaryDatasetBasis,
    summaryDatasetCount,
    summaryTotalPlaytimeMinutes
  });
}

function logLibraryPreviewDatasetBasis({
  userId,
  selectedTab,
  previewDatasetBasis,
  previewDatasetCount
}) {
  logger.info('library-preview-dataset-basis', {
    userId,
    selectedTab: normalizeLibrarySummarySelectedTab(selectedTab),
    previewDatasetBasis,
    previewDatasetCount
  });
}

function logLibrarySummaryFinal({
  userId,
  selectedTab,
  summary,
  totalPlaytimeMinutes,
  summaryDatasetBasis
}) {
  logger.info('library-summary-final', {
    userId,
    selectedTab: normalizeLibrarySummarySelectedTab(selectedTab),
    gameCount: summary?.gameCount ?? 0,
    totalPlaytimeHours: summary?.totalPlaytimeHours ?? 0,
    totalPlaytimeMinutes: Number.isInteger(totalPlaytimeMinutes) ? totalPlaytimeMinutes : 0,
    summaryDatasetBasis,
    overwrittenAfterCompute: false
  });
}

function buildLibrarySummaryAliases(summary) {
  return {
    summarySource: summary?.source ?? null,
    gameCount: summary?.gameCount ?? 0,
    totalPlaytimeHours: summary?.totalPlaytimeHours ?? 0,
    totalPlaytimeMinutes: summary?.totalPlaytimeMinutes ?? 0
  };
}

function logLibraryOwnedDatasetBasis({
  userId,
  datasetBasis,
  fullOwnedCount,
  fullOwnedPlaytimeMinutes,
  filteredOwnedCount,
  filterReason
}) {
  logger.info('library-owned-dataset-basis', {
    userId,
    datasetBasis,
    fullOwnedCount,
    fullOwnedPlaytimeMinutes,
    filteredOwnedCount,
    filterReason
  });
}

function logLibraryOwnedResponseFinal({
  userId,
  count,
  resultCount,
  datasetBasis,
  externalIdFilterApplied,
  externalIdFilterCount
}) {
  logger.info('library-owned-response-final', {
    userId,
    count,
    resultCount,
    datasetBasis,
    externalIdFilterApplied,
    externalIdFilterCount
  });
}

async function getLibrarySummary({
  userId,
  selectedTab = LIBRARY_SUMMARY_TAB.PLAYING,
  steamConnected = true
}) {
  const normalizedSelectedTab = normalizeLibrarySummarySelectedTab(selectedTab);

  if (normalizedSelectedTab === LIBRARY_SUMMARY_TAB.LIKED) {
    const gameCount = await memoizeLibraryRequestPromise('libraryLikedCountByUserId', userId, () => prisma.favoriteGame.count({
      where: { userId }
    }));

    return buildLibrarySummaryPayload({
      selectedTab: normalizedSelectedTab,
      gameCount
    });
  }

  if (normalizedSelectedTab === LIBRARY_SUMMARY_TAB.REVIEWED) {
    const aggregation = await memoizeLibraryRequestPromise('libraryReviewSummaryByUserId', userId, () => prisma.review.aggregate({
      where: { userId },
      _count: {
        id: true
      },
      _avg: {
        rating: true
      }
    }));
    const reviewCount = aggregation?._count?.id ?? 0;

    return buildLibrarySummaryPayload({
      selectedTab: normalizedSelectedTab,
      gameCount: reviewCount,
      reviewCount,
      averageRating: reviewCount > 0 ? aggregation?._avg?.rating ?? null : null
    });
  }

  const playingSummaryKey = [
    userId,
    steamConnected ? 'steam-on' : 'steam-off'
  ].join('|');
  const aggregation = await memoizeLibraryRequestPromise('libraryPlayingSummaryByUserId', playingSummaryKey, () => prisma.userGameLibrary.aggregate({
    where: {
      userId,
      status: GameLibraryStatus.PLAYING,
      ...(!steamConnected
        ? {
          gameSource: {
            not: GameSource.STEAM
          }
        }
        : {})
    },
    _count: {
      _all: true
    },
    _sum: {
      playtimeMinutes: true
    }
  }));

  return buildLibrarySummaryPayload({
    selectedTab: normalizedSelectedTab,
    gameCount: aggregation?._count?._all ?? 0,
    totalPlaytimeHours: convertMinutesToHours(aggregation?._sum?.playtimeMinutes ?? 0)
  });
}

function resolveSteamSyncStatusFromErrorCode(errorCode, hasSteamConnection) {
  if (!hasSteamConnection) {
    return STEAM_SYNC_STATUS.NOT_CONNECTED;
  }

  if (STEAM_TOKEN_EXPIRED_ERROR_CODES.has(errorCode)) {
    return STEAM_SYNC_STATUS.TOKEN_EXPIRED;
  }

  return STEAM_SYNC_STATUS.FAILED;
}

function resolveSteamSyncStatus({
  steamAccount,
  warningCode = null,
  errorCode = null,
  wasSuccessful = false
}) {
  if (!steamAccount) {
    return STEAM_SYNC_STATUS.NOT_CONNECTED;
  }

  if (warningCode && STEAM_PRIVATE_PROFILE_WARNING_CODES.has(warningCode)) {
    return STEAM_SYNC_STATUS.PRIVATE_PROFILE;
  }

  if (errorCode) {
    return resolveSteamSyncStatusFromErrorCode(errorCode, true);
  }

  if (wasSuccessful) {
    return STEAM_SYNC_STATUS.SUCCESS;
  }

  return STEAM_SYNC_STATUS.IDLE;
}

async function markSteamSyncSuccess(steamAccount) {
  if (!steamAccount?.id) {
    return null;
  }

  return memoizeLibraryRequestPromise('lastSteamSyncUpdate', steamAccount.id, async () => {
    if (activeSteamSyncMarkPromises.has(steamAccount.id)) {
      return activeSteamSyncMarkPromises.get(steamAccount.id);
    }

    const markPromise = (async () => {
      const now = new Date();
      const currentValue = steamAccount.lastSteamSyncAt instanceof Date
        ? steamAccount.lastSteamSyncAt
        : (steamAccount.lastSteamSyncAt ? new Date(steamAccount.lastSteamSyncAt) : null);

      if (currentValue && !Number.isNaN(currentValue.getTime()) && now.getTime() - currentValue.getTime() < 60 * 1000) {
        return currentValue;
      }

      await prisma.socialAccount.update({
        where: {
          id: steamAccount.id
        },
        data: {
          lastSteamSyncAt: now
        }
      });

      steamAccount.lastSteamSyncAt = now;

      logger.info('steam-last-sync-updated', {
        userId: steamAccount.userId,
        steamId64: steamAccount.providerSubject ?? null,
        lastSteamSyncAt: now.toISOString()
      });

      return now;
    })();

    activeSteamSyncMarkPromises.set(steamAccount.id, markPromise);

    try {
      return await markPromise;
    } finally {
      activeSteamSyncMarkPromises.delete(steamAccount.id);
    }
  });
}

function markSteamSyncInProgress(userId) {
  if (typeof userId === 'string' && userId.trim()) {
    activeSteamSyncUserIds.add(userId);
  }
}

function clearSteamSyncInProgress(userId) {
  if (typeof userId === 'string' && userId.trim()) {
    activeSteamSyncUserIds.delete(userId);
  }
}

function isSteamSyncInProgress(userId) {
  return typeof userId === 'string' && activeSteamSyncUserIds.has(userId);
}

function buildSteamApiRequestKey(steamId64) {
  return typeof steamId64 === 'string' ? steamId64.trim() : '';
}

async function mapWithConcurrencyLimit(items, limit, mapper) {
  const normalizedLimit = Math.max(1, Number.isInteger(limit) ? limit : 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      try {
        results[currentIndex] = {
          status: 'fulfilled',
          value: await mapper(items[currentIndex], currentIndex)
        };
      } catch (error) {
        results[currentIndex] = {
          status: 'rejected',
          reason: error
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(normalizedLimit, items.length) }, () => runWorker())
  );

  return results;
}

async function fetchOwnedGamesDedup({ userId, steamId64 }) {
  const resolutionKey = buildSteamApiRequestKey(steamId64);

  if (!resolutionKey) {
    return {
      games: []
    };
  }

  return memoizeLibraryRequestPromise('ownedGamesBySteamId', resolutionKey, async () => {
    if (activeOwnedGamesFetches.has(resolutionKey)) {
      logger.info('steam-request-coalesced', {
        requestType: 'ownedGamesBySteamId',
        steamId64: resolutionKey,
        hit: true
      });
      return activeOwnedGamesFetches.get(resolutionKey);
    }

    logger.info('Steam owned games request', {
      userId,
      steamId: steamId64,
      hasSteamApiKey: steamService.isSteamSyncConfigured()
    });

    const fetchPromise = steamService.fetchOwnedGames({ steamId64 })
      .then((result) => {
        logger.info('Steam owned games response', {
          userId,
          steamId: steamId64,
          gameCount: Array.isArray(result?.games) ? result.games.length : 0
        });

        return result;
      });

    activeOwnedGamesFetches.set(resolutionKey, fetchPromise);

    try {
      const result = await fetchPromise;
      setTimeout(() => activeOwnedGamesFetches.delete(resolutionKey), 30000);
      return result;
    } catch (error) {
      activeOwnedGamesFetches.delete(resolutionKey);
      throw error;
    }
  });
}

async function fetchRecentlyPlayedGamesDedup({ userId, steamId64 }) {
  const resolutionKey = buildSteamApiRequestKey(steamId64);

  if (!resolutionKey) {
    return {
      games: []
    };
  }

  return memoizeLibraryRequestPromise('recentPlayedBySteamId', resolutionKey, async () => {
    if (activeRecentlyPlayedFetches.has(resolutionKey)) {
      logger.info('steam-request-coalesced', {
        requestType: 'recentPlayedBySteamId',
        steamId64: resolutionKey,
        hit: true
      });
      return activeRecentlyPlayedFetches.get(resolutionKey);
    }

    logger.info('Steam recently played request', {
      userId,
      steamId: steamId64,
      hasSteamApiKey: steamService.isSteamSyncConfigured()
    });

    const fetchPromise = steamService.fetchRecentlyPlayedGames({ steamId64 })
      .then((result) => {
        logger.info('Steam recently played response', {
          userId,
          steamId: steamId64,
          gameCount: Array.isArray(result?.games) ? result.games.length : 0
        });

        return result;
      });
    activeRecentlyPlayedFetches.set(resolutionKey, fetchPromise);

    try {
      const result = await fetchPromise;
      setTimeout(() => activeRecentlyPlayedFetches.delete(resolutionKey), 30000);
      return result;
    } catch (error) {
      activeRecentlyPlayedFetches.delete(resolutionKey);
      throw error;
    }
  });
}

function buildFailedSteamPreviewResult({
  steamAccount = null,
  steamSyncErrorCode = 'STEAM_STATE_LOOKUP_FAILED'
} = {}) {
  return {
    games: [],
    steamSyncAvailable: false,
    steamSyncErrorCode,
    steamSyncStatus: STEAM_SYNC_STATUS.FAILED,
    lastSteamSyncAt: steamAccount?.lastSteamSyncAt ?? null
  };
}

async function buildCachedRecentlyPlayedResult({
  userId,
  steamAccount,
  page = 1,
  limit = LIBRARY_PREVIEW_LIMITS.recentlyPlayed,
  endpoint = 'library_recently_played'
}) {
  if (!steamAccount) {
    logger.info('library-recent-played-source', {
      userId,
      source: 'none',
      steamConnected: false,
      cachedCount: 0,
      resolvedCount: 0,
      droppedCount: 0,
      droppedExternalGameIds: [],
      syncTriggered: false
    });

    return {
      games: [],
      totalCount: 0,
      steamSyncAvailable: false,
      steamSyncErrorCode: null,
      steamSyncStatus: STEAM_SYNC_STATUS.NOT_CONNECTED,
      lastSteamSyncAt: null,
      source: 'none'
    };
  }

  const pagination = resolvePaginationParams({
    page,
    limit,
    defaultLimit: limit || LIBRARY_PREVIEW_LIMITS.recentlyPlayed
  });
  const snapshot = normalizeSteamRecentPlayedSnapshot(steamAccount.steamRecentPlayedSnapshot);
  const hasSnapshot = snapshot.games.length > 0;
  const steamId64 = steamService.normalizeSteamId64(steamAccount.providerSubject);
  const canAttemptLiveFetch = steamService.isSteamSyncConfigured() && Boolean(steamId64);
  let selectedSource = 'none';
  let selectedSourceGames = [];
  let liveFetchAttempted = false;
  let liveFetchFailed = false;

  if (canAttemptLiveFetch) {
    try {
      liveFetchAttempted = true;
      const liveResult = await fetchRecentlyPlayedGamesDedup({ userId, steamId64 });
      const liveSnapshot = {
        syncedAt: new Date().toISOString(),
        games: (liveResult.games ?? []).map((game, index) => ({
          externalGameId: game.externalGameId,
          title: game.title ?? null,
          playtimeMinutes: Number.isInteger(game.playtimeMinutes) ? game.playtimeMinutes : null,
          recentPlaytimeMinutes: Number.isInteger(game.recentPlaytimeMinutes) ? game.recentPlaytimeMinutes : null,
          lastPlayedAt: typeof game.lastPlayedAt === 'string' && game.lastPlayedAt.trim()
            ? game.lastPlayedAt.trim()
            : null,
          hasReliableLastPlayedAt: typeof game.lastPlayedAt === 'string' && game.lastPlayedAt.trim().length > 0,
          snapshotRank: index
        }))
      };

      for (const snapshotGame of liveSnapshot.games) {
        logger.info('[SteamSnapshot Stored]', {
          appid: snapshotGame.externalGameId,
          snapshot_last_played: snapshotGame.lastPlayedAt,
          snapshot_playtime_2weeks: snapshotGame.recentPlaytimeMinutes,
          snapshot_created_at: liveSnapshot.syncedAt
        });
      }

      await prisma.socialAccount.update({
        where: {
          id: steamAccount.id
        },
        data: {
          steamRecentPlayedSnapshot: liveSnapshot
        }
      });
      steamAccount.steamRecentPlayedSnapshot = liveSnapshot;

      logger.info('library-recent-played-source', {
        userId,
        source: 'live_fetch',
        cachedCount: liveSnapshot.games.length,
        resolvedCount: Math.min(liveSnapshot.games.length, pagination.limit),
        droppedCount: 0,
        droppedExternalGameIds: [],
        syncTriggered: false
      });
      selectedSource = 'live_fetch';
      selectedSourceGames = normalizeSteamRecentPlayedSnapshot(liveSnapshot).games;
    } catch (error) {
      liveFetchFailed = true;
      logger.warn('library-recent-played-live-fetch-failed', {
        userId,
        steamId64,
        code: error?.code ?? null,
        message: error?.message ?? 'Recently played live fetch failed'
      });
    }
  }

  if (!selectedSource && hasSnapshot) {
    selectedSource = 'cached_snapshot';
    selectedSourceGames = snapshot.games;
  }

  const snapshotAppIds = selectedSourceGames.map((game) => game.externalGameId);
  const libraryWhere = {
    userId,
    gameSource: GameSource.STEAM,
    ...(selectedSourceGames.length > 0
      ? {
        externalGameId: {
          in: snapshotAppIds
        }
      }
      : {
        lastPlayedAt: {
          not: null
        }
      })
  };
  const [cachedEntries, fallbackEntryCount] = await Promise.all([
    prisma.userGameLibrary.findMany({
      where: libraryWhere,
      orderBy: {
        updatedAt: 'desc'
      },
      take: Math.max(pagination.limit * 4, LIBRARY_RECENTLY_PLAYED_FALLBACK_CANDIDATE_LIMIT)
    }),
    prisma.userGameLibrary.count({ where: libraryWhere })
  ]);
  const cachedEntryMap = new Map(cachedEntries.map((entry) => [entry.externalGameId, entry]));
  const resolvedGames = [];
  const droppedExternalGameIds = [];
  const includedAppIds = new Set();

  if (!selectedSourceGames.length) {
    selectedSource = 'library_fallback';
  }

  logger.info('[RecentPlayedSourceDecision]', {
    userId,
    steamId: steamId64 ?? null,
    endpoint,
    liveSteamAvailable: selectedSource === 'live_fetch',
    snapshotAvailable: hasSnapshot,
    selectedSource,
    reason: selectedSource === 'live_fetch'
      ? 'live_steam_preferred'
      : (selectedSource === 'cached_snapshot'
        ? (liveFetchFailed ? 'live_failed_snapshot_fallback' : 'snapshot_fallback')
        : (selectedSource === 'library_fallback' ? 'library_last_played_at_fallback' : 'no_recent_play_source'))
  });

  if (selectedSource === 'library_fallback' && cachedEntries.length === 0) {
    logger.info('library-recent-played-source', {
      userId,
      source: 'none',
      cachedCount: 0,
      resolvedCount: 0,
      droppedCount: 0,
      droppedExternalGameIds: [],
      syncTriggered: false
    });

    return {
      games: [],
      totalCount: 0,
      steamSyncAvailable: Boolean(steamAccount.lastSteamSyncAt),
      steamSyncErrorCode: null,
      steamSyncStatus: resolveSteamSyncStatus({
        steamAccount,
        wasSuccessful: Boolean(steamAccount.lastSteamSyncAt)
      }),
      lastSteamSyncAt: steamAccount.lastSteamSyncAt ?? null,
      source: 'none'
    };
  }

  for (const snapshotGame of selectedSourceGames) {
    const libraryEntry = cachedEntryMap.get(snapshotGame.externalGameId) ?? null;
    const title = libraryEntry?.gameName ?? snapshotGame.title ?? null;

    if (!title) {
      droppedExternalGameIds.push(snapshotGame.externalGameId);
      continue;
    }

    logger.info('[RecentPlayedMergeBefore]', {
      externalGameId: snapshotGame.externalGameId,
      currentLastPlayedAt: null,
      currentLastPlayedAtSource: null,
      currentReliable: false,
      incomingLastPlayedAt: snapshotGame.lastPlayedAt ?? null,
      incomingLastPlayedAtSource: selectedSource === 'live_fetch'
        ? (snapshotGame.hasReliableLastPlayedAt ? 'live_steam_recent_played' : 'live_steam_without_timestamp')
        : (snapshotGame.hasReliableLastPlayedAt ? 'trusted_snapshot_timestamp' : 'snapshot_without_timestamp'),
      incomingReliable: snapshotGame.hasReliableLastPlayedAt === true
    });

    const timestampResolution = resolveRecentPlayTimestamp({
      snapshotLastPlayedAt: snapshotGame.lastPlayedAt,
      snapshotHasReliableLastPlayedAt: snapshotGame.hasReliableLastPlayedAt === true,
      sourceType: selectedSource
    });

    resolvedGames.push({
      externalGameId: snapshotGame.externalGameId,
      title,
      playtimeMinutes: Number.isInteger(libraryEntry?.playtimeMinutes)
        ? libraryEntry.playtimeMinutes
        : snapshotGame.playtimeMinutes,
      recentPlaytimeMinutes: snapshotGame.recentPlaytimeMinutes,
      ...timestampResolution,
      fallbackReason: timestampResolution.fallbackReason,
      inclusionSource: selectedSource === 'live_fetch' ? 'live_steam_recent_played' : 'snapshot',
      snapshotRank: snapshotGame.snapshotRank
    });
    logger.info('[RecentPlayedMergeAfter]', {
      externalGameId: snapshotGame.externalGameId,
      finalLastPlayedAt: timestampResolution.lastPlayedAt,
      finalLastPlayedAtSource: timestampResolution.lastPlayedAtSource,
      finalReliable: timestampResolution.hasReliableLastPlayedAt,
      finalRecentPlaytimeMinutes: snapshotGame.recentPlaytimeMinutes ?? null
    });
    includedAppIds.add(snapshotGame.externalGameId);
  }

  if (selectedSource === 'library_fallback') {
    for (const entry of cachedEntries) {
      if (includedAppIds.has(entry.externalGameId)) {
        continue;
      }

      if (!entry.lastPlayedAt) {
        continue;
      }

      const timestampResolution = resolveRecentPlayTimestamp({
        libraryLastPlayedAt: entry.lastPlayedAt ?? null,
        sourceType: 'library_fallback'
      });

      resolvedGames.push({
        externalGameId: entry.externalGameId,
        title: entry.gameName,
        playtimeMinutes: Number.isInteger(entry.playtimeMinutes) ? entry.playtimeMinutes : null,
        recentPlaytimeMinutes: null,
        ...timestampResolution,
        fallbackReason: timestampResolution.fallbackReason,
        inclusionSource: 'library_last_played_at',
        snapshotRank: null
      });
    }
  }

  resolvedGames.sort((left, right) => {
    const leftTimestamp = left.lastPlayedAt ? new Date(left.lastPlayedAt).getTime() : 0;
    const rightTimestamp = right.lastPlayedAt ? new Date(right.lastPlayedAt).getTime() : 0;

    if (rightTimestamp !== leftTimestamp) {
      return rightTimestamp - leftTimestamp;
    }

    const leftRank = Number.isInteger(left.snapshotRank) ? left.snapshotRank : Number.MAX_SAFE_INTEGER;
    const rightRank = Number.isInteger(right.snapshotRank) ? right.snapshotRank : Number.MAX_SAFE_INTEGER;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return String(left.externalGameId).localeCompare(String(right.externalGameId));
  });
  const totalCount = resolvedGames.length;
  const pagedGames = resolvedGames.slice(pagination.skip, pagination.skip + pagination.limit);
  const steamMappingResolution = await resolveSteamMappingContextForGames({
    games: pagedGames.map((game) => ({
      userId,
      externalGameId: game.externalGameId,
      gameName: game.title
    })),
    activeResolution: false,
    createMissingMappingsWhenUncached: true,
    logLabel: 'recently-played-cache',
    userId
  });
  const steamSyncStatus = resolveSteamSyncStatus({
    steamAccount,
    wasSuccessful: Boolean(steamAccount.lastSteamSyncAt)
  });
  const resolvedSource = selectedSource === 'live_fetch' ? 'live_fetch' : 'cached_snapshot';

  logger.info('library-recent-played-source', {
    userId,
    source: resolvedSource,
    cachedCount: snapshot.games.length,
    totalCount,
    resolvedCount: pagedGames.length,
    droppedCount: droppedExternalGameIds.length,
    droppedExternalGameIds,
    syncTriggered: false
  });

  return {
    games: mapSteamRecentlyPlayedGames(pagedGames, steamMappingResolution.mappingContext, userId, endpoint),
    totalCount,
    steamSyncAvailable: Boolean(steamAccount.lastSteamSyncAt),
    steamSyncErrorCode: null,
    steamSyncStatus,
    lastSteamSyncAt: steamAccount.lastSteamSyncAt ?? null,
    source: resolvedSource
  };
}

function normalizeSteamGenreTag(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');

  return normalizedValue || null;
}

function resolveGenreFallback({ igdbGenres = [], steamTags = [] }) {
  const primaryIgdbGenre = Array.isArray(igdbGenres) && typeof igdbGenres[0] === 'string' && igdbGenres[0].trim()
    ? igdbGenres[0].trim()
    : null;

  if (primaryIgdbGenre) {
    return {
      genreDisplayName: primaryIgdbGenre,
      genreSource: 'igdb'
    };
  }

  for (const steamTag of steamTags ?? []) {
    const normalizedSteamTag = normalizeSteamGenreTag(steamTag);

    if (!normalizedSteamTag) {
      continue;
    }

    const mappedGenreName = STEAM_TAG_GENRE_MAP.get(normalizedSteamTag);

    if (mappedGenreName) {
      return {
        genreDisplayName: mappedGenreName,
        genreSource: 'steam_tag'
      };
    }
  }

  return {
    genreDisplayName: null,
    genreSource: null
  };
}

function addSteamFriendRecommendationSignal(aggregateMap, game, friendSteamId, signalType) {
  const externalGameId = typeof game?.externalGameId === 'string' ? game.externalGameId.trim() : '';

  if (!externalGameId) {
    return;
  }

  const existingCandidate = aggregateMap.get(externalGameId) ?? {
    externalGameId,
    title: game?.title ?? game?.gameName ?? `Steam App ${externalGameId}`,
    ownedFriendIds: new Set(),
    recentFriendIds: new Set()
  };

  if (signalType === 'recent') {
    existingCandidate.recentFriendIds.add(friendSteamId);
  } else {
    existingCandidate.ownedFriendIds.add(friendSteamId);
  }

  aggregateMap.set(externalGameId, existingCandidate);
}

function hasSteamSocialPlayTag(tags, tagKeySet) {
  return (tags ?? []).some((tag) => {
    const normalizedTag = normalizeSteamGenreTag(tag);
    return normalizedTag ? tagKeySet.has(normalizedTag) : false;
  });
}

function buildSteamFriendRecommendationReason({
  friendCount,
  recentFriendCount,
  hasMultiplayerSupport,
  hasCoopSupport
}) {
  if (recentFriendCount > 0 && hasCoopSupport) {
    return `Steam 친구 ${friendCount}명이 플레이 중인 협동 게임이에요`;
  }

  if (recentFriendCount > 0 && hasMultiplayerSupport) {
    return `Steam 친구 ${friendCount}명이 플레이 중인 멀티플레이 게임이에요`;
  }

  if (recentFriendCount > 0) {
    return `Steam 친구 ${friendCount}명이 플레이 중이에요`;
  }

  if (hasCoopSupport) {
    return `Steam 친구 ${friendCount}명이 보유 중인 협동 게임이에요`;
  }

  if (hasMultiplayerSupport) {
    return `Steam 친구 ${friendCount}명이 보유 중인 멀티플레이 게임이에요`;
  }

  return `Steam 친구 ${friendCount}명이 보유 중이에요`;
}

function scoreSteamFriendRecommendation({
  friendCount,
  recentFriendCount,
  hasMultiplayerSupport,
  hasCoopSupport
}) {
  return (friendCount * 10) +
    (recentFriendCount * 6) +
    (hasMultiplayerSupport ? 3 : 0) +
    (hasCoopSupport ? 2 : 0);
}

function mapFriendPrivacySettings(settings) {
  return {
    showRecentlyPlayed: settings?.showRecentlyPlayed ?? DEFAULT_FRIEND_PRIVACY_SETTINGS.showRecentlyPlayed,
    showLikedGames: settings?.showLikedGames ?? DEFAULT_FRIEND_PRIVACY_SETTINGS.showLikedGames,
    showReviews: settings?.showReviews ?? DEFAULT_FRIEND_PRIVACY_SETTINGS.showReviews
  };
}

function buildRecommendationCandidateKey({ gameSource, externalGameId, igdbGameId = null }) {
  const normalizedIgdbGameId = normalizeIgdbGameId(igdbGameId ?? externalGameId);

  if ((gameSource === GameSource.IGDB || gameSource === 'igdb') && normalizedIgdbGameId) {
    return `igdb:${normalizedIgdbGameId}`;
  }

  if (normalizedIgdbGameId && (gameSource === GameSource.STEAM || gameSource === 'steam') === false) {
    return `igdb:${normalizedIgdbGameId}`;
  }

  const normalizedExternalGameId = typeof externalGameId === 'string'
    ? externalGameId.trim()
    : String(externalGameId ?? '').trim();

  if (!normalizedExternalGameId) {
    return null;
  }

  return `${String(gameSource).toLowerCase()}:${normalizedExternalGameId}`;
}

function buildRecommendationCandidateKeyFromLibraryEntry(entry, steamMappingContext, userId = null) {
  if (!entry) {
    return null;
  }

  if (entry.gameSource === GameSource.STEAM) {
    const mappingOptions = buildSteamLibraryEntryMappingOptions(entry.externalGameId, steamMappingContext, userId);

    if (mappingOptions.igdbGameId) {
      return buildRecommendationCandidateKey({
        gameSource: GameSource.IGDB,
        externalGameId: mappingOptions.igdbGameId
      });
    }
  }

  return buildRecommendationCandidateKey({
    gameSource: entry.gameSource,
    externalGameId: entry.externalGameId
  });
}

function buildRecommendationResponse({
  pagination,
  sort,
  source = FRIEND_RECOMMENDATION_SOURCE.NONE,
  items = [],
  emptyReason = null,
  metadata = {}
}) {
  return {
    source,
    items,
    recommendations: items,
    friendRecommendations: items,
    emptyReason,
    metadata,
    meta: buildPaginatedMeta({
      page: pagination.page,
      limit: pagination.limit,
      totalCount: items.length,
      sort
    })
  };
}

function buildFriendRecommendationState({
  previewMode = false,
  source = FRIEND_RECOMMENDATION_SOURCE.NONE,
  metadata = {}
}) {
  if (previewMode && metadata?.steamReason === 'preview_live_steam_disabled') {
    return {
      status: 'deferred',
      reason: 'preview_live_steam_disabled'
    };
  }

  return {
    status: 'ready',
    source: source === FRIEND_RECOMMENDATION_SOURCE.NONE ? 'fallback' : source
  };
}

function buildPaginatedRecommendationResponse({
  pagination,
  sort,
  source,
  items,
  totalCount,
  emptyReason = null,
  metadata = {}
}) {
  return {
    source,
    items,
    recommendations: items,
    friendRecommendations: items,
    emptyReason,
    metadata,
    meta: buildPaginatedMeta({
      page: pagination.page,
      limit: pagination.limit,
      totalCount,
      sort
    })
  };
}

function buildInAppFriendRecommendationReason({
  friendCount,
  recentFriendCount,
  likedFriendCount,
  highRatedFriendCount
}) {
  if (highRatedFriendCount > 0 && recentFriendCount > 0) {
    return '비슷한 친구들이 최근 플레이하고 높게 평가했어요';
  }

  if (highRatedFriendCount > 0) {
    return '친구가 높게 평가한 게임이에요';
  }

  if (recentFriendCount > 0) {
    return `친구 ${recentFriendCount}명이 최근 플레이했어요`;
  }

  if (likedFriendCount > 0) {
    return `친구 ${likedFriendCount}명이 찜한 게임이에요`;
  }

  return `친구 ${friendCount}명이 보유 중이에요`;
}

function scoreInAppFriendRecommendation({
  friendCount,
  recentFriendCount,
  likedFriendCount,
  highRatedFriendCount,
  ownedFriendCount
}) {
  return (highRatedFriendCount * 12) +
    (recentFriendCount * 10) +
    (likedFriendCount * 7) +
    (ownedFriendCount * 5) +
    (friendCount * 4);
}

function buildIgdbRecommendationItem(gameId, igdbGame) {
  const normalizedGameId = normalizeIgdbGameId(gameId);
  const detailPayload = buildNormalizedDetailPayload({
    endpoint: 'library_friend_recommendations',
    title: igdbGame?.name ?? null,
    externalGameId: normalizedGameId,
    igdbGameId: normalizedGameId,
    reason: normalizedGameId ? null : 'invalid_igdb_recommendation_id',
    mappingStatus: 'DIRECT_IGDB',
    mappingSource: 'igdb'
  });

  if (igdbGame) {
    const item = {
      ...igdbGame,
      source: 'igdb',
      gameSource: 'igdb',
      externalGameId: normalizedGameId,
      metadataEnriched: true,
      title: igdbGame.name,
      gameName: igdbGame.name,
      ...detailPayload
    };

    logRecommendationRatingPayload({
      endpoint: 'library_friend_recommendations',
      title: item.title,
      externalGameId: item.externalGameId,
      igdbGameId: item.igdbGameId,
      aggregatedRating: item.aggregatedRating,
      totalRating: item.totalRating,
      rating: item.rating,
      detailAvailable: item.detailAvailable
    });

    return item;
  }

  const item = {
    source: 'igdb',
    gameSource: 'igdb',
    externalGameId: normalizedGameId,
    metadataEnriched: false,
    title: `IGDB Game ${normalizedGameId}`,
    gameName: null,
    coverUrl: null,
    rating: null,
    aggregatedRating: null,
    totalRating: null,
    ...detailPayload
  };

  logRecommendationRatingPayload({
    endpoint: 'library_friend_recommendations',
    title: item.title,
    externalGameId: item.externalGameId,
    igdbGameId: item.igdbGameId,
    aggregatedRating: item.aggregatedRating,
    totalRating: item.totalRating,
    rating: item.rating,
    detailAvailable: item.detailAvailable
  });

  return item;
}

function normalizePaginationNumber(value, fallbackValue) {
  const parsedValue = Number.parseInt(value, 10);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function resolvePaginationParams({
  page,
  limit,
  defaultLimit = LIBRARY_FULL_DEFAULT_LIMIT
} = {}) {
  const resolvedPage = normalizePaginationNumber(page, 1);
  const resolvedLimit = Math.min(
    normalizePaginationNumber(limit, defaultLimit),
    LIBRARY_FULL_MAX_LIMIT
  );

  return {
    page: resolvedPage,
    limit: resolvedLimit,
    skip: (resolvedPage - 1) * resolvedLimit
  };
}

function buildPaginatedMeta({
  page,
  limit,
  totalCount,
  sort
}) {
  return {
    page,
    limit,
    totalCount,
    totalPages: totalCount > 0 ? Math.ceil(totalCount / limit) : 0,
    sort
  };
}

function paginateItems(items, { page, limit }) {
  const totalCount = Array.isArray(items) ? items.length : 0;
  const skip = (page - 1) * limit;

  return {
    items: (items ?? []).slice(skip, skip + limit),
    totalCount
  };
}

function addWeightedLabels(targetMap, labels, weight) {
  if (!(targetMap instanceof Map) || !Array.isArray(labels) || !(weight > 0)) {
    return;
  }

  const uniqueLabels = [...new Set(
    labels
      .map((label) => normalizeSteamGenreTag(label))
      .filter(Boolean)
  )];

  for (const label of uniqueLabels) {
    targetMap.set(label, (targetMap.get(label) ?? 0) + weight);
  }
}

function getWeightedMapTotal(weightMap) {
  return [...weightMap.values()].reduce((sum, value) => sum + value, 0);
}

function computeWeightedOverlap(weightMap, labels) {
  if (!(weightMap instanceof Map) || weightMap.size === 0) {
    return 0;
  }

  const totalWeight = getWeightedMapTotal(weightMap);

  if (totalWeight <= 0) {
    return 0;
  }

  const normalizedLabels = new Set(
    (labels ?? [])
      .map((label) => normalizeSteamGenreTag(label))
      .filter(Boolean)
  );
  let matchedWeight = 0;

  for (const label of normalizedLabels) {
    matchedWeight += weightMap.get(label) ?? 0;
  }

  return Math.min(1, matchedWeight / totalWeight);
}

function classifySessionPreference(averageRecentPlaytimeMinutes) {
  if (!Number.isFinite(averageRecentPlaytimeMinutes) || averageRecentPlaytimeMinutes <= 0) {
    return 'balanced';
  }

  if (averageRecentPlaytimeMinutes >= 300) {
    return 'long';
  }

  if (averageRecentPlaytimeMinutes <= 90) {
    return 'short';
  }

  return 'balanced';
}

function classifyGameplayPace(labels) {
  const normalizedLabels = (labels ?? [])
    .map((label) => normalizeSteamGenreTag(label))
    .filter(Boolean);

  if (normalizedLabels.some((label) => LONG_PACE_TAG_KEYS.has(label))) {
    return 'long';
  }

  if (normalizedLabels.some((label) => SHORT_PACE_TAG_KEYS.has(label))) {
    return 'short';
  }

  return 'balanced';
}

function computePaceSimilarity(sessionPreference, candidatePace) {
  if (sessionPreference === candidatePace) {
    return 1;
  }

  if (sessionPreference === 'balanced' || candidatePace === 'balanced') {
    return 0.65;
  }

  return 0.25;
}

function buildPlaytimeMatchedSignals({
  genreScore,
  tagScore,
  recentAffinityScore,
  playPatternScore,
  paceScore
}) {
  const matchedSignals = [];

  if (recentAffinityScore >= 0.2) {
    matchedSignals.push('recent_play_similarity');
  }

  if (genreScore >= 0.2) {
    matchedSignals.push('genre_match');
  }

  if (tagScore >= 0.18) {
    matchedSignals.push('tag_match');
  }

  if (playPatternScore >= 0.6) {
    matchedSignals.push('playtime_pattern_match');
  }

  if (paceScore >= 0.6) {
    matchedSignals.push('gameplay_pace_match');
  }

  return matchedSignals;
}

function buildPlaytimeRecommendationReason({
  recentAffinityScore,
  genreScore,
  tagScore,
  playPatternScore,
  paceScore
}) {
  const rankedSignals = [
    { key: 'recent', score: recentAffinityScore, reason: '최근 오래 플레이한 게임과 비슷해요' },
    { key: 'genre', score: genreScore, reason: '자주 즐기는 장르와 잘 맞아요' },
    { key: 'tag', score: tagScore, reason: '선호하는 태그와 분위기가 비슷해요' },
    { key: 'pattern', score: playPatternScore, reason: '평소 플레이 시간 패턴과 잘 맞아요' },
    { key: 'pace', score: paceScore, reason: '좋아하는 플레이 템포와 잘 맞아요' }
  ].sort((left, right) => right.score - left.score);

  return rankedSignals[0]?.reason ?? '플레이 성향과 잘 맞는 게임이에요';
}

function selectDiverseRecommendations(candidates, limit) {
  const remainingCandidates = [...candidates];
  const selectedCandidates = [];
  const primaryGenreCounts = new Map();

  while (remainingCandidates.length > 0 && selectedCandidates.length < limit) {
    remainingCandidates.sort((left, right) => {
      const leftPenalty = (primaryGenreCounts.get(left.primaryGenreKey) ?? 0) * 6;
      const rightPenalty = (primaryGenreCounts.get(right.primaryGenreKey) ?? 0) * 6;
      return (right.recommendationScore - rightPenalty) - (left.recommendationScore - leftPenalty);
    });

    const nextCandidate = remainingCandidates.shift();

    selectedCandidates.push(nextCandidate);
    primaryGenreCounts.set(
      nextCandidate.primaryGenreKey,
      (primaryGenreCounts.get(nextCandidate.primaryGenreKey) ?? 0) + 1
    );
  }

  return selectedCandidates;
}

async function buildIgdbGameMap(gameIds) {
  if (!Array.isArray(gameIds) || gameIds.length === 0) {
    return new Map();
  }

  const normalizedGameIds = [...new Set(gameIds.map((gameId) => String(gameId).trim()).filter(Boolean))].sort();
  const normalizedKey = buildNormalizedSetCacheKey(normalizedGameIds);

  return memoizeLibraryRequestPromise('igdbBatchByKey', normalizedKey, async () => {
    if (activeIgdbBatchPromises.has(normalizedKey)) {
      logger.info('igdb-batch-coalesced', {
        cacheKey: normalizedKey,
        hit: true
      });
      return activeIgdbBatchPromises.get(normalizedKey);
    }

    const batchPromise = (async () => {
      try {
        const { games, meta } = await igdbService.getGamesByIds({ gameIds: normalizedGameIds });

        if (meta?.liveFetchSkippedReason === 'rate_limited') {
          logger.warn('Library IGDB hydration served cached subset during rate limit', {
            gameCount: gameIds.length,
            cachedCount: meta.cacheCount ?? 0,
            missingCount: Array.isArray(meta.missingGameIds) ? meta.missingGameIds.length : 0
          });
        }

        return new Map(games.map((game) => [String(game.id), game]));
      } catch (error) {
        logger.warn('Library IGDB hydration skipped', {
          code: error?.code,
          message: error?.message,
          gameCount: gameIds.length
        });
        return new Map();
      }
    })();

    activeIgdbBatchPromises.set(normalizedKey, batchPromise);

    try {
      return await batchPromise;
    } finally {
      activeIgdbBatchPromises.delete(normalizedKey);
    }
  });
}

async function getCachedSteamMappingContext(externalGameIds, userId = null) {
  const normalizedExternalGameIds = [...new Set(
    (externalGameIds ?? [])
      .map((externalGameId) => (typeof externalGameId === 'string' ? externalGameId.trim() : ''))
      .filter(Boolean)
  )];

  if (normalizedExternalGameIds.length === 0) {
    return {
      mappingMap: new Map(),
      igdbGameMap: new Map()
    };
  }

  const mappings = await prisma.steamIgdbMapping.findMany({
    where: {
      steamAppId: {
        in: normalizedExternalGameIds
      }
    }
  });
  const mappingMap = new Map(mappings.map((mapping) => [mapping.steamAppId, mapping]));
  const acceptedIgdbIds = mappings
    .filter(isAcceptedSteamIgdbMapping)
    .map((mapping) => mapping.igdbGameId);
  const igdbGameMap = await buildIgdbGameMap(acceptedIgdbIds);

  if (TARGET_STEAM_DEBUG_APP_IDS.has('3321460') && normalizedExternalGameIds.includes('3321460')) {
    const targetMapping = mappingMap.get('3321460') ?? null;
    const targetIgdbGameId = targetMapping?.igdbGameId ? normalizeIgdbGameId(targetMapping.igdbGameId) : null;
    const sourceSnapshot = await getTargetSteamLibrarySourceSnapshot('3321460', userId);
    const targetRawSteamTitle = sourceSnapshot?.userScopedRow?.gameName
      ?? sourceSnapshot?.anyScopedTitledRow?.gameName
      ?? sourceSnapshot?.anyScopedRow?.gameName
      ?? null;

    logTargetSteamAppIdDebugSummary({
      stage: 'initial_lookup',
      context: 'list_mapping_lookup',
      userId,
      externalGameId: '3321460',
      rawSteamTitle: targetRawSteamTitle,
      normalizedSteamTitle: targetRawSteamTitle
        ? steamIgdbMatchService.normalizeSteamTitle(targetRawSteamTitle).strippedComparisonTitle
        : null,
      mappingRow: targetMapping,
      mappingAccepted: isAcceptedSteamIgdbMapping(targetMapping),
      cachedIgdbDetailExists: targetIgdbGameId ? Boolean(igdbService.getCachedGameDetail(targetIgdbGameId)) : false,
      liveIgdbDetailAttempted: false,
      liveIgdbDetailFound: false,
      finalEnrichmentStatus: isAcceptedSteamIgdbMapping(targetMapping)
        ? resolveSteamEnrichmentStatus({
          gameSource: 'steam',
          metadataEnriched: Boolean(targetIgdbGameId && igdbGameMap.get(targetIgdbGameId)),
          matchStatus: targetMapping?.matchStatus ?? null
        })
        : null,
      finalFallbackReason: null,
      steamOnlyFallbackCacheExists: false,
      steamOnlyFallbackCacheRead: false
    });
  }

  return {
    mappingMap,
    igdbGameMap
  };
}

function buildSteamLibraryEntryMappingOptions(externalGameId, steamMappingContext, userId = null) {
  const mapping = steamMappingContext.mappingMap.get(externalGameId) ?? null;
  const igdbGameId = isAcceptedSteamIgdbMapping(mapping)
    ? normalizeIgdbGameId(mapping.igdbGameId)
    : null;
  const hydratedIgdbGame = igdbGameId ? (steamMappingContext.igdbGameMap.get(igdbGameId) ?? null) : null;
  const igdbCoverUrl = extractUsableIgdbCoverUrl(hydratedIgdbGame?.coverUrl);
  const metadataEnriched = Boolean(igdbGameId);

  if (
    TARGET_STEAM_DEBUG_APP_IDS.has(typeof externalGameId === 'string' ? externalGameId.trim() : '') &&
    mapping
  ) {
    logTargetSteamAppIdDebugSummary({
      stage: 'initial_lookup',
      context: 'list_mapping_options',
      userId,
      externalGameId,
      mappingRow: mapping,
      mappingAccepted: isAcceptedSteamIgdbMapping(mapping),
      cachedIgdbDetailExists: igdbGameId ? Boolean(igdbService.getCachedGameDetail(igdbGameId)) : false,
      liveIgdbDetailAttempted: false,
      liveIgdbDetailFound: false,
      finalEnrichmentStatus: isAcceptedSteamIgdbMapping(mapping)
        ? resolveSteamEnrichmentStatus({
          gameSource: 'steam',
          metadataEnriched,
          matchStatus: mapping?.matchStatus ?? null
        })
        : null,
      finalFallbackReason: null,
      steamOnlyFallbackCacheExists: false,
      steamOnlyFallbackCacheRead: false
    });
  }

  return {
    igdbGameId,
    igdbCoverUrl,
    rating: typeof hydratedIgdbGame?.rating === 'number' ? hydratedIgdbGame.rating : null,
    aggregatedRating: typeof hydratedIgdbGame?.aggregatedRating === 'number' ? hydratedIgdbGame.aggregatedRating : null,
    totalRating: typeof hydratedIgdbGame?.totalRating === 'number' ? hydratedIgdbGame.totalRating : null,
    matchStatus: mapping?.matchStatus ?? null,
    metadataEnriched
  };
}

function buildIgdbLibraryEntryMappingOptions(externalGameId, igdbGameMap) {
  const igdbGameId = normalizeIgdbGameId(externalGameId);
  const hydratedIgdbGame = igdbGameId ? (igdbGameMap.get(igdbGameId) ?? null) : null;

  return {
    igdbGameId,
    rating: typeof hydratedIgdbGame?.rating === 'number' ? hydratedIgdbGame.rating : null,
    aggregatedRating: typeof hydratedIgdbGame?.aggregatedRating === 'number' ? hydratedIgdbGame.aggregatedRating : null,
    totalRating: typeof hydratedIgdbGame?.totalRating === 'number' ? hydratedIgdbGame.totalRating : null,
    metadataEnriched: Boolean(igdbGameId && igdbGameMap.get(igdbGameId))
  };
}

function createEmptySteamMappingContext() {
  return {
    mappingMap: new Map(),
    igdbGameMap: new Map()
  };
}

function buildSteamMatchCandidates(items) {
  return (items ?? [])
    .map((item) => ({
      userId: item?.userId ?? null,
      externalGameId: item?.externalGameId,
      gameName: item?.gameName ?? item?.title ?? null,
      title: item?.title ?? item?.gameName ?? null
    }))
    .filter((item) => typeof item.externalGameId === 'string' && item.externalGameId.trim().length > 0);
}

function mergeSteamMappingContexts(baseContext, resolutionResult) {
  const mergedMappingMap = new Map(baseContext?.mappingMap ?? []);
  const mergedIgdbGameMap = new Map(baseContext?.igdbGameMap ?? []);

  if (resolutionResult?.mappings instanceof Map) {
    for (const [steamAppId, mapping] of resolutionResult.mappings.entries()) {
      mergedMappingMap.set(steamAppId, mapping);

      if (mapping?.igdbGame?.id) {
        mergedIgdbGameMap.set(String(mapping.igdbGame.id), mapping.igdbGame);
      }
    }
  }

  return {
    mappingMap: mergedMappingMap,
    igdbGameMap: mergedIgdbGameMap
  };
}

async function resolveSteamMappingContextForGames({
  games,
  activeResolution = false,
  createMissingMappingsWhenUncached = false,
  logLabel = 'steam-library-matching',
  userId = null
}) {
  const steamAppIds = [...new Set(
    (games ?? [])
      .map((game) => (typeof game?.externalGameId === 'string' ? game.externalGameId.trim() : ''))
      .filter(Boolean)
  )];

  if (steamAppIds.length === 0) {
    return {
      mappingContext: createEmptySteamMappingContext(),
      resolutionSummary: {
        steamAppIdCount: 0,
        cachedConfirmedCount: 0,
        unmatchedCountBeforeResolution: 0,
        externalGamesResolvedCount: 0,
        titleFallbackResolvedCount: 0,
        unmatchedCountAfterResolution: 0
      }
    };
  }

  const requestMemoKey = [
    activeResolution || createMissingMappingsWhenUncached ? 'resolve-missing' : 'cached-only',
    buildNormalizedSetCacheKey(steamAppIds)
  ].join('|');

  return memoizeLibraryRequestPromise('mappingResolutionByAppIdSet', requestMemoKey, async () => {
    const cachedContext = await getCachedSteamMappingContext(steamAppIds, userId);

    if (!activeResolution && !createMissingMappingsWhenUncached) {
      const cachedConfirmedCount = steamAppIds.filter((steamAppId) => {
        const mapping = cachedContext.mappingMap.get(steamAppId);
        return isAcceptedSteamIgdbMapping(mapping);
      }).length;

      return {
        mappingContext: cachedContext,
        resolutionSummary: {
          steamAppIdCount: steamAppIds.length,
          cachedConfirmedCount,
          unmatchedCountBeforeResolution: steamAppIds.length - cachedConfirmedCount,
          externalGamesResolvedCount: 0,
          titleFallbackResolvedCount: 0,
          unmatchedCountAfterResolution: steamAppIds.length - cachedConfirmedCount
        }
      };
    }

    const gamesNeedingResolution = activeResolution
      ? (games ?? [])
      : (games ?? []).filter((game) => {
        const externalGameId = typeof game?.externalGameId === 'string' ? game.externalGameId.trim() : '';
        return externalGameId && !cachedContext.mappingMap.has(externalGameId);
      });

    if (gamesNeedingResolution.length === 0) {
      const cachedConfirmedCount = steamAppIds.filter((steamAppId) => {
        const mapping = cachedContext.mappingMap.get(steamAppId);
        return isAcceptedSteamIgdbMapping(mapping);
      }).length;

      return {
        mappingContext: cachedContext,
        resolutionSummary: {
          steamAppIdCount: steamAppIds.length,
          cachedConfirmedCount,
          unmatchedCountBeforeResolution: steamAppIds.length - cachedConfirmedCount,
          externalGamesResolvedCount: 0,
          titleFallbackResolvedCount: 0,
          unmatchedCountAfterResolution: steamAppIds.length - cachedConfirmedCount
        }
      };
    }

    const resolutionStartTime = Date.now();
    const resolutionResult = await steamIgdbMatchService.resolveSteamGameMappings(
      buildSteamMatchCandidates(gamesNeedingResolution).map((game) => ({
        ...game,
        userId: game.userId ?? userId ?? null
      }))
    );
    const elapsedMs = Date.now() - resolutionStartTime;

    logger.info('Steam unmatched mapping resolution timing', {
      userId,
      logLabel,
      elapsedMs,
      steamAppIdCount: resolutionResult?.resolutionSummary?.steamAppIdCount ?? steamAppIds.length,
      unmatchedCountBeforeResolution: resolutionResult?.resolutionSummary?.unmatchedCountBeforeResolution ?? null,
      unmatchedCountAfterResolution: resolutionResult?.resolutionSummary?.unmatchedCountAfterResolution ?? null
    });

    return {
      mappingContext: mergeSteamMappingContexts(cachedContext, resolutionResult),
      resolutionSummary: resolutionResult?.resolutionSummary ?? {
        steamAppIdCount: steamAppIds.length,
        cachedConfirmedCount: 0,
        unmatchedCountBeforeResolution: steamAppIds.length,
        externalGamesResolvedCount: 0,
        titleFallbackResolvedCount: 0,
        unmatchedCountAfterResolution: steamAppIds.length
      }
    };
  });
}

function mapSteamRecentlyPlayedGames(games, steamMappingContext, userId = null, endpoint = 'library_recently_played') {
  const mappedGames = (games ?? []).map((game) => {
    const mappingOptions = buildSteamLibraryEntryMappingOptions(game.externalGameId, steamMappingContext, userId);
    const detailPayload = buildNormalizedDetailPayload({
      endpoint,
      title: game?.title ?? null,
      externalGameId: game.externalGameId,
      igdbGameId: mappingOptions.igdbGameId,
      reason: mappingOptions.igdbGameId ? null : 'steam_mapping_missing_for_recent_play',
      mappingStatus: mappingOptions.matchStatus ?? null,
      mappingSource: mappingOptions.metadataEnriched ? 'confirmed_mapping' : 'steam_recent_played'
    });
    const coverUrl = buildGameImageResolverUrl({
      gameSource: 'steam',
      externalGameId: game.externalGameId,
      igdbCoverUrl: mappingOptions.igdbCoverUrl
    });
    const hasReliableLastPlayedAt = game?.hasReliableLastPlayedAt === true;
    const lastPlayedAtSource = typeof game?.lastPlayedAtSource === 'string' && game.lastPlayedAtSource.trim()
      ? game.lastPlayedAtSource.trim()
      : 'snapshot_without_timestamp';
    const fallbackReason = !hasReliableLastPlayedAt
      ? (typeof game?.fallbackReason === 'string' && game.fallbackReason.trim()
        ? game.fallbackReason.trim()
        : 'timestamp_unavailable')
      : null;

    logger.info('library-recent-play-item-timestamp', {
      userId,
      externalGameId: game.externalGameId,
      inclusionSource: game?.inclusionSource ?? 'snapshot',
      lastPlayedAtSource,
      lastPlayedAt: game?.lastPlayedAt ?? null,
      hasReliableLastPlayedAt,
      fallbackReason
    });
    logger.info('[RecentPlayedFinalItem]', {
      endpoint,
      externalGameId: game.externalGameId,
      title: game?.title ?? null,
      recentPlaytimeMinutes: game?.recentPlaytimeMinutes ?? null,
      lastPlayedAt: game?.lastPlayedAt ?? null,
      hasReliableLastPlayedAt,
      lastPlayedAtSource,
      fallbackReason,
      inclusionSource: game?.inclusionSource ?? 'snapshot'
    });
    logRecentPlayDetailPayload({
      endpoint,
      title: game?.title ?? null,
      externalGameId: game.externalGameId,
      igdbGameId: detailPayload.igdbGameId,
      detailAvailable: detailPayload.detailAvailable,
      mappingStatus: detailPayload.mappingStatus,
      mappingSource: detailPayload.mappingSource
    });

    return {
      ...game,
      coverUrl,
      gameSource: 'steam',
      gameName: game.title,
      gameId: detailPayload.gameId,
      rating: typeof mappingOptions.rating === 'number' ? mappingOptions.rating : null,
      aggregatedRating: typeof mappingOptions.aggregatedRating === 'number' ? mappingOptions.aggregatedRating : null,
      totalRating: typeof mappingOptions.totalRating === 'number' ? mappingOptions.totalRating : null,
      lastPlayedAt: game?.lastPlayedAt ?? null,
      lastPlayedAtSource,
      hasReliableLastPlayedAt,
      metadataEnriched: mappingOptions.metadataEnriched,
      enrichmentStatus: resolveSteamEnrichmentStatus({
        gameSource: 'steam',
        metadataEnriched: mappingOptions.metadataEnriched,
        matchStatus: mappingOptions.matchStatus
      }),
      ...detailPayload
    };
  });

  const reliableTimestampCount = mappedGames.filter((game) => game.hasReliableLastPlayedAt).length;
  const snapshotWithoutTimestampCount = mappedGames.filter((game) => game.lastPlayedAtSource === 'snapshot_without_timestamp').length;

  logger.info('library-recent-play-response', {
    userId,
    totalCount: mappedGames.length,
    reliableTimestampCount,
    snapshotWithoutTimestampCount,
    noTimestampCount: mappedGames.length - reliableTimestampCount
  });

  return mappedGames;
}

function buildSteamFallbackDetailGame({
  externalGameId,
  gameName,
  coverUrl,
  playtimeMinutes,
  recentPlaytimeMinutes,
  genreDisplayName,
  genreSource,
  igdbGameId = null,
  enrichmentStatus = 'steam_only'
}) {
  const resolvedGameName = typeof gameName === 'string' && gameName.trim()
    ? gameName.trim()
    : `Steam App ${externalGameId}`;

  return {
    id: null,
    name: resolvedGameName,
    summary: STEAM_FALLBACK_DESCRIPTION,
    storyline: null,
    coverUrl,
    artworkUrls: [],
    screenshotUrls: [],
    genres: [],
    platforms: ['Steam'],
    developers: [],
    publishers: [],
    rating: null,
    aggregatedRating: null,
    totalRating: null,
    releaseDate: null,
    status: null,
    category: null,
    videoIds: [],
    similarGames: [],
    source: 'steam',
    gameSource: 'steam',
    externalGameId,
    gameName: resolvedGameName,
    igdbGameId: normalizeIgdbGameId(igdbGameId),
    metadataEnriched: false,
    enrichmentStatus,
    detailAvailable: true,
    playtimeMinutes: Number.isInteger(playtimeMinutes) ? playtimeMinutes : null,
    recentPlaytimeMinutes: Number.isInteger(recentPlaytimeMinutes) ? recentPlaytimeMinutes : null,
    genreDisplayName: typeof genreDisplayName === 'string' && genreDisplayName.trim() ? genreDisplayName.trim() : null,
    genreSource: typeof genreSource === 'string' && genreSource.trim() ? genreSource.trim() : null,
    description: STEAM_FALLBACK_DESCRIPTION
  };
}

function buildSteamOnlyPlaytimeFallbackReason(entry) {
  if (Number.isInteger(entry?.recentPlaytimeMinutes) && entry.recentPlaytimeMinutes > 0) {
    return '최근 Steam 플레이 기록을 기반으로 추천했어요';
  }

  if (Number.isInteger(entry?.playtimeMinutes) && entry.playtimeMinutes > 0) {
    return 'Steam 플레이 시간이 높은 게임을 우선 추천했어요';
  }

  return 'Steam 보관함 데이터를 기반으로 추천했어요';
}

function buildSteamOnlyPlaytimeRecommendations({
  steamLibraryEntries,
  steamMappingContext,
  userId,
  pagination,
  sort = 'score_desc'
}) {
  const fallbackCandidates = [...(steamLibraryEntries ?? [])]
    .filter((entry) => typeof entry?.externalGameId === 'string' && entry.externalGameId.trim().length > 0)
    .sort((left, right) => {
      const rightRecent = Number.isInteger(right?.recentPlaytimeMinutes) ? right.recentPlaytimeMinutes : -1;
      const leftRecent = Number.isInteger(left?.recentPlaytimeMinutes) ? left.recentPlaytimeMinutes : -1;

      if (rightRecent !== leftRecent) {
        return rightRecent - leftRecent;
      }

      const rightPlaytime = Number.isInteger(right?.playtimeMinutes) ? right.playtimeMinutes : -1;
      const leftPlaytime = Number.isInteger(left?.playtimeMinutes) ? left.playtimeMinutes : -1;

      if (rightPlaytime !== leftPlaytime) {
        return rightPlaytime - leftPlaytime;
      }

      const rightUpdatedAt = right?.updatedAt instanceof Date ? right.updatedAt.getTime() : 0;
      const leftUpdatedAt = left?.updatedAt instanceof Date ? left.updatedAt.getTime() : 0;
      return rightUpdatedAt - leftUpdatedAt;
    })
    .map((entry, index) => {
      const mappingOptions = buildSteamLibraryEntryMappingOptions(entry.externalGameId, steamMappingContext, userId);
      const mappedEntry = mapLibraryStatusEntry(entry, mappingOptions);
      const recommendationScore = Math.max(
        1,
        Math.round(
          (Number.isInteger(entry.recentPlaytimeMinutes) ? Math.log1p(entry.recentPlaytimeMinutes) * 18 : 0) +
          (Number.isInteger(entry.playtimeMinutes) ? Math.log1p(entry.playtimeMinutes) * 7 : 0) +
          Math.max(0, 20 - index)
        )
      );

      return {
        ...mappedEntry,
        recommendationScore,
        reason: buildSteamOnlyPlaytimeFallbackReason(entry),
        matchedSignals: [
          ...(Number.isInteger(entry.recentPlaytimeMinutes) && entry.recentPlaytimeMinutes > 0
            ? ['recent_play_similarity']
            : []),
          'steam_library_playtime_fallback'
        ],
        source: 'steam',
        gameSource: 'steam'
      };
    });
  const { items, totalCount } = paginateItems(fallbackCandidates, pagination);

  return {
    recommendations: items,
    playtimeRecommendations: items,
    meta: buildPaginatedMeta({
      page: pagination.page,
      limit: pagination.limit,
      totalCount,
      sort
    }),
    source: 'steam_only_fallback',
    enrichmentStatus: 'partial',
    responseMeta: buildLibraryResponseMeta({
      isPartialFailure: true
    })
  };
}

async function buildRecentlyPlayedResult({
  userId,
  steamAccount,
  page = 1,
  limit,
  activeSteamMatching = true
}) {
  if (!steamAccount) {
    logger.info('Steam recently played sync skipped', {
      userId,
      reason: 'missing_steam_account'
    });

    return {
      games: [],
      totalCount: 0,
      steamSyncAvailable: false,
      steamSyncErrorCode: null,
      steamSyncStatus: STEAM_SYNC_STATUS.NOT_CONNECTED,
      lastSteamSyncAt: null
    };
  }

  const steamId64 = steamService.normalizeSteamId64(steamAccount.providerSubject);

  if (!steamId64) {
    const steamSyncErrorCode = 'STEAM_CONNECTION_EXPIRED';

    logger.warn('Steam recently played sync skipped', {
      userId,
      reason: 'missing_provider_subject',
      providerSubject: steamAccount.providerSubject ?? null,
      steamSyncStatus: STEAM_SYNC_STATUS.TOKEN_EXPIRED
    });

    return {
      games: [],
      totalCount: 0,
      steamSyncAvailable: false,
      steamSyncErrorCode,
      steamSyncStatus: STEAM_SYNC_STATUS.TOKEN_EXPIRED,
      lastSteamSyncAt: steamAccount.lastSteamSyncAt ?? null
    };
  }

  if (!steamService.isSteamSyncConfigured()) {
    logger.warn('Steam recently played sync skipped', {
      userId,
      reason: 'missing_steam_api_key',
      steamId: steamId64,
      code: 'STEAM_API_NOT_CONFIGURED',
      message: 'Steam integration is not configured',
      steamSyncStatus: STEAM_SYNC_STATUS.FAILED
    });

    return {
      games: [],
      totalCount: 0,
      steamSyncAvailable: false,
      steamSyncErrorCode: 'STEAM_API_NOT_CONFIGURED',
      steamSyncStatus: STEAM_SYNC_STATUS.FAILED,
      lastSteamSyncAt: steamAccount.lastSteamSyncAt ?? null
    };
  }

  try {
    const result = await fetchRecentlyPlayedGamesDedup({
      userId,
      steamId64
    });
    const totalCount = result.games.length;
    const pagination = resolvePaginationParams({
      page,
      limit,
      defaultLimit: totalCount || LIBRARY_FULL_DEFAULT_LIMIT
    });
    const limitedGames = Number.isInteger(limit) && limit > 0
      ? result.games.slice(pagination.skip, pagination.skip + pagination.limit)
      : result.games;
    const {
      mappingContext,
      resolutionSummary
    } = await resolveSteamMappingContextForGames({
      games: limitedGames,
      activeResolution: activeSteamMatching,
      createMissingMappingsWhenUncached: true,
      logLabel: activeSteamMatching ? 'recently-played-full' : 'recently-played-preview',
      userId
    });
    const enrichedGames = mapSteamRecentlyPlayedGames(limitedGames, mappingContext, userId);

    if (activeSteamMatching && resolutionSummary.unmatchedCountBeforeResolution > 0) {
      logger.info('steam-recently-played-match-summary', {
        userId,
        steamAppIdCount: resolutionSummary.steamAppIdCount,
        cachedConfirmedCount: resolutionSummary.cachedConfirmedCount,
        unmatchedCountBeforeResolution: resolutionSummary.unmatchedCountBeforeResolution,
        externalGamesResolvedCount: resolutionSummary.externalGamesResolvedCount,
        titleFallbackResolvedCount: resolutionSummary.titleFallbackResolvedCount,
        unmatchedCountAfterResolution: resolutionSummary.unmatchedCountAfterResolution
      });
    }

    if (result.syncWarningCode) {
      logger.warn('Steam recently played data unavailable', {
        userId,
        steamId: steamId64,
        code: result.syncWarningCode,
        reason: 'private_steam_profile_or_unavailable_game_details',
        steamSyncStatus: STEAM_SYNC_STATUS.PRIVATE_PROFILE
      });
    }

    const steamSyncStatus = resolveSteamSyncStatus({
      steamAccount,
      warningCode: result.syncWarningCode,
      wasSuccessful: !result.syncWarningCode
    });
    const lastSteamSyncAt = steamSyncStatus === STEAM_SYNC_STATUS.SUCCESS
      ? await markSteamSyncSuccess(steamAccount)
      : (steamAccount.lastSteamSyncAt ?? null);

    return {
      games: enrichedGames,
      totalCount,
      steamSyncAvailable: steamSyncStatus === STEAM_SYNC_STATUS.SUCCESS,
      steamSyncErrorCode: null,
      steamSyncStatus,
      lastSteamSyncAt
    };
  } catch (error) {
    const steamSyncStatus = resolveSteamSyncStatus({
      steamAccount,
      errorCode: error?.code ?? null
    });

    logger.warn('Steam recently played sync skipped', {
      userId,
      reason: 'steam_api_error',
      steamId: steamId64,
      code: error?.code,
      message: error?.message,
      steamSyncStatus
    });

    return {
      games: [],
      totalCount: 0,
      steamSyncAvailable: false,
      steamSyncErrorCode: error?.code ?? 'STEAM_SYNC_UNAVAILABLE',
      steamSyncStatus,
      lastSteamSyncAt: steamAccount.lastSteamSyncAt ?? null
    };
  }
}

function buildLibraryEntryWriteData({
  existingEntry,
  source,
  externalGameId,
  title,
  coverUrl,
  status,
  startedAt,
  completedAt,
  lastPlayedAt,
  playtimeMinutes
}) {
  const nextStatus = resolveGameStatus(status);
  const now = new Date();

  return {
    gameSource: resolveGameSource(source),
    externalGameId,
    gameName: title,
    coverUrl: coverUrl ?? null,
    status: nextStatus,
    startedAt: startedAt !== undefined
      ? startedAt
      : (nextStatus === GameLibraryStatus.PLAYING ? (existingEntry?.startedAt ?? now) : (existingEntry?.startedAt ?? null)),
    completedAt: completedAt !== undefined
      ? completedAt
      : (
        nextStatus === GameLibraryStatus.COMPLETED
          ? (existingEntry?.completedAt ?? now)
          : (nextStatus === GameLibraryStatus.PLAYING ? null : (existingEntry?.completedAt ?? null))
      ),
    lastPlayedAt: lastPlayedAt !== undefined ? lastPlayedAt : (existingEntry?.lastPlayedAt ?? null),
    playtimeMinutes: playtimeMinutes !== undefined ? playtimeMinutes : (existingEntry?.playtimeMinutes ?? null)
  };
}

function determineOwnedGameStatus({
  existingEntry,
  recentlyPlayedGameIds,
  externalGameId,
  playtimeMinutes
}) {
  if (Number.isInteger(playtimeMinutes) && playtimeMinutes > 0) {
    return {
      status: GameLibraryStatus.PLAYING,
      reason: 'playtime_minutes > 0'
    };
  }

  if (recentlyPlayedGameIds.has(externalGameId)) {
    return {
      status: GameLibraryStatus.PLAYING,
      reason: 'recently_played_snapshot_inclusion'
    };
  }

  if (existingEntry?.status === GameLibraryStatus.PLAYING) {
    return {
      status: GameLibraryStatus.PLAYING,
      reason: 'existing_status_playing'
    };
  }

  if (existingEntry?.status) {
    return {
      status: existingEntry.status,
      reason: 'existing_status_preserved'
    };
  }

  return {
    status: GameLibraryStatus.BACKLOG,
    reason: 'default_backlog'
  };
}

function buildSteamLibraryMatchCandidates(entries) {
  return (entries ?? [])
    .map((entry) => ({
      userId: entry?.userId ?? null,
      externalGameId: entry?.externalGameId,
      gameName: entry?.gameName,
      title: entry?.gameName
    }))
    .filter((entry) => typeof entry.externalGameId === 'string' && entry.externalGameId.trim().length > 0);
}

async function getMyLibrary({ userId, selectedTab = LIBRARY_SUMMARY_TAB.PLAYING }) {
  const normalizedSelectedTab = normalizeLibrarySummarySelectedTab(selectedTab);
  const degradedSections = new Set();
  const [steamAccountResult, favoriteResult, reviewResult, rawPlayingEntries, rawOwnedSteamEntries] = await Promise.all([
    getSteamSocialAccount(userId)
      .then((steamAccount) => ({
        steamAccount,
        lookupFailed: false
      }))
      .catch((error) => {
        degradedSections.add('steamState');
        logger.warn('steam-state-lookup-failed', {
          userId,
          stage: 'social_account_lookup',
          code: error?.code ?? null,
          message: error?.message ?? 'Steam social account lookup failed'
        });

        return {
          steamAccount: null,
          lookupFailed: true
        };
      }),
    getMyFavoritesMemoized({
      userId,
      sort: 'latest',
      limit: LIBRARY_PREVIEW_LIMITS.liked
    }),
    getMyReviewsMemoized({
      userId,
      sort: 'latest',
      limit: LIBRARY_PREVIEW_LIMITS.reviews
    }),
    prisma.userGameLibrary.findMany({
      where: {
        userId,
        playtimeMinutes: {
          gt: 0
        }
      },
      orderBy: {
        updatedAt: 'desc'
      },
      take: LIBRARY_PREVIEW_LIMITS.playing
    }),
    prisma.userGameLibrary.findMany({
      where: {
        userId,
        gameSource: GameSource.STEAM
      },
      orderBy: {
        updatedAt: 'desc'
      },
      take: LIBRARY_PREVIEW_LIMITS.owned
    })
  ]);
  const steamAccount = steamAccountResult.steamAccount;
  const steamConnected = !steamAccountResult.lookupFailed && Boolean(steamAccount);
  const excludedPreviewPlayingCount = steamConnected
    ? 0
    : rawPlayingEntries.filter((entry) => entry.gameSource === GameSource.STEAM).length;
  const excludedPreviewOwnedCount = steamConnected ? 0 : rawOwnedSteamEntries.length;
  const excludedPreviewBacklogCount = steamConnected
    ? 0
    : rawOwnedSteamEntries.filter((entry) => entry.status === GameLibraryStatus.BACKLOG).length;
  const playingEntries = steamConnected
    ? rawPlayingEntries
    : rawPlayingEntries.filter((entry) => entry.gameSource !== GameSource.STEAM);
  const ownedSteamEntries = steamConnected ? rawOwnedSteamEntries : [];

  logLibrarySummaryExcludedSteamData({
    userId,
    section: 'library-preview',
    reason: steamAccountResult.lookupFailed ? 'steam_state_lookup_failed' : 'steam_not_connected',
    excludedPlayingCount: excludedPreviewPlayingCount,
    excludedOwnedCount: excludedPreviewOwnedCount,
    excludedBacklogCount: excludedPreviewBacklogCount
  });

  logger.info('Steam account debug', {
    userId,
    steamAccountExists: Boolean(steamAccount),
    providerSubject: steamAccount?.providerSubject ?? null,
    personaName: steamAccount?.personaName ?? null
  });

  const favoriteGameIds = favoriteResult.favorites.map((favorite) => favorite.gameId);
  const reviewedGameIds = reviewResult.reviews.map((review) => review.gameId);
  const playingIgdbGameIds = playingEntries
    .filter((entry) => entry.gameSource === GameSource.IGDB)
    .map((entry) => entry.externalGameId);
  const steamLibraryExternalGameIds = [
    ...playingEntries
      .filter((entry) => entry.gameSource === GameSource.STEAM)
      .map((entry) => entry.externalGameId),
    ...ownedSteamEntries.map((entry) => entry.externalGameId)
  ];
  const previewSteamMatchCandidates = buildSteamLibraryMatchCandidates([
    ...playingEntries.filter((entry) => entry.gameSource === GameSource.STEAM),
    ...ownedSteamEntries
  ]);
  const [recentlyPlayedResult, igdbGameMap, steamMappingResolutionResult, friendRecommendationPreview, playtimeRecommendationPreview] = await Promise.all([
    steamAccountResult.lookupFailed
      ? Promise.resolve(buildFailedSteamPreviewResult({
        steamSyncErrorCode: 'STEAM_STATE_LOOKUP_FAILED'
      }))
      : buildCachedRecentlyPlayedResult({
        userId,
        steamAccount,
        limit: LIBRARY_PREVIEW_LIMITS.recentlyPlayed,
        endpoint: 'library_preview'
      }).catch((error) => {
        degradedSections.add('recentlyPlayed');
        logger.warn('steam-state-lookup-failed', {
          userId,
          stage: 'recently_played_preview',
          code: error?.code ?? null,
          message: error?.message ?? 'Steam recently played preview failed'
        });

        return buildFailedSteamPreviewResult({
          steamAccount,
          steamSyncErrorCode: error?.code ?? 'STEAM_RECENTLY_PLAYED_LOOKUP_FAILED'
        });
      }),
    buildIgdbGameMap([...favoriteGameIds, ...reviewedGameIds, ...playingIgdbGameIds]),
    resolveSteamMappingContextForGames({
      games: previewSteamMatchCandidates,
      activeResolution: false,
      createMissingMappingsWhenUncached: true,
      logLabel: 'library-preview',
      userId
    })
      .catch((error) => {
        degradedSections.add('ownedEnrichment');
        logger.warn('steam-state-lookup-failed', {
          userId,
          stage: 'steam_mapping_cache_lookup',
          code: error?.code ?? null,
          message: error?.message ?? 'Steam mapping cache lookup failed'
        });

        return {
          mappingContext: createEmptySteamMappingContext(),
          resolutionSummary: {
            steamAppIdCount: steamLibraryExternalGameIds.length,
            cachedConfirmedCount: 0,
            unmatchedCountBeforeResolution: steamLibraryExternalGameIds.length,
            externalGamesResolvedCount: 0,
            titleFallbackResolvedCount: 0,
            unmatchedCountAfterResolution: steamLibraryExternalGameIds.length
          }
        };
      }),
    getMySteamFriendRecommendations({
      userId,
      page: 1,
      limit: LIBRARY_PREVIEW_LIMITS.friendRecommendations,
      previewMode: true,
      allowLiveSteamApi: false
    }).catch((error) => {
      degradedSections.add('friendRecommendations');
      logger.warn('library-preview-recommendations-failed', {
        userId,
        section: 'friendRecommendations',
        code: error?.code ?? null,
        message: error?.message ?? 'Steam friend recommendations preview failed'
      });

      return {
        source: FRIEND_RECOMMENDATION_SOURCE.NONE,
        items: [],
        recommendations: [],
        friendRecommendations: [],
        emptyReason: FRIEND_RECOMMENDATION_EMPTY_REASON.NO_RECOMMENDATION_DATA,
        metadata: {
          appFriendCount: 0,
          appFriendActivityCount: 0,
          steamFriendCount: 0,
          fallbackUsed: false
        },
        meta: buildPaginatedMeta({
          page: 1,
          limit: LIBRARY_PREVIEW_LIMITS.friendRecommendations,
          totalCount: 0,
          sort: 'score_desc'
        })
      };
    }),
    getMyPlaytimeBasedRecommendations({
      userId,
      page: 1,
      limit: LIBRARY_PREVIEW_LIMITS.playtimeRecommendations,
      previewMode: true,
      allowLiveSteamApi: false
    }).catch((error) => {
      degradedSections.add('playtimeRecommendations');
      logger.warn('library-preview-recommendations-failed', {
        userId,
        section: 'playtimeRecommendations',
        code: error?.code ?? null,
        message: error?.message ?? 'Playtime recommendations preview failed'
      });

      return {
        recommendations: [],
        playtimeRecommendations: [],
        meta: buildPaginatedMeta({
          page: 1,
          limit: LIBRARY_PREVIEW_LIMITS.playtimeRecommendations,
          totalCount: 0,
          sort: 'score_desc'
        })
      };
    })
  ]);
  const steamMappingContext = steamMappingResolutionResult.mappingContext;
  const steamLibraryMappingOptions = new Map(
    steamLibraryExternalGameIds.map((externalGameId) => [
      externalGameId,
      buildSteamLibraryEntryMappingOptions(externalGameId, steamMappingContext, userId)
    ])
  );

  const playing = playingEntries.map((entry) => mapLibraryStatusEntry(
    entry,
    entry.gameSource === GameSource.STEAM
      ? (steamLibraryMappingOptions.get(entry.externalGameId) ?? buildSteamLibraryEntryMappingOptions(entry.externalGameId, steamMappingContext, userId))
      : buildIgdbLibraryEntryMappingOptions(entry.externalGameId, igdbGameMap)
  ));
  const owned = ownedSteamEntries.map((entry) => mapLibraryStatusEntry(
    entry,
    steamLibraryMappingOptions.get(entry.externalGameId) ?? buildSteamLibraryEntryMappingOptions(entry.externalGameId, steamMappingContext, userId)
  ));
  const rawBacklog = ownedSteamEntries
    .filter((entry) => entry.status === GameLibraryStatus.BACKLOG)
    .map((entry) => mapLibraryStatusEntry(
      entry,
      steamLibraryMappingOptions.get(entry.externalGameId) ?? buildSteamLibraryEntryMappingOptions(entry.externalGameId, steamMappingContext, userId)
    ));
  const backlog = rawBacklog.length === owned.length && owned.length > 0
    ? []
    : rawBacklog;

  if (rawBacklog.length === owned.length && owned.length > 0) {
    logger.info('Steam backlog section collapsed into owned section', {
      userId,
      ownedCount: owned.length,
      backlogCount: rawBacklog.length
    });
  }
  const wishlist = favoriteResult.favorites.map((favorite) => mapWishlistItem(favorite, igdbGameMap.get(favorite.gameId)));
  const reviewed = reviewResult.reviews.map((review) => mapReviewedItem(review, igdbGameMap.get(review.gameId)));
  const lastSteamSyncAt = steamAccountResult.lookupFailed
    ? null
    : (recentlyPlayedResult.lastSteamSyncAt ?? steamAccount?.lastSteamSyncAt ?? null);
  const steamSyncStatus = steamAccountResult.lookupFailed
    ? STEAM_SYNC_STATUS.FAILED
    : (isSteamSyncInProgress(userId)
    ? STEAM_SYNC_STATUS.SYNCING
    : recentlyPlayedResult.steamSyncStatus);
  const steamSyncErrorCode = steamAccountResult.lookupFailed
    ? 'STEAM_STATE_LOOKUP_FAILED'
    : recentlyPlayedResult.steamSyncErrorCode;
  const steamLinkStatus = steamAccountResult.lookupFailed
    ? mapSteamLinkStatus(null)
    : mapSteamLinkStatus(steamAccount);
  const previewSectionDataset = resolveLibrarySectionItems({
    selectedTab: normalizedSelectedTab,
    playing,
    liked: wishlist,
    reviewed
  });
  const playedSummaryDataset = normalizedSelectedTab === LIBRARY_SUMMARY_TAB.PLAYING
    ? await buildPlayedLibrarySummaryDataset({
      userId,
      steamConnected,
      selectedTab: normalizedSelectedTab
    })
    : null;
  const summary = normalizedSelectedTab === LIBRARY_SUMMARY_TAB.PLAYING
    ? playedSummaryDataset.summary
    : buildLibrarySummaryFromItems({
      selectedTab: normalizedSelectedTab,
      items: previewSectionDataset.items
    });
  const summaryDatasetBasis = normalizedSelectedTab === LIBRARY_SUMMARY_TAB.PLAYING
    ? playedSummaryDataset?.datasetBasis ?? null
    : 'selected_section_items';
  const summaryTotalPlaytimeMinutes = normalizedSelectedTab === LIBRARY_SUMMARY_TAB.PLAYING
    ? (playedSummaryDataset?.totalPlaytimeMinutes ?? 0)
    : Math.round((summary?.totalPlaytimeHours ?? 0) * 60);
  logLibraryPreviewDatasetBasis({
    userId,
    selectedTab: normalizedSelectedTab,
    previewDatasetBasis: 'preview_cards_subset',
    previewDatasetCount: previewSectionDataset.items.length
  });
  logLibrarySummaryDatasetBasis({
    userId,
    selectedTab: normalizedSelectedTab,
    summaryDatasetBasis,
    summaryDatasetCount: normalizedSelectedTab === LIBRARY_SUMMARY_TAB.PLAYING
      ? (playedSummaryDataset?.distinctGameCount ?? 0)
      : previewSectionDataset.items.length,
    summaryTotalPlaytimeMinutes
  });
  logLibrarySummaryListConsistency({
    userId,
    scope: 'preview',
    selectedTab: normalizedSelectedTab,
    listItems: previewSectionDataset.items,
    summaryItems: normalizedSelectedTab === LIBRARY_SUMMARY_TAB.PLAYING
      ? playedSummaryDataset.items
      : previewSectionDataset.items,
    summary,
    sameDatasetPathUsed: normalizedSelectedTab !== LIBRARY_SUMMARY_TAB.PLAYING,
    collapseRules: rawBacklog.length === owned.length && owned.length > 0
      ? ['steam_backlog_collapsed_into_owned']
      : []
  });
  logLibrarySummaryFinal({
    userId,
    selectedTab: normalizedSelectedTab,
    summary,
    totalPlaytimeMinutes: summaryTotalPlaytimeMinutes,
    summaryDatasetBasis
  });
  logger.info('library-service-return-preview', {
    userId,
    selectedTab: normalizedSelectedTab,
    gameCount: summary?.gameCount ?? 0,
    totalPlaytimeHours: summary?.totalPlaytimeHours ?? 0,
    summaryDatasetBasis,
    responseSummaryPreview: JSON.stringify({
      selectedTab: summary?.selectedTab ?? null,
      source: summary?.source ?? null,
      gameCount: summary?.gameCount ?? 0,
      totalPlaytimeHours: summary?.totalPlaytimeHours ?? 0,
      totalPlaytimeMinutes: summary?.totalPlaytimeMinutes ?? 0
    })
  });

  logger.info('steam-state', {
    userId,
    steamConnected,
    steamSyncStatus,
    lastSteamSyncAt: lastSteamSyncAt ? new Date(lastSteamSyncAt).toISOString() : null
  });

  if (degradedSections.size > 0) {
    logger.warn('library-partial-response', {
      userId,
      steamConnected,
      steamSyncStatus,
      degradedSections: [...degradedSections]
    });
  }

  return {
    steamConnected,
    steam: buildSteamSyncState({
      steamAccount,
      steamSyncStatus,
      recentlyPlayedSource: recentlyPlayedResult.source === 'cached_snapshot'
        ? 'snapshot'
        : (recentlyPlayedResult.source === 'live_fetch' ? 'live' : 'none'),
      friendRecommendationPreviewDeferred: friendRecommendationPreview.friendRecommendationState?.status === 'deferred'
    }),
    steamSync: buildStandardSteamSyncPayload({
      steamAccount,
      steamSyncStatus
    }),
    steamSyncStatus,
    lastSteamSyncAt,
    steamSyncAvailable: recentlyPlayedResult.steamSyncAvailable,
    steamSyncErrorCode,
    steamLinkStatus,
    recentlyPlayed: recentlyPlayedResult.games,
    playing,
    owned,
    backlog,
    wishlist,
    liked: wishlist,
    reviewed,
    reviews: reviewed,
    friendRecommendations: friendRecommendationPreview.friendRecommendations ?? friendRecommendationPreview.recommendations ?? [],
    friendRecommendationState: friendRecommendationPreview.friendRecommendationState ?? buildFriendRecommendationState({
      previewMode: true,
      source: friendRecommendationPreview.source ?? FRIEND_RECOMMENDATION_SOURCE.NONE,
      metadata: friendRecommendationPreview.metadata ?? {}
    }),
    friendRecommendationsState: friendRecommendationPreview.friendRecommendationState ?? buildFriendRecommendationState({
      previewMode: true,
      source: friendRecommendationPreview.source ?? FRIEND_RECOMMENDATION_SOURCE.NONE,
      metadata: friendRecommendationPreview.metadata ?? {}
    }),
    friendRecommendationSource: friendRecommendationPreview.source ?? FRIEND_RECOMMENDATION_SOURCE.NONE,
    friendRecommendationEmptyReason: friendRecommendationPreview.emptyReason ?? null,
    friendRecommendationMetadata: friendRecommendationPreview.metadata ?? null,
    playtimeRecommendations: playtimeRecommendationPreview.playtimeRecommendations ?? playtimeRecommendationPreview.recommendations ?? [],
    summary,
    ...buildLibrarySummaryAliases(summary),
    responseMeta: buildLibraryResponseMeta({
      isPartialFailure: degradedSections.size > 0 ||
        Boolean(friendRecommendationPreview.responseMeta?.isPartialFailure) ||
        Boolean(playtimeRecommendationPreview.responseMeta?.isPartialFailure),
      summaryDatasetBasis
    })
  };
}

async function getMyOwnedLibrary({ userId, page = 1, limit = LIBRARY_FULL_DEFAULT_LIMIT, sort = 'latest' }) {
  const pagination = resolvePaginationParams({ page, limit });
  const orderBy = sort === 'playtime_desc'
    ? [{ playtimeMinutes: 'desc' }, { updatedAt: 'desc' }]
    : [{ updatedAt: 'desc' }];
  const steamAccount = await getSteamSocialAccount(userId);

  if (!steamAccount) {
    const [staleSteamOwnedRowCount, staleSteamBacklogRowCount] = await Promise.all([
      prisma.userGameLibrary.count({
        where: {
          userId,
          gameSource: GameSource.STEAM
        }
      }),
      prisma.userGameLibrary.count({
        where: {
          userId,
          gameSource: GameSource.STEAM,
          status: GameLibraryStatus.BACKLOG
        }
      })
    ]);

    logLibrarySummaryExcludedSteamData({
      userId,
      section: 'owned-list',
      excludedOwnedCount: staleSteamOwnedRowCount,
      excludedBacklogCount: staleSteamBacklogRowCount
    });

    return {
      steamConnected: false,
      steamLinkStatus: mapSteamLinkStatus(null),
      owned: [],
      backlog: [],
      responseMeta: buildLibraryResponseMeta(),
      meta: buildPaginatedMeta({
        page: pagination.page,
        limit: pagination.limit,
        totalCount: 0,
        sort
      })
    };
  }

  const [totalCount, ownedSteamEntries] = await Promise.all([
    prisma.userGameLibrary.count({
      where: {
        userId,
        gameSource: GameSource.STEAM
      }
    }),
    prisma.userGameLibrary.findMany({
      where: {
        userId,
        gameSource: GameSource.STEAM
      },
      orderBy,
      skip: pagination.skip,
      take: pagination.limit
    })
  ]);
  const {
    mappingContext,
    resolutionSummary
  } = await resolveSteamMappingContextForGames({
    games: buildSteamLibraryMatchCandidates(ownedSteamEntries),
    activeResolution: false,
    createMissingMappingsWhenUncached: true,
    logLabel: 'owned-list',
    userId
  });

  logger.info('steam-owned-match-summary', {
    userId,
    ownedSteamAppIdCount: resolutionSummary.steamAppIdCount,
    cachedConfirmedCount: resolutionSummary.cachedConfirmedCount,
    unmatchedCountBeforeResolution: resolutionSummary.unmatchedCountBeforeResolution,
    externalGamesResolvedCount: resolutionSummary.externalGamesResolvedCount,
    titleFallbackResolvedCount: resolutionSummary.titleFallbackResolvedCount,
    unmatchedCountAfterResolution: resolutionSummary.unmatchedCountAfterResolution
  });

  const steamLibraryMappingOptions = new Map(
    ownedSteamEntries.map((entry) => [
      entry.externalGameId,
      buildSteamLibraryEntryMappingOptions(entry.externalGameId, mappingContext, userId)
    ])
  );

  for (const entry of ownedSteamEntries) {
    const mappingOptions = steamLibraryMappingOptions.get(entry.externalGameId) ?? {
      igdbGameId: null,
      matchStatus: null,
      metadataEnriched: false
    };

    logger.info('Steam library owned item enrichment', {
      userId,
      steamAppId: entry.externalGameId,
      igdbGameId: mappingOptions.igdbGameId,
      matchStatus: mappingOptions.matchStatus,
      metadataEnriched: mappingOptions.metadataEnriched
    });
  }

  const owned = ownedSteamEntries.map((entry) => mapLibraryStatusEntry(
    entry,
    steamLibraryMappingOptions.get(entry.externalGameId) ?? buildSteamLibraryEntryMappingOptions(entry.externalGameId, mappingContext, userId)
  ));
  const rawBacklog = ownedSteamEntries
    .filter((entry) => entry.status === GameLibraryStatus.BACKLOG)
    .map((entry) => mapLibraryStatusEntry(
      entry,
      steamLibraryMappingOptions.get(entry.externalGameId) ?? buildSteamLibraryEntryMappingOptions(entry.externalGameId, mappingContext, userId)
    ));
  const backlog = rawBacklog.length === owned.length && owned.length > 0
    ? []
    : rawBacklog;

  if (rawBacklog.length === owned.length && owned.length > 0) {
    logger.info('Steam backlog section collapsed into owned section', {
      userId,
      ownedCount: owned.length,
      backlogCount: rawBacklog.length
    });
  }

  const fullOwnedPlaytimeMinutes = ownedSteamEntries.reduce((sum, entry) => {
    const playtimeMinutes = Number(entry?.playtimeMinutes);
    return Number.isFinite(playtimeMinutes) && playtimeMinutes > 0
      ? sum + playtimeMinutes
      : sum;
  }, 0);

  logLibraryOwnedDatasetBasis({
    userId,
    datasetBasis: 'full_owned_steam_dataset',
    fullOwnedCount: totalCount,
    fullOwnedPlaytimeMinutes,
    filteredOwnedCount: ownedSteamEntries.length,
    filterReason: 'pagination_only'
  });
  logLibraryOwnedResponseFinal({
    userId,
    count: totalCount,
    resultCount: owned.length,
    datasetBasis: 'full_owned_steam_dataset',
    externalIdFilterApplied: false,
    externalIdFilterCount: 0
  });

  return {
    steamConnected: Boolean(steamAccount),
    steamLinkStatus: mapSteamLinkStatus(steamAccount),
    owned,
    backlog,
    count: totalCount,
    responseMeta: buildLibraryResponseMeta(),
    meta: buildPaginatedMeta({
      page: pagination.page,
      limit: pagination.limit,
      totalCount,
      sort
    })
  };
}

async function getMyPlayingLibrary({ userId, page = 1, limit = LIBRARY_FULL_DEFAULT_LIMIT, sort = 'latest' }) {
  const pagination = resolvePaginationParams({ page, limit });
  const orderBy = sort === 'oldest'
    ? [{ updatedAt: 'asc' }]
    : [{ updatedAt: 'desc' }];
  const steamAccount = await getSteamSocialAccount(userId);
  const playingWhere = {
    userId,
    playtimeMinutes: {
      gt: 0
    },
    ...(!steamAccount
      ? {
        gameSource: {
          not: GameSource.STEAM
        }
      }
      : {})
  };

  if (!steamAccount) {
    const staleSteamPlayingCount = await prisma.userGameLibrary.count({
      where: {
        userId,
        gameSource: GameSource.STEAM,
        playtimeMinutes: {
          gt: 0
        }
      }
    });

    logLibrarySummaryExcludedSteamData({
      userId,
      section: 'playing-list',
      excludedPlayingCount: staleSteamPlayingCount
    });
  }

  const [totalCount, playingEntries] = await Promise.all([
    prisma.userGameLibrary.count({
      where: playingWhere
    }),
    prisma.userGameLibrary.findMany({
      where: playingWhere,
      orderBy,
      skip: pagination.skip,
      take: pagination.limit
    })
  ]);
  const playingIgdbGameIds = playingEntries
    .filter((entry) => entry.gameSource === GameSource.IGDB)
    .map((entry) => entry.externalGameId);
  const steamPlayingEntries = playingEntries.filter((entry) => entry.gameSource === GameSource.STEAM);
  const [igdbGameMap, steamMappingResolution] = await Promise.all([
    buildIgdbGameMap(playingIgdbGameIds),
    resolveSteamMappingContextForGames({
      games: buildSteamLibraryMatchCandidates(steamPlayingEntries),
      activeResolution: false,
      createMissingMappingsWhenUncached: true,
      logLabel: 'playing-list',
      userId
    })
  ]);
  const steamMappingContext = steamMappingResolution.mappingContext;
  const steamLibraryMappingOptions = new Map(
    steamPlayingEntries.map((entry) => [
      entry.externalGameId,
      buildSteamLibraryEntryMappingOptions(entry.externalGameId, steamMappingContext, userId)
    ])
  );
  const playing = playingEntries.map((entry) => mapLibraryStatusEntry(
    entry,
    entry.gameSource === GameSource.STEAM
      ? (steamLibraryMappingOptions.get(entry.externalGameId) ?? buildSteamLibraryEntryMappingOptions(entry.externalGameId, steamMappingContext, userId))
      : buildIgdbLibraryEntryMappingOptions(entry.externalGameId, igdbGameMap)
  ));
  const playedSummaryDataset = await buildPlayedLibrarySummaryDataset({
    userId,
    steamConnected: Boolean(steamAccount),
    selectedTab: LIBRARY_SUMMARY_TAB.PLAYING
  });
  const summary = playedSummaryDataset.summary;
  logLibrarySummaryDatasetBasis({
    userId,
    selectedTab: LIBRARY_SUMMARY_TAB.PLAYING,
    summaryDatasetBasis: playedSummaryDataset.datasetBasis,
    summaryDatasetCount: playedSummaryDataset.distinctGameCount,
    summaryTotalPlaytimeMinutes: playedSummaryDataset.totalPlaytimeMinutes
  });
  logLibrarySummaryListConsistency({
    userId,
    scope: 'full-playing',
    selectedTab: LIBRARY_SUMMARY_TAB.PLAYING,
    listItems: playing,
    summaryItems: playedSummaryDataset.items,
    summary,
    sameDatasetPathUsed: false
  });
  logLibrarySummaryFinal({
    userId,
    selectedTab: LIBRARY_SUMMARY_TAB.PLAYING,
    summary,
    totalPlaytimeMinutes: playedSummaryDataset.totalPlaytimeMinutes,
    summaryDatasetBasis: playedSummaryDataset.datasetBasis
  });
  logger.info('library-service-return-playing', {
    userId,
    selectedTab: LIBRARY_SUMMARY_TAB.PLAYING,
    gameCount: summary?.gameCount ?? 0,
    totalPlaytimeHours: summary?.totalPlaytimeHours ?? 0,
    summaryDatasetBasis: playedSummaryDataset.datasetBasis,
    responseSummaryPreview: JSON.stringify({
      selectedTab: summary?.selectedTab ?? null,
      source: summary?.source ?? null,
      gameCount: summary?.gameCount ?? 0,
      totalPlaytimeHours: summary?.totalPlaytimeHours ?? 0,
      totalPlaytimeMinutes: summary?.totalPlaytimeMinutes ?? 0
    })
  });

  return {
    playing,
    summary,
    ...buildLibrarySummaryAliases(summary),
    responseMeta: buildLibraryResponseMeta({
      summaryDatasetBasis: playedSummaryDataset.datasetBasis
    }),
    meta: buildPaginatedMeta({
      page: pagination.page,
      limit: pagination.limit,
      totalCount,
      sort
    })
  };
}

async function getMyRecentlyPlayedLibrary({ userId, page = 1, limit = LIBRARY_FULL_DEFAULT_LIMIT, sort = 'latest', endpoint = 'library_recently_played' }) {
  const pagination = resolvePaginationParams({ page, limit });
  const steamAccount = await getSteamSocialAccount(userId);
  const recentlyPlayedResult = await buildCachedRecentlyPlayedResult({
    userId,
    steamAccount,
    page: pagination.page,
    limit: pagination.limit,
    endpoint
  });
  const steamSyncStatus = isSteamSyncInProgress(userId)
    ? STEAM_SYNC_STATUS.SYNCING
    : recentlyPlayedResult.steamSyncStatus;

  return {
    steamConnected: Boolean(steamAccount),
    steam: buildSteamSyncState({
      steamAccount,
      steamSyncStatus,
      recentlyPlayedSource: recentlyPlayedResult.source === 'cached_snapshot'
        ? 'snapshot'
        : (recentlyPlayedResult.source === 'live_fetch' ? 'live' : 'none'),
      friendRecommendationPreviewDeferred: false
    }),
    steamSync: buildStandardSteamSyncPayload({
      steamAccount,
      steamSyncStatus
    }),
    steamSyncStatus,
    lastSteamSyncAt: recentlyPlayedResult.lastSteamSyncAt ?? steamAccount?.lastSteamSyncAt ?? null,
    steamSyncAvailable: recentlyPlayedResult.steamSyncAvailable,
    steamSyncErrorCode: recentlyPlayedResult.steamSyncErrorCode,
    steamLinkStatus: mapSteamLinkStatus(steamAccount),
    recentlyPlayed: recentlyPlayedResult.games,
    responseMeta: buildLibraryResponseMeta(),
    meta: buildPaginatedMeta({
      page: pagination.page,
      limit: pagination.limit,
      totalCount: recentlyPlayedResult.totalCount ?? 0,
      sort
    })
  };
}

async function getMyLikedLibrary({ userId, page = 1, limit = LIBRARY_FULL_DEFAULT_LIMIT, sort = 'latest' }) {
  const pagination = resolvePaginationParams({ page, limit });
  const orderBy = sort === 'oldest'
    ? [{ createdAt: 'asc' }]
    : [{ createdAt: 'desc' }];
  const [favorites, totalCount] = await Promise.all([
    prisma.favoriteGame.findMany({
      where: {
        userId
      },
      orderBy,
      skip: pagination.skip,
      take: pagination.limit
    }),
    prisma.favoriteGame.count({
      where: {
        userId
      }
    })
  ]);
  const favoriteGameIds = favorites.map((favorite) => favorite.gameId);
  const igdbGameMap = await buildIgdbGameMap(favoriteGameIds);
  const liked = favorites.map((favorite) => mapWishlistItem(favorite, igdbGameMap.get(favorite.gameId)));
  const summary = buildLibrarySummaryFromItems({
    selectedTab: LIBRARY_SUMMARY_TAB.LIKED,
    items: liked
  });
  logLibrarySummaryListConsistency({
    userId,
    scope: 'full-liked',
    selectedTab: LIBRARY_SUMMARY_TAB.LIKED,
    items: liked,
    summary
  });

  return {
    liked,
    wishlist: liked,
    summary,
    ...buildLibrarySummaryAliases(summary),
    responseMeta: buildLibraryResponseMeta(),
    meta: buildPaginatedMeta({
      page: pagination.page,
      limit: pagination.limit,
      totalCount,
      sort
    })
  };
}

async function getMyReviewedLibrary({ userId, page = 1, limit = LIBRARY_FULL_DEFAULT_LIMIT, sort = 'latest' }) {
  const pagination = resolvePaginationParams({ page, limit });
  const orderBy = sort === 'oldest'
    ? [{ createdAt: 'asc' }]
    : [{ createdAt: 'desc' }];
  const [reviews, totalCount] = await Promise.all([
    prisma.review.findMany({
      where: {
        userId
      },
      orderBy,
      skip: pagination.skip,
      take: pagination.limit,
      include: {
        user: {
          select: {
            id: true,
            nickname: true,
            profileImageUrl: true
          }
        }
      }
    }),
    prisma.review.count({
      where: {
        userId
      }
    })
  ]);
  const reviewedGameIds = reviews.map((review) => review.gameId);
  const igdbGameMap = await buildIgdbGameMap(reviewedGameIds);
  const reviewed = reviews.map((review) => mapReviewedItem(review, igdbGameMap.get(review.gameId)));
  const summary = buildLibrarySummaryFromItems({
    selectedTab: LIBRARY_SUMMARY_TAB.REVIEWED,
    items: reviewed
  });
  logLibrarySummaryListConsistency({
    userId,
    scope: 'full-reviewed',
    selectedTab: LIBRARY_SUMMARY_TAB.REVIEWED,
    items: reviewed,
    summary
  });

  return {
    reviewed,
    reviews: reviewed,
    summary,
    ...buildLibrarySummaryAliases(summary),
    responseMeta: buildLibraryResponseMeta(),
    meta: buildPaginatedMeta({
      page: pagination.page,
      limit: pagination.limit,
      totalCount,
      sort
    })
  };
}

async function loadInAppFriendRecommendations({
  userId,
  pagination
}) {
  const friendRows = await getFriendRowsMemoized(userId);
  const friendIds = [...new Set(friendRows.map((row) => row.friendUserId).filter(Boolean))];

  if (friendIds.length === 0) {
    return {
      items: [],
      totalCount: 0,
      metadata: {
        appFriendCount: 0,
        appFriendActivityCount: 0
      }
    };
  }

  const [
    privacySettings,
    currentFavorites,
    currentReviews,
    currentLibraryEntries,
    friendFavorites,
    friendReviews,
    friendLibraryEntries
  ] = await Promise.all([
    prisma.userPrivacySettings.findMany({
      where: {
        userId: { in: friendIds }
      },
      select: {
        userId: true,
        showRecentlyPlayed: true,
        showLikedGames: true,
        showReviews: true
      }
    }),
    getFavoriteGameIdsMemoized(userId),
    getReviewGameIdsMemoized(userId),
    prisma.userGameLibrary.findMany({
      where: { userId },
      select: {
        gameSource: true,
        externalGameId: true
      }
    }),
    prisma.favoriteGame.findMany({
      where: { userId: { in: friendIds } },
      select: {
        userId: true,
        gameId: true
      }
    }),
    prisma.review.findMany({
      where: { userId: { in: friendIds } },
      select: {
        userId: true,
        gameId: true,
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
    })
  ]);
  const privacyMap = new Map(privacySettings.map((item) => [item.userId, item]));
  const visibleFriendFavorites = friendFavorites.filter((favorite) => mapFriendPrivacySettings(privacyMap.get(favorite.userId)).showLikedGames);
  const visibleFriendReviews = friendReviews.filter((review) => mapFriendPrivacySettings(privacyMap.get(review.userId)).showReviews);
  const visibleOwnedFriendLibraryEntries = friendLibraryEntries;
  const visibleRecentFriendLibraryEntries = friendLibraryEntries.filter((entry) => mapFriendPrivacySettings(privacyMap.get(entry.userId)).showRecentlyPlayed);
  const appFriendActivityCount = visibleFriendFavorites.length +
    visibleFriendReviews.length +
    visibleOwnedFriendLibraryEntries.length +
    visibleRecentFriendLibraryEntries.filter((entry) => entry.status === GameLibraryStatus.PLAYING || Boolean(entry.lastPlayedAt)).length;
  const currentSteamMappingResolution = await resolveSteamMappingContextForGames({
    games: currentLibraryEntries
      .filter((entry) => entry.gameSource === GameSource.STEAM)
      .map((entry) => ({
        userId,
        externalGameId: entry.externalGameId
      })),
    activeResolution: false,
    createMissingMappingsWhenUncached: true,
    logLabel: 'in-app-friend-recommendations-current',
    userId
  });
  const friendSteamMappingResolution = await resolveSteamMappingContextForGames({
    games: visibleOwnedFriendLibraryEntries
      .filter((entry) => entry.gameSource === GameSource.STEAM)
      .map((entry) => ({
        userId: entry.userId,
        externalGameId: entry.externalGameId,
        gameName: entry.gameName
      })),
    activeResolution: false,
    createMissingMappingsWhenUncached: true,
    logLabel: 'in-app-friend-recommendations-friend',
    userId
  });
  const currentSteamMappings = currentSteamMappingResolution.mappingContext;
  const friendSteamMappings = friendSteamMappingResolution.mappingContext;
  const currentExcludedKeys = new Set([
    ...currentFavorites.map((favorite) => buildRecommendationCandidateKey({
      gameSource: GameSource.IGDB,
      externalGameId: favorite.gameId
    })),
    ...currentReviews.map((review) => buildRecommendationCandidateKey({
      gameSource: GameSource.IGDB,
      externalGameId: review.gameId
    })),
    ...currentLibraryEntries.map((entry) => buildRecommendationCandidateKeyFromLibraryEntry(entry, currentSteamMappings, userId))
  ].filter(Boolean));
  const candidateMap = new Map();
  const upsertCandidate = ({
    key,
    signalType,
    userId: friendUserId,
    rating = null,
    previewSeed = null
  }) => {
    if (!key || currentExcludedKeys.has(key)) {
      return;
    }

    const existingCandidate = candidateMap.get(key) ?? {
      key,
      previewSeed,
      friendIds: new Set(),
      ownedFriendIds: new Set(),
      recentFriendIds: new Set(),
      likedFriendIds: new Set(),
      highRatedFriendIds: new Set(),
      matchedSignals: new Set(),
      ratingSum: 0,
      ratingCount: 0
    };

    existingCandidate.friendIds.add(friendUserId);

    switch (signalType) {
    case 'owned':
      existingCandidate.ownedFriendIds.add(friendUserId);
      existingCandidate.matchedSignals.add('friend_ownership');
      break;
    case 'recent':
      existingCandidate.recentFriendIds.add(friendUserId);
      existingCandidate.matchedSignals.add('recent_friend_activity');
      break;
    case 'liked':
      existingCandidate.likedFriendIds.add(friendUserId);
      existingCandidate.matchedSignals.add('friend_like');
      break;
    case 'highRated':
      existingCandidate.highRatedFriendIds.add(friendUserId);
      existingCandidate.matchedSignals.add('high_friend_rating');
      break;
    default:
      break;
    }

    if (Number.isFinite(rating)) {
      existingCandidate.ratingSum += Number(rating);
      existingCandidate.ratingCount += 1;
    }

    if (!existingCandidate.previewSeed && previewSeed) {
      existingCandidate.previewSeed = previewSeed;
    }

    candidateMap.set(key, existingCandidate);
  };

  for (const favorite of visibleFriendFavorites) {
    upsertCandidate({
      key: buildRecommendationCandidateKey({
        gameSource: GameSource.IGDB,
        externalGameId: favorite.gameId
      }),
      signalType: 'liked',
      userId: favorite.userId
    });
  }

  for (const review of visibleFriendReviews) {
    upsertCandidate({
      key: buildRecommendationCandidateKey({
        gameSource: GameSource.IGDB,
        externalGameId: review.gameId
      }),
      signalType: Number(review.rating) >= 4 ? 'highRated' : 'liked',
      userId: review.userId,
      rating: Number(review.rating)
    });
  }

  for (const entry of visibleOwnedFriendLibraryEntries) {
    upsertCandidate({
      key: buildRecommendationCandidateKeyFromLibraryEntry(entry, friendSteamMappings, entry.userId),
      signalType: 'owned',
      userId: entry.userId,
      previewSeed: {
        source: normalizeLibraryGameSource(entry.gameSource),
        title: entry.gameName,
        externalGameId: entry.externalGameId
      }
    });
  }

  for (const entry of visibleRecentFriendLibraryEntries) {
    if (entry.status !== GameLibraryStatus.PLAYING && !entry.lastPlayedAt) {
      continue;
    }

    upsertCandidate({
      key: buildRecommendationCandidateKeyFromLibraryEntry(entry, friendSteamMappings, entry.userId),
      signalType: 'recent',
      userId: entry.userId,
      previewSeed: {
        source: normalizeLibraryGameSource(entry.gameSource),
        title: entry.gameName,
        externalGameId: entry.externalGameId
      }
    });
  }

  const igdbGameIds = [...new Set(
    [...candidateMap.keys()]
      .filter((key) => key.startsWith('igdb:'))
      .map((key) => key.replace(/^igdb:/, ''))
  )];
  const igdbGameMap = await buildIgdbGameMap(igdbGameIds);
  const scoredCandidates = [...candidateMap.values()]
    .map((candidate) => {
      let game;

      if (candidate.key.startsWith('igdb:')) {
        const igdbGameId = candidate.key.replace(/^igdb:/, '');
        game = buildIgdbRecommendationItem(igdbGameId, igdbGameMap.get(igdbGameId) ?? null);
      } else {
        const externalGameId = candidate.key.replace(/^steam:/, '');
        const mappingOptions = buildSteamLibraryEntryMappingOptions(externalGameId, friendSteamMappings, userId);
        const detailPayload = buildNormalizedDetailPayload({
          endpoint: 'library_friend_recommendations',
          title: candidate.previewSeed?.title ?? null,
          externalGameId,
          igdbGameId: mappingOptions.igdbGameId,
          reason: mappingOptions.igdbGameId ? null : 'steam_friend_mapping_missing',
          mappingStatus: mappingOptions.matchStatus ?? null,
          mappingSource: mappingOptions.metadataEnriched ? 'confirmed_mapping' : 'steam_friend_activity'
        });

        game = {
          source: 'steam',
          gameSource: 'steam',
          externalGameId,
          metadataEnriched: mappingOptions.metadataEnriched,
          enrichmentStatus: resolveSteamEnrichmentStatus({
            gameSource: 'steam',
            metadataEnriched: mappingOptions.metadataEnriched,
            matchStatus: mappingOptions.matchStatus
          }),
          rating: typeof mappingOptions.rating === 'number' ? mappingOptions.rating : null,
          aggregatedRating: typeof mappingOptions.aggregatedRating === 'number' ? mappingOptions.aggregatedRating : null,
          totalRating: typeof mappingOptions.totalRating === 'number' ? mappingOptions.totalRating : null,
          title: candidate.previewSeed?.title ?? `Steam App ${externalGameId}`,
          gameName: candidate.previewSeed?.title ?? `Steam App ${externalGameId}`,
          coverUrl: buildGameImageResolverUrl({
            gameSource: 'steam',
            externalGameId,
            igdbCoverUrl: mappingOptions.igdbCoverUrl
          }),
          ...detailPayload
        };
      }

      logRecommendationRatingPayload({
        endpoint: 'library_friend_recommendations',
        title: game?.title ?? game?.gameName ?? null,
        externalGameId: game?.externalGameId ?? null,
        igdbGameId: game?.igdbGameId ?? null,
        aggregatedRating: game?.aggregatedRating ?? null,
        totalRating: game?.totalRating ?? null,
        rating: game?.rating ?? null,
        detailAvailable: game?.detailAvailable === true
      });

      const friendCount = candidate.friendIds.size;
      const recentFriendCount = candidate.recentFriendIds.size;
      const likedFriendCount = candidate.likedFriendIds.size;
      const highRatedFriendCount = candidate.highRatedFriendIds.size;
      const ownedFriendCount = candidate.ownedFriendIds.size;
      const recommendationScore = scoreInAppFriendRecommendation({
        friendCount,
        recentFriendCount,
        likedFriendCount,
        highRatedFriendCount,
        ownedFriendCount
      });
      const matchedSignals = [...candidate.matchedSignals];

      if (game.metadataEnriched) {
        matchedSignals.push('shared_genre');
      }

      return {
        ...game,
        recommendationScore,
        reason: buildInAppFriendRecommendationReason({
          friendCount,
          recentFriendCount,
          likedFriendCount,
          highRatedFriendCount
        }),
        friendCount,
        matchedSignals: [...new Set(matchedSignals)]
      };
    })
    .filter((candidate) => candidate.recommendationScore > 0)
    .sort((left, right) => right.recommendationScore - left.recommendationScore);
  const { items, totalCount } = paginateItems(scoredCandidates, pagination);

  return {
    items,
    totalCount,
    metadata: {
      appFriendCount: friendIds.length,
      appFriendActivityCount
    }
  };
}

async function loadSteamFriendRecommendations({
  userId,
  pagination,
  previewMode = false,
  allowLiveSteamApi = true
}) {
  let steamAccount;

  try {
    steamAccount = await getSteamSocialAccount(userId);
  } catch (error) {
    logger.warn('friend-recommendation-steam-branch', {
      userId,
      reason: 'steam_account_lookup_failed',
      code: error?.code ?? null,
      message: error?.message ?? 'Steam account lookup failed'
    });

    return {
      items: [],
      totalCount: 0,
      metadata: {
        steamConnected: false,
        steamFriendCount: 0,
        steamAvailable: false,
        steamReason: 'steam_account_lookup_failed'
      }
    };
  }

  if (!steamAccount || !steamService.isSteamSyncConfigured()) {
    const steamReason = !steamAccount ? 'steam_not_connected' : 'steam_api_not_configured';

    logger.info('friend-recommendation-steam-branch', {
      userId,
      reason: steamReason
    });

    return {
      items: [],
      totalCount: 0,
      metadata: {
        steamConnected: Boolean(steamAccount),
        steamFriendCount: 0,
        steamAvailable: false,
        steamReason
      }
    };
  }

  if (!allowLiveSteamApi) {
    logger.info('friend-recommendation-steam-branch', {
      userId,
      reason: 'preview_live_steam_disabled'
    });

    return {
      items: [],
      totalCount: 0,
      metadata: {
        steamConnected: true,
        steamFriendCount: 0,
        steamAvailable: false,
        steamReason: 'preview_live_steam_disabled'
      }
    };
  }

  const steamId64 = steamService.normalizeSteamId64(steamAccount.providerSubject);

  if (!steamId64) {
    logger.warn('friend-recommendation-steam-branch', {
      userId,
      reason: 'invalid_steam_provider_subject',
      providerSubject: steamAccount.providerSubject ?? null
    });

    return {
      items: [],
      totalCount: 0,
      metadata: {
        steamConnected: true,
        steamFriendCount: 0,
        steamAvailable: false,
        steamReason: 'invalid_steam_provider_subject'
      }
    };
  }

  let friendListResult;

  try {
    friendListResult = await steamService.fetchFriendList({ steamId64 });
  } catch (error) {
    logger.warn('friend-recommendation-steam-branch', {
      userId,
      steamId64,
      reason: 'friend_list_fetch_failed',
      code: error?.code ?? null,
      message: error?.message ?? 'Steam friend list fetch failed'
    });

    return {
      items: [],
      totalCount: 0,
      metadata: {
        steamConnected: true,
        steamFriendCount: 0,
        steamAvailable: false,
        steamReason: 'friend_list_fetch_failed'
      }
    };
  }

  if (friendListResult.syncWarningCode || friendListResult.steamIds.length === 0) {
    const steamReason = friendListResult.syncWarningCode ?? 'no_friends';

    logger.info('friend-recommendation-steam-branch', {
      userId,
      steamId64,
      reason: steamReason
    });

    return {
      items: [],
      totalCount: 0,
      metadata: {
        steamConnected: true,
        steamFriendCount: friendListResult.steamIds.length,
        steamAvailable: !friendListResult.syncWarningCode,
        steamReason
      }
    };
  }

  const linkedSteamAccounts = await prisma.socialAccount.findMany({
    where: {
      provider: steamService.STEAM_AUTH_PROVIDER,
      providerSubject: {
        in: friendListResult.steamIds
      }
    },
    select: {
      providerSubject: true,
      linkedAt: true,
      updatedAt: true
    }
  });
  const linkedSteamPriorityMap = new Map(
    linkedSteamAccounts
      .map((account) => {
        const normalizedSteamId64 = steamService.normalizeSteamId64(account.providerSubject);
        return normalizedSteamId64
          ? [normalizedSteamId64, account]
          : null;
      })
      .filter(Boolean)
  );
  const prioritizedFriendSteamIds = [...friendListResult.steamIds].sort((left, right) => {
    const leftLinked = linkedSteamPriorityMap.has(left) ? 1 : 0;
    const rightLinked = linkedSteamPriorityMap.has(right) ? 1 : 0;

    if (rightLinked !== leftLinked) {
      return rightLinked - leftLinked;
    }

    const leftUpdatedAt = linkedSteamPriorityMap.get(left)?.updatedAt?.getTime()
      ?? linkedSteamPriorityMap.get(left)?.linkedAt?.getTime()
      ?? 0;
    const rightUpdatedAt = linkedSteamPriorityMap.get(right)?.updatedAt?.getTime()
      ?? linkedSteamPriorityMap.get(right)?.linkedAt?.getTime()
      ?? 0;

    return rightUpdatedAt - leftUpdatedAt;
  });
  const friendSteamIds = prioritizedFriendSteamIds.slice(
    0,
    previewMode ? Math.min(6, STEAM_FRIEND_RECOMMENDATION_FRIEND_LIMIT) : STEAM_FRIEND_RECOMMENDATION_FRIEND_LIMIT
  );
  const friendActivityResults = await mapWithConcurrencyLimit(
    friendSteamIds,
    STEAM_FRIEND_ACTIVITY_FETCH_CONCURRENCY,
    async (friendSteamId) => {
      const [ownedGamesResult, recentGamesResult] = await Promise.all([
        fetchOwnedGamesDedup({ userId, steamId64: friendSteamId })
          .catch(() => ({ games: [] })),
        fetchRecentlyPlayedGamesDedup({ userId, steamId64: friendSteamId })
          .catch(() => ({ games: [] }))
      ]);

      return {
        friendSteamId,
        ownedGames: ownedGamesResult.games ?? [],
        recentGames: recentGamesResult.games ?? []
      };
    }
  );
  const aggregateMap = new Map();

  for (const result of friendActivityResults) {
    if (result.status !== 'fulfilled') {
      continue;
    }

    for (const game of result.value.ownedGames) {
      addSteamFriendRecommendationSignal(aggregateMap, game, result.value.friendSteamId, 'owned');
    }

    for (const game of result.value.recentGames) {
      addSteamFriendRecommendationSignal(aggregateMap, game, result.value.friendSteamId, 'recent');
    }
  }

  const candidateSummaries = [...aggregateMap.values()]
    .map((candidate) => {
      const friendIds = new Set([
        ...candidate.ownedFriendIds,
        ...candidate.recentFriendIds
      ]);

      return {
        externalGameId: candidate.externalGameId,
        title: candidate.title,
        friendCount: friendIds.size,
        recentFriendCount: candidate.recentFriendIds.size,
        ownedFriendCount: candidate.ownedFriendIds.size
      };
    })
    .filter((candidate) => candidate.recentFriendCount > 0 || candidate.ownedFriendCount > 1)
    .sort((left, right) => {
      if (right.recentFriendCount !== left.recentFriendCount) {
        return right.recentFriendCount - left.recentFriendCount;
      }

      return right.friendCount - left.friendCount;
    })
    .slice(0, Math.max(
      previewMode ? 10 : STEAM_FRIEND_RECOMMENDATION_METADATA_LIMIT,
      (pagination.skip + pagination.limit) * 3
    ));

  if (candidateSummaries.length === 0) {
    return {
      items: [],
      totalCount: 0,
      metadata: {
        steamConnected: true,
        steamFriendCount: friendSteamIds.length,
        steamAvailable: true,
        steamReason: 'no_recommendation_data'
      }
    };
  }

  const tagResults = await mapWithConcurrencyLimit(
    candidateSummaries,
    STEAM_STORE_TAG_FETCH_CONCURRENCY,
    async (candidate) => {
      const storeGenreResult = await steamService.fetchSteamStoreGenres({
        appId: candidate.externalGameId
      });

      return [candidate.externalGameId, storeGenreResult.tags];
    }
  );
  const steamTagMap = new Map();

  for (const result of tagResults) {
    if (result.status !== 'fulfilled') {
      continue;
    }

    const [externalGameId, steamTags] = result.value;
    steamTagMap.set(externalGameId, steamTags);
  }

  let steamMappingContext = createEmptySteamMappingContext();

  try {
    const steamMappingResolution = await resolveSteamMappingContextForGames({
      games: candidateSummaries.map((candidate) => ({
        userId,
        externalGameId: candidate.externalGameId,
        gameName: candidate.title
      })),
      activeResolution: false,
      createMissingMappingsWhenUncached: true,
      logLabel: 'steam-friend-recommendations',
      userId
    });
    steamMappingContext = steamMappingResolution.mappingContext;
  } catch (error) {
    logger.warn('Steam friend recommendation mapping lookup skipped', {
      userId,
      code: error?.code ?? null,
      message: error?.message ?? 'Steam mapping cache lookup failed'
    });
  }

  const scoredRecommendations = candidateSummaries
    .map((candidate) => {
      const steamTags = steamTagMap.get(candidate.externalGameId) ?? [];
      const hasMultiplayerSupport = hasSteamSocialPlayTag(steamTags, STEAM_MULTIPLAYER_TAG_KEYS);
      const hasCoopSupport = hasSteamSocialPlayTag(steamTags, STEAM_COOP_TAG_KEYS);
      const mappingOptions = buildSteamLibraryEntryMappingOptions(candidate.externalGameId, steamMappingContext, userId);
      const detailPayload = buildNormalizedDetailPayload({
        endpoint: previewMode ? 'library_friend_recommendations_preview' : 'library_friend_recommendations',
        title: candidate.title,
        externalGameId: candidate.externalGameId,
        igdbGameId: mappingOptions.igdbGameId,
        reason: mappingOptions.igdbGameId ? null : 'steam_friend_mapping_missing',
        mappingStatus: mappingOptions.matchStatus ?? null,
        mappingSource: mappingOptions.metadataEnriched ? 'confirmed_mapping' : 'steam_friend_activity'
      });
      const recommendationScore = scoreSteamFriendRecommendation({
        friendCount: candidate.friendCount,
        recentFriendCount: candidate.recentFriendCount,
        hasMultiplayerSupport,
        hasCoopSupport
      });

      return {
        source: 'steam',
        gameSource: 'steam',
        externalGameId: candidate.externalGameId,
        metadataEnriched: mappingOptions.metadataEnriched,
        enrichmentStatus: resolveSteamEnrichmentStatus({
          gameSource: 'steam',
          metadataEnriched: mappingOptions.metadataEnriched,
          matchStatus: mappingOptions.matchStatus
        }),
        rating: typeof mappingOptions.rating === 'number' ? mappingOptions.rating : null,
        aggregatedRating: typeof mappingOptions.aggregatedRating === 'number' ? mappingOptions.aggregatedRating : null,
        totalRating: typeof mappingOptions.totalRating === 'number' ? mappingOptions.totalRating : null,
        title: candidate.title,
        coverUrl: buildGameImageResolverUrl({
          gameSource: 'steam',
          externalGameId: candidate.externalGameId,
          igdbCoverUrl: mappingOptions.igdbCoverUrl
        }),
        ...detailPayload,
        friendCount: candidate.friendCount,
        recommendationScore,
        reason: buildSteamFriendRecommendationReason({
          friendCount: candidate.friendCount,
          recentFriendCount: candidate.recentFriendCount,
          hasMultiplayerSupport,
          hasCoopSupport
        }),
        matchedSignals: [
          ...(candidate.recentFriendCount > 0 ? ['recent_friend_activity'] : []),
          ...(hasCoopSupport || hasMultiplayerSupport ? ['social_play_fit'] : []),
          'steam_friend_activity'
        ]
      };
    })
    .sort((left, right) => right.recommendationScore - left.recommendationScore);
  const { items, totalCount } = paginateItems(scoredRecommendations, pagination);

  logger.info('Steam friend recommendations computed', {
    userId,
    steamId64,
    friendCount: friendSteamIds.length,
    candidateCount: scoredRecommendations.length,
    recommendationCount: items.length
  });
  for (const item of items) {
    logRecommendationRatingPayload({
      endpoint: previewMode ? 'library_friend_recommendations_preview' : 'library_friend_recommendations',
      title: item?.title ?? null,
      externalGameId: item?.externalGameId ?? null,
      igdbGameId: item?.igdbGameId ?? null,
      aggregatedRating: item?.aggregatedRating ?? null,
      totalRating: item?.totalRating ?? null,
      rating: item?.rating ?? null,
      detailAvailable: item?.detailAvailable === true
    });
  }

  return {
    items,
    totalCount,
    metadata: {
      steamConnected: true,
      steamFriendCount: friendSteamIds.length,
      steamAvailable: true,
      steamReason: null
    }
  };
}

async function getMySteamFriendRecommendations({
  userId,
  page = 1,
  limit = LIBRARY_FULL_DEFAULT_LIMIT,
  sort = 'score_desc',
  previewMode = false,
  allowLiveSteamApi = true
}) {
  const pagination = resolvePaginationParams({
    page,
    limit,
    defaultLimit: previewMode ? LIBRARY_PREVIEW_LIMITS.friendRecommendations : LIBRARY_FULL_DEFAULT_LIMIT
  });
  const inAppResult = await loadInAppFriendRecommendations({
    userId,
    pagination
  });

  if (inAppResult.items.length > 0) {
    logger.info('library-friend-recommendations', {
      userId,
      appFriendRecommendationCount: inAppResult.items.length,
      steamRecommendationCount: 0,
      fallbackUsed: false,
      finalSourceSelected: FRIEND_RECOMMENDATION_SOURCE.IN_APP,
      emptyReason: null
    });

    const response = buildPaginatedRecommendationResponse({
      pagination,
      sort,
      source: FRIEND_RECOMMENDATION_SOURCE.IN_APP,
      items: inAppResult.items,
      totalCount: inAppResult.totalCount,
      metadata: {
        appFriendCount: inAppResult.metadata.appFriendCount,
        appFriendActivityCount: inAppResult.metadata.appFriendActivityCount,
        steamFriendCount: 0,
        fallbackUsed: false
      }
    });
    response.friendRecommendationState = buildFriendRecommendationState({
      previewMode,
      source: response.source,
      metadata: response.metadata
    });
    response.friendRecommendationsState = response.friendRecommendationState;
    response.responseMeta = buildLibraryResponseMeta();
    return response;
  }

  const steamResult = await loadSteamFriendRecommendations({
    userId,
    pagination,
    previewMode,
    allowLiveSteamApi
  });

  if (steamResult.items.length > 0) {
    logger.info('library-friend-recommendations', {
      userId,
      appFriendRecommendationCount: 0,
      steamRecommendationCount: steamResult.items.length,
      fallbackUsed: true,
      finalSourceSelected: FRIEND_RECOMMENDATION_SOURCE.STEAM,
      emptyReason: null
    });

    const response = buildPaginatedRecommendationResponse({
      pagination,
      sort,
      source: FRIEND_RECOMMENDATION_SOURCE.STEAM,
      items: steamResult.items,
      totalCount: steamResult.totalCount,
      metadata: {
        appFriendCount: inAppResult.metadata.appFriendCount,
        appFriendActivityCount: inAppResult.metadata.appFriendActivityCount,
        steamFriendCount: steamResult.metadata.steamFriendCount,
        fallbackUsed: true
      }
    });
    response.friendRecommendationState = buildFriendRecommendationState({
      previewMode,
      source: response.source,
      metadata: steamResult.metadata
    });
    response.friendRecommendationsState = response.friendRecommendationState;
    response.responseMeta = buildLibraryResponseMeta();
    return response;
  }

  let emptyReason = FRIEND_RECOMMENDATION_EMPTY_REASON.NO_RECOMMENDATION_DATA;

  if (inAppResult.metadata.appFriendCount === 0 && !steamResult.metadata.steamConnected) {
    emptyReason = FRIEND_RECOMMENDATION_EMPTY_REASON.NO_APP_FRIENDS_AND_NO_STEAM;
  } else if (inAppResult.metadata.appFriendCount > 0 && inAppResult.metadata.appFriendActivityCount === 0 && !steamResult.metadata.steamConnected) {
    emptyReason = FRIEND_RECOMMENDATION_EMPTY_REASON.APP_FRIENDS_BUT_NOT_ENOUGH_ACTIVITY;
  } else if (steamResult.metadata.steamConnected && !steamResult.metadata.steamAvailable) {
    emptyReason = FRIEND_RECOMMENDATION_EMPTY_REASON.STEAM_FRIENDS_UNAVAILABLE_OR_PRIVATE;
  } else if (inAppResult.metadata.appFriendCount > 0 && inAppResult.metadata.appFriendActivityCount === 0) {
    emptyReason = FRIEND_RECOMMENDATION_EMPTY_REASON.APP_FRIENDS_BUT_NOT_ENOUGH_ACTIVITY;
  }

  logger.info('library-friend-recommendations', {
    userId,
    appFriendRecommendationCount: 0,
    steamRecommendationCount: 0,
    fallbackUsed: true,
    finalSourceSelected: FRIEND_RECOMMENDATION_SOURCE.NONE,
    emptyReason
  });

  const response = buildRecommendationResponse({
    pagination,
    sort,
    source: FRIEND_RECOMMENDATION_SOURCE.NONE,
    items: [],
    emptyReason,
    metadata: {
      appFriendCount: inAppResult.metadata.appFriendCount,
      appFriendActivityCount: inAppResult.metadata.appFriendActivityCount,
      steamFriendCount: steamResult.metadata.steamFriendCount,
      fallbackUsed: true
    }
  });
  response.friendRecommendationState = buildFriendRecommendationState({
    previewMode,
    source: response.source,
    metadata: steamResult.metadata
  });
  response.friendRecommendationsState = response.friendRecommendationState;
  response.responseMeta = buildLibraryResponseMeta();
  return response;
}

async function buildPlaytimePreferenceProfile({
  steamLibraryEntries,
  recentGames,
  steamMappingContext,
  userId,
  allowLiveSteamApi = true
}) {
  const topLifetimeEntries = [...(steamLibraryEntries ?? [])]
    .filter((entry) => Number.isInteger(entry.playtimeMinutes) && entry.playtimeMinutes > 0)
    .sort((left, right) => right.playtimeMinutes - left.playtimeMinutes)
    .slice(0, PLAYTIME_PROFILE_TOP_LIFETIME_COUNT);
  const topRecentGames = [...(recentGames ?? [])]
    .filter((game) => Number.isInteger(game.recentPlaytimeMinutes) && game.recentPlaytimeMinutes > 0)
    .sort((left, right) => right.recentPlaytimeMinutes - left.recentPlaytimeMinutes)
    .slice(0, PLAYTIME_PROFILE_TOP_RECENT_COUNT);
  const seedMap = new Map();

  for (const entry of topLifetimeEntries) {
    seedMap.set(entry.externalGameId, {
      externalGameId: entry.externalGameId,
      title: entry.gameName,
      playtimeMinutes: entry.playtimeMinutes,
      recentPlaytimeMinutes: null
    });
  }

  for (const game of topRecentGames) {
    const seed = seedMap.get(game.externalGameId) ?? {
      externalGameId: game.externalGameId,
      title: game.title,
      playtimeMinutes: game.playtimeMinutes ?? null,
      recentPlaytimeMinutes: null
    };

    seed.recentPlaytimeMinutes = game.recentPlaytimeMinutes ?? seed.recentPlaytimeMinutes;
    seed.playtimeMinutes = Number.isInteger(seed.playtimeMinutes)
      ? seed.playtimeMinutes
      : (game.playtimeMinutes ?? null);
    seedMap.set(game.externalGameId, seed);
  }

  const seedAppIds = [...seedMap.keys()];

  if (seedAppIds.length === 0) {
    return null;
  }

  const seedIgdbIds = seedAppIds
    .map((externalGameId) => buildSteamLibraryEntryMappingOptions(externalGameId, steamMappingContext, userId).igdbGameId)
    .filter(Boolean);
  const [seedIgdbGameMap, steamTagResults] = await Promise.all([
    buildIgdbGameMap(seedIgdbIds),
    allowLiveSteamApi
      ? Promise.allSettled(
        seedAppIds.map(async (externalGameId) => {
          const storeGenreResult = await steamService.fetchSteamStoreGenres({
            appId: externalGameId
          });

          return [externalGameId, storeGenreResult.tags];
        })
      )
      : Promise.resolve([])
  ]);
  const steamTagMap = new Map();

  for (const result of steamTagResults) {
    if (result.status !== 'fulfilled') {
      continue;
    }

    const [externalGameId, steamTags] = result.value;
    steamTagMap.set(externalGameId, steamTags);
  }

  const genreWeights = new Map();
  const tagWeights = new Map();
  const recentGenreWeights = new Map();
  let weightedRecentMinutes = 0;
  let weightedRecentCount = 0;
  let weightedLifetimeMinutes = 0;
  let weightedLifetimeCount = 0;
  const recentSeedTitles = [];
  const lifetimeSeedTitles = [];

  for (const seed of seedMap.values()) {
    const mappingOptions = buildSteamLibraryEntryMappingOptions(seed.externalGameId, steamMappingContext, userId);
    const mappedGame = mappingOptions.igdbGameId
      ? seedIgdbGameMap.get(mappingOptions.igdbGameId) ?? null
      : null;
    const labelSource = Array.isArray(mappedGame?.genres) && mappedGame.genres.length > 0
      ? mappedGame.genres
      : (steamTagMap.get(seed.externalGameId) ?? []);
    const tagSource = steamTagMap.get(seed.externalGameId) ?? labelSource;
    const lifetimeWeight = Number.isInteger(seed.playtimeMinutes) && seed.playtimeMinutes > 0
      ? Math.log1p(seed.playtimeMinutes)
      : 0;
    const recentWeight = Number.isInteger(seed.recentPlaytimeMinutes) && seed.recentPlaytimeMinutes > 0
      ? Math.log1p(seed.recentPlaytimeMinutes) * 1.3
      : 0;

    addWeightedLabels(genreWeights, labelSource, lifetimeWeight + (recentWeight * 0.35));
    addWeightedLabels(tagWeights, tagSource, (lifetimeWeight * 0.4) + recentWeight);
    addWeightedLabels(recentGenreWeights, labelSource, recentWeight);

    if (recentWeight > 0 && Number.isInteger(seed.recentPlaytimeMinutes)) {
      weightedRecentMinutes += seed.recentPlaytimeMinutes * recentWeight;
      weightedRecentCount += recentWeight;
      recentSeedTitles.push(seed.title);
    }

    if (lifetimeWeight > 0 && Number.isInteger(seed.playtimeMinutes)) {
      weightedLifetimeMinutes += seed.playtimeMinutes * lifetimeWeight;
      weightedLifetimeCount += lifetimeWeight;
      lifetimeSeedTitles.push(seed.title);
    }
  }

  return {
    genreWeights,
    tagWeights,
    recentGenreWeights,
    recentSessionPreference: classifySessionPreference(
      weightedRecentCount > 0 ? weightedRecentMinutes / weightedRecentCount : 0
    ),
    longTermSessionPreference: classifySessionPreference(
      weightedLifetimeCount > 0 ? (weightedLifetimeMinutes / weightedLifetimeCount) / 12 : 0
    ),
    recentSeedTitles: [...new Set(recentSeedTitles.filter(Boolean))].slice(0, 3),
    lifetimeSeedTitles: [...new Set(lifetimeSeedTitles.filter(Boolean))].slice(0, 3)
  };
}

async function getMyPlaytimeBasedRecommendations({
  userId,
  page = 1,
  limit = LIBRARY_FULL_DEFAULT_LIMIT,
  sort = 'score_desc',
  previewMode = false,
  allowLiveSteamApi = true
}) {
  const pagination = resolvePaginationParams({
    page,
    limit,
    defaultLimit: previewMode ? LIBRARY_PREVIEW_LIMITS.playtimeRecommendations : LIBRARY_FULL_DEFAULT_LIMIT
  });
  let steamAccount;

  try {
    steamAccount = await getSteamSocialAccount(userId);
  } catch (error) {
    logger.warn('Playtime recommendations unavailable', {
      userId,
      reason: 'steam_account_lookup_failed',
      code: error?.code ?? null,
      message: error?.message ?? 'Steam account lookup failed'
    });

    return {
      recommendations: [],
      playtimeRecommendations: [],
      meta: buildPaginatedMeta({
        page: pagination.page,
        limit: pagination.limit,
        totalCount: 0,
        sort
      }),
      source: 'none',
      enrichmentStatus: 'none',
      responseMeta: buildLibraryResponseMeta()
    };
  }

  if (!steamAccount) {
    return {
      recommendations: [],
      playtimeRecommendations: [],
      meta: buildPaginatedMeta({
        page: pagination.page,
        limit: pagination.limit,
        totalCount: 0,
        sort
      }),
      source: 'none',
      enrichmentStatus: 'none',
      responseMeta: buildLibraryResponseMeta()
    };
  }

  const steamId64 = steamService.normalizeSteamId64(steamAccount.providerSubject);
  const recentSnapshot = normalizeSteamRecentPlayedSnapshot(steamAccount.steamRecentPlayedSnapshot);

  if (!steamId64 && allowLiveSteamApi) {
    return {
      recommendations: [],
      playtimeRecommendations: [],
      meta: buildPaginatedMeta({
        page: pagination.page,
        limit: pagination.limit,
        totalCount: 0,
        sort
      }),
      source: 'none',
      enrichmentStatus: 'none',
      responseMeta: buildLibraryResponseMeta()
    };
  }

  const [steamLibraryEntries, igdbLibraryEntries, favoriteResult, reviewResult, recentGamesResult] = await Promise.all([
    getSteamLibraryEntriesMemoized({
      userId,
      gameSource: GameSource.STEAM,
      orderBy: {
        updatedAt: 'desc'
      }
    }),
    prisma.userGameLibrary.findMany({
      where: {
        userId,
        gameSource: GameSource.IGDB
      },
      select: {
        externalGameId: true
      }
    }),
    getMyFavoritesMemoized({
      userId,
      sort: 'latest'
    }),
    getMyReviewsMemoized({
      userId,
      sort: 'latest'
    }),
    allowLiveSteamApi && steamId64 && steamService.isSteamSyncConfigured()
      ? fetchRecentlyPlayedGamesDedup({ userId, steamId64 })
        .catch((error) => {
          logger.warn('Playtime recommendations recent activity lookup failed', {
            userId,
            steamId64,
            code: error?.code ?? null,
            message: error?.message ?? 'Steam recently played lookup failed'
          });

          return {
            games: []
          };
        })
      : Promise.resolve({
        games: []
      })
  ]);
  const effectiveSteamLibraryEntries = steamLibraryEntries.length > 0
    ? steamLibraryEntries
    : recentSnapshot.games
      .filter((game) => Number.isInteger(game.playtimeMinutes) || Number.isInteger(game.recentPlaytimeMinutes))
      .map((game) => ({
        userId,
        gameSource: GameSource.STEAM,
        externalGameId: game.externalGameId,
        gameName: game.title ?? `Steam App ${game.externalGameId}`,
        coverUrl: null,
        status: GameLibraryStatus.BACKLOG,
        startedAt: null,
        completedAt: null,
        lastPlayedAt: game.lastPlayedAt ? new Date(game.lastPlayedAt) : null,
        playtimeMinutes: game.playtimeMinutes ?? null,
        createdAt: null,
        updatedAt: game.lastPlayedAt ? new Date(game.lastPlayedAt) : new Date(0)
      }));

  if (effectiveSteamLibraryEntries.length === 0 && recentGamesResult.games.length === 0) {
    return {
      recommendations: [],
      playtimeRecommendations: [],
      meta: buildPaginatedMeta({
        page: pagination.page,
        limit: pagination.limit,
        totalCount: 0,
        sort
      }),
      source: 'none',
      enrichmentStatus: 'none',
      responseMeta: buildLibraryResponseMeta()
    };
  }

  let steamMappingContext = createEmptySteamMappingContext();

  try {
    const steamMappingResolution = await resolveSteamMappingContextForGames({
      games: [
        ...effectiveSteamLibraryEntries.map((entry) => ({
          userId,
          externalGameId: entry.externalGameId,
          gameName: entry.gameName
        })),
        ...recentGamesResult.games.map((game) => ({
          userId,
          externalGameId: game.externalGameId,
          gameName: game.title
        }))
      ],
      activeResolution: false,
      createMissingMappingsWhenUncached: true,
      logLabel: 'playtime-recommendations',
      userId
    });
    steamMappingContext = steamMappingResolution.mappingContext;
  } catch (error) {
    logger.warn('Playtime recommendations mapping lookup skipped', {
      userId,
      code: error?.code ?? null,
      message: error?.message ?? 'Steam mapping cache lookup failed'
    });
  }

  const preferenceProfile = await buildPlaytimePreferenceProfile({
    steamLibraryEntries: effectiveSteamLibraryEntries,
    recentGames: recentGamesResult.games,
    steamMappingContext,
    userId,
    allowLiveSteamApi
  });

  if (!preferenceProfile) {
    return {
      recommendations: [],
      playtimeRecommendations: [],
      meta: buildPaginatedMeta({
        page: pagination.page,
        limit: pagination.limit,
        totalCount: 0,
        sort
      }),
      source: 'none',
      enrichmentStatus: 'none',
      responseMeta: buildLibraryResponseMeta()
    };
  }

  const excludedIgdbIds = new Set([
    ...igdbLibraryEntries.map((entry) => entry.externalGameId),
    ...favoriteResult.favorites.map((favorite) => favorite.gameId),
    ...reviewResult.reviews.map((review) => review.gameId),
    ...effectiveSteamLibraryEntries
      .map((entry) => buildSteamLibraryEntryMappingOptions(entry.externalGameId, steamMappingContext, userId).igdbGameId)
      .filter(Boolean)
  ]);
  let popularGamesResult;
  let recommendedGamesResult;
  const candidateLimit = Math.max(
    previewMode ? 20 : PLAYTIME_RECOMMENDATION_CANDIDATE_LIMIT,
    (pagination.skip + pagination.limit) * 4
  );
  const buildPlaytimeFallbackResponse = ({ reason, code = null, message = null }) => {
    const fallbackPoolByExternalGameId = new Map(
      effectiveSteamLibraryEntries.map((entry) => [entry.externalGameId, entry])
    );

    for (const game of recentGamesResult.games) {
      if (fallbackPoolByExternalGameId.has(game.externalGameId)) {
        continue;
      }

      fallbackPoolByExternalGameId.set(game.externalGameId, {
        userId,
        gameSource: GameSource.STEAM,
        externalGameId: game.externalGameId,
        gameName: game.title ?? `Steam App ${game.externalGameId}`,
        coverUrl: null,
        status: GameLibraryStatus.BACKLOG,
        startedAt: null,
        completedAt: null,
        lastPlayedAt: game.lastPlayedAt ? new Date(game.lastPlayedAt) : null,
        playtimeMinutes: game.playtimeMinutes ?? null,
        recentPlaytimeMinutes: game.recentPlaytimeMinutes ?? null,
        createdAt: null,
        updatedAt: game.lastPlayedAt ? new Date(game.lastPlayedAt) : new Date()
      });
    }

    const fallbackResponse = buildSteamOnlyPlaytimeRecommendations({
      steamLibraryEntries: [...fallbackPoolByExternalGameId.values()],
      steamMappingContext,
      userId,
      pagination,
      sort
    });

    logger.warn('igdb-timeout-fallback', {
      userId,
      reason,
      code,
      message,
      recoveredUsing: 'steam_only',
      steamLibraryCount: effectiveSteamLibraryEntries.length,
      recommendationCount: fallbackResponse.playtimeRecommendations.length
    });

    return fallbackResponse;
  };

  try {
    try {
      [popularGamesResult, recommendedGamesResult] = await Promise.all([
        igdbService.getPopularGames({ limit: candidateLimit }),
        igdbService.getRecommendedGames({ limit: candidateLimit })
      ]);
    } catch (error) {
      logger.warn('Playtime recommendations candidate lookup retrying', {
        userId,
        code: error?.code ?? null,
        message: error?.message ?? 'IGDB candidate lookup failed'
      });

      [popularGamesResult, recommendedGamesResult] = await Promise.all([
        igdbService.getPopularGames({ limit: candidateLimit }),
        igdbService.getRecommendedGames({ limit: candidateLimit })
      ]);
    }
  } catch (error) {
    logger.warn('Playtime recommendations candidate lookup failed', {
      userId,
      code: error?.code ?? null,
      message: error?.message ?? 'IGDB candidate lookup failed'
    });
    return buildPlaytimeFallbackResponse({
      reason: 'igdb_candidate_lookup_failed',
      code: error?.code ?? null,
      message: error?.message ?? 'IGDB candidate lookup failed'
    });
  }
  const candidateGameMap = new Map();

  for (const game of [...popularGamesResult.games, ...recommendedGamesResult.games]) {
    const gameId = String(game.id);

    if (excludedIgdbIds.has(gameId)) {
      continue;
    }

    candidateGameMap.set(gameId, game);
  }

  const scoredCandidates = [...candidateGameMap.values()].map((game) => {
    const candidateGenreLabels = Array.isArray(game.genres) ? game.genres : [];
    const candidateTagLabels = [
      ...candidateGenreLabels,
      ...(Array.isArray(game.platforms) ? game.platforms : [])
    ];
    const genreScore = computeWeightedOverlap(preferenceProfile.genreWeights, candidateGenreLabels);
    const tagScore = computeWeightedOverlap(preferenceProfile.tagWeights, candidateTagLabels);
    const recentAffinityScore = computeWeightedOverlap(preferenceProfile.recentGenreWeights, candidateGenreLabels);
    const candidatePace = classifyGameplayPace(candidateTagLabels);
    const playPatternScore = computePaceSimilarity(preferenceProfile.recentSessionPreference, candidatePace);
    const paceScore = computePaceSimilarity(preferenceProfile.longTermSessionPreference, candidatePace);
    const recommendationScore = Math.round(
      (
        (genreScore * 0.32) +
        (tagScore * 0.18) +
        (recentAffinityScore * 0.22) +
        (playPatternScore * 0.14) +
        (paceScore * 0.14)
      ) * 100
    );

    return {
      ...game,
      source: 'igdb',
      gameSource: 'igdb',
      externalGameId: String(game.id),
      igdbGameId: String(game.id),
      metadataEnriched: true,
      detailAvailable: true,
      title: game.name,
      recommendationScore,
      matchedSignals: buildPlaytimeMatchedSignals({
        genreScore,
        tagScore,
        recentAffinityScore,
        playPatternScore,
        paceScore
      }),
      reason: buildPlaytimeRecommendationReason({
        recentAffinityScore,
        genreScore,
        tagScore,
        playPatternScore,
        paceScore
      }),
      primaryGenreKey: normalizeSteamGenreTag(game.genres?.[0]) ?? 'misc'
    };
  }).filter((candidate) => candidate.recommendationScore > 0);

  const selectedRecommendations = selectDiverseRecommendations(
    scoredCandidates,
    Math.max(PLAYTIME_RECOMMENDATION_LIMIT, pagination.skip + pagination.limit)
  );
  const { items: paginatedRecommendations, totalCount } = paginateItems(selectedRecommendations, pagination);
  const recommendations = paginatedRecommendations.map(({ primaryGenreKey, ...candidate }) => candidate);

  logger.info('Playtime recommendations computed', {
    userId,
    steamId64,
    steamLibraryCount: effectiveSteamLibraryEntries.length,
    persistedSteamLibraryCount: steamLibraryEntries.length,
    recentSnapshotCount: recentSnapshot.games.length,
    recentGameCount: recentGamesResult.games.length,
    candidateCount: scoredCandidates.length,
    recommendationCount: recommendations.length
  });

  return {
    recommendations,
    playtimeRecommendations: recommendations,
    meta: buildPaginatedMeta({
      page: pagination.page,
      limit: pagination.limit,
      totalCount,
      sort
    }),
    source: 'igdb',
    enrichmentStatus: 'full',
    responseMeta: buildLibraryResponseMeta()
  };
}

async function startSteamLink({ userId, redirectUri }) {
  const resolvedRedirectUri = normalizeRedirectBaseUrl(redirectUri);

  logger.info('Steam link start requested', {
    userId,
    hasRedirectUri: Boolean(resolvedRedirectUri),
    redirectTargetType: 'mobile-app'
  });

  return {
    steamLink: steamService.buildSteamLinkUrl({
      userId,
      redirectUri: resolvedRedirectUri
    })
  };
}

async function completeSteamLink({ query, callbackContext }) {
  const verifiedContext = callbackContext ?? steamService.parseSteamLinkState(query.state);
  const { steamId64: verifiedSteamId64 } = await steamService.verifySteamOpenIdCallback(query);
  const steamId64 = steamService.normalizeSteamId64(verifiedSteamId64);

  if (!steamId64) {
    throw new AppError(400, 'STEAM_ID_INVALID', 'Steam account identifier is invalid');
  }

  const [existingBySteamId, existingByUser, profile] = await Promise.all([
    prisma.socialAccount.findUnique({
      where: {
        provider_providerSubject: {
          provider: steamService.STEAM_AUTH_PROVIDER,
          providerSubject: steamId64
        }
      },
      select: steamAccountSelect
    }),
    getSteamSocialAccount(verifiedContext.userId),
    steamService.fetchPlayerSummarySafe({ steamId64 })
  ]);

  if (existingBySteamId && existingBySteamId.userId !== verifiedContext.userId) {
    throw new AppError(409, 'STEAM_ACCOUNT_ALREADY_LINKED', 'This Steam account is already linked to another user');
  }

  if (existingByUser && existingByUser.providerSubject !== steamId64) {
    throw new AppError(409, 'STEAM_ACCOUNT_LINK_CONFLICT', 'Unlink the current Steam account before linking a different one');
  }

  const writeData = {
    providerSubject: steamId64,
    personaName: profile.personaName,
    profileUrl: profile.profileUrl,
    avatarUrl: profile.avatarUrl
  };

  const steamAccount = existingByUser
    ? await prisma.socialAccount.update({
      where: { id: existingByUser.id },
      data: writeData,
      select: steamAccountSelect
    })
    : await prisma.socialAccount.create({
      data: {
        userId: verifiedContext.userId,
        provider: steamService.STEAM_AUTH_PROVIDER,
        linkedAt: new Date(),
        ...writeData
      },
      select: steamAccountSelect
    });

  logger.info('Steam link completed', {
    userId: verifiedContext.userId,
    steamId64,
    hasRedirectUri: Boolean(verifiedContext.redirectUri),
    hasPersonaName: Boolean(profile.personaName),
    hasAvatarUrl: Boolean(profile.avatarUrl),
    hasProfileUrl: Boolean(profile.profileUrl)
  });

  return {
    linked: true,
    redirectUri: verifiedContext.redirectUri,
    steamAccount: mapSteamLinkStatus(steamAccount)
  };
}

async function unlinkSteamAccount({ userId }) {
  const [existingSteamAccount, existingSteamLibraryRowCount] = await Promise.all([
    getSteamSocialAccount(userId),
    prisma.userGameLibrary.count({
      where: {
        userId,
        gameSource: GameSource.STEAM
      }
    })
  ]);
  const steamId64 = steamService.normalizeSteamId64(existingSteamAccount?.providerSubject);

  logger.info('steam-unlink-started', {
    userId,
    hadSteamLink: Boolean(existingSteamAccount),
    existingSteamLibraryRowCount
  });

  const [
    deleteResult,
    deletedSteamLibraryRows,
    deletedSteamActivityEvents,
    deletedSteamPresenceSnapshots
  ] = await prisma.$transaction([
    prisma.socialAccount.deleteMany({
      where: {
        userId,
        provider: steamService.STEAM_AUTH_PROVIDER
      }
    }),
    prisma.userGameLibrary.deleteMany({
      where: {
        userId,
        gameSource: GameSource.STEAM
      }
    }),
    prisma.userActivityEvent.deleteMany({
      where: {
        actorUserId: userId,
        OR: [
          {
            activityType: USER_ACTIVITY_TYPE.STEAM_RECENTLY_PLAYED_SYNC
          },
          {
            gameSource: GameSource.STEAM
          }
        ]
      }
    }),
    prisma.userPresenceSnapshot.deleteMany({
      where: {
        userId,
        OR: [
          {
            gameSource: GameSource.STEAM
          },
          {
            source: {
              in: STEAM_PRESENCE_SOURCES
            }
          }
        ]
      }
    })
  ]);

  clearSteamSyncInProgress(userId);
  invalidateSteamLibraryRuntimeCaches({ steamId64 });

  logger.info('steam-unlink-library-cleanup-completed', {
    userId,
    hadSteamLink: Boolean(existingSteamAccount),
    unlinkSucceeded: deleteResult.count > 0 || !existingSteamAccount,
    deletedSocialAccountCount: deleteResult.count,
    deletedSteamLibraryRowCount: deletedSteamLibraryRows.count
  });

  logger.info('steam-unlink-presence-cleared', {
    userId,
    deletedSteamActivityEventCount: deletedSteamActivityEvents.count,
    deletedSteamPresenceSnapshotCount: deletedSteamPresenceSnapshots.count
  });

  logger.info('steam-disconnect-state', {
    userId,
    steamAccountExisted: Boolean(existingSteamAccount),
    disconnectApplied: deleteResult.count > 0 || !existingSteamAccount,
    steamDataRetained: false,
    retainedGameCount: 0
  });

  return {
    unlinked: true,
    steamLinkStatus: mapSteamLinkStatus(null)
  };
}

async function resolveSteamFallbackGameData({ userId, externalGameId }) {
  const [libraryEntry, cachedMapping, steamAccount] = await Promise.all([
    prisma.userGameLibrary.findUnique({
      where: {
        userId_gameSource_externalGameId: {
          userId,
          gameSource: GameSource.STEAM,
          externalGameId
        }
      }
    }),
    prisma.steamIgdbMapping.findUnique({
      where: {
        steamAppId: externalGameId
      }
    }),
    getSteamSocialAccount(userId)
  ]);

  let gameName = libraryEntry?.gameName ?? cachedMapping?.matchedTitle ?? null;
  let playtimeMinutes = libraryEntry?.playtimeMinutes ?? null;
  let recentPlaytimeMinutes = null;
  const existingIgdbCoverUrl = extractUsableIgdbCoverUrl(libraryEntry?.coverUrl);

  if (
    (!gameName || !Number.isInteger(playtimeMinutes) || !Number.isInteger(recentPlaytimeMinutes)) &&
    steamAccount &&
    steamService.isSteamSyncConfigured()
  ) {
    const steamId64 = steamService.normalizeSteamId64(steamAccount.providerSubject);

    if (steamId64) {
      try {
        const ownedGamesResult = await fetchOwnedGamesDedup({ userId, steamId64 });
        const ownedGame = ownedGamesResult.games.find((game) => game.externalGameId === externalGameId) ?? null;

        if (ownedGame) {
          gameName = gameName ?? ownedGame.gameName ?? null;
          playtimeMinutes = Number.isInteger(playtimeMinutes)
            ? playtimeMinutes
            : (Number.isInteger(ownedGame.playtimeMinutes) ? ownedGame.playtimeMinutes : null);
          recentPlaytimeMinutes = Number.isInteger(ownedGame.recentPlaytimeMinutes)
            ? ownedGame.recentPlaytimeMinutes
            : recentPlaytimeMinutes;
        }
      } catch (error) {
        logger.warn('Steam fallback detail could not load owned game data', {
          userId,
          externalGameId,
          code: error?.code,
          message: error?.message
        });
      }

      if (!gameName || !Number.isInteger(recentPlaytimeMinutes)) {
        try {
          const recentGamesResult = await fetchRecentlyPlayedGamesDedup({ userId, steamId64 });
          const recentGame = recentGamesResult.games.find((game) => game.externalGameId === externalGameId) ?? null;

          if (recentGame) {
            gameName = gameName ?? recentGame.title ?? null;
            playtimeMinutes = Number.isInteger(playtimeMinutes)
              ? playtimeMinutes
              : (Number.isInteger(recentGame.playtimeMinutes) ? recentGame.playtimeMinutes : null);
            recentPlaytimeMinutes = Number.isInteger(recentGame.recentPlaytimeMinutes)
              ? recentGame.recentPlaytimeMinutes
              : recentPlaytimeMinutes;
          }
        } catch (error) {
          logger.warn('Steam fallback detail could not load recently played data', {
            userId,
            externalGameId,
            code: error?.code,
            message: error?.message
          });
        }
      }
    }
  }

  return {
    gameName,
    playtimeMinutes,
    recentPlaytimeMinutes,
    igdbCoverUrl: existingIgdbCoverUrl
  };
}

async function resolveSteamGenreFallback({ userId, externalGameId, igdbGenres = [] }) {
  const igdbGenreFallback = resolveGenreFallback({ igdbGenres });

  if (igdbGenreFallback.genreDisplayName) {
    return igdbGenreFallback;
  }

  try {
    const storeGenreResult = await steamService.fetchSteamStoreGenres({ appId: externalGameId });

    return resolveGenreFallback({
      steamTags: storeGenreResult.tags
    });
  } catch (error) {
    logger.warn('Steam fallback detail could not load store genre tags', {
      userId,
      externalGameId,
      code: error?.code,
      message: error?.message
    });

    return {
      genreDisplayName: null,
      genreSource: null
    };
  }
}

async function buildSteamDetailEnrichmentDiagnostic({
  userId,
  gameSource,
  externalGameId,
  requestedIgdbGameId
}) {
  const [libraryRow, mappingRow, sourceSnapshot] = await Promise.all([
    prisma.userGameLibrary.findUnique({
      where: {
        userId_gameSource_externalGameId: {
          userId,
          gameSource: GameSource.STEAM,
          externalGameId
        }
      }
    }),
    prisma.steamIgdbMapping.findUnique({
      where: {
        steamAppId: externalGameId
      }
    }),
    getTargetSteamLibrarySourceSnapshot(externalGameId, userId)
  ]);
  const acceptedByMatchStatus = isAcceptedSteamIgdbMapping(mappingRow);
  const confidenceScore = typeof mappingRow?.confidenceScore === 'number'
    ? Number(mappingRow.confidenceScore)
    : null;
  const resolvedRawSteamTitle = libraryRow?.gameName
    ?? sourceSnapshot?.userScopedRow?.gameName
    ?? sourceSnapshot?.anyScopedTitledRow?.gameName
    ?? sourceSnapshot?.anyScopedRow?.gameName
    ?? null;
  const resolvedStoredCoverUrl = libraryRow?.coverUrl
    ?? sourceSnapshot?.userScopedRow?.coverUrl
    ?? sourceSnapshot?.anyScopedTitledRow?.coverUrl
    ?? sourceSnapshot?.anyScopedRow?.coverUrl
    ?? null;

  return {
    userId,
    gameSource,
    externalGameId,
    requestedIgdbGameId: requestedIgdbGameId ?? null,
    libraryRowFound: Boolean(libraryRow),
    rawSteamTitle: resolvedRawSteamTitle,
    storedCoverUrl: resolvedStoredCoverUrl,
    steamSourceData: sourceSnapshot
      ? {
        userScopedRowExists: Boolean(sourceSnapshot.userScopedRow),
        anyScopedTitledRowExists: Boolean(sourceSnapshot.anyScopedTitledRow),
        anyScopedRowExists: Boolean(sourceSnapshot.anyScopedRow),
        gameName: sourceSnapshot.userScopedRow?.gameName
          ?? sourceSnapshot.anyScopedTitledRow?.gameName
          ?? sourceSnapshot.anyScopedRow?.gameName
          ?? null,
        gameSource: sourceSnapshot.userScopedRow?.gameSource
          ?? sourceSnapshot.anyScopedTitledRow?.gameSource
          ?? sourceSnapshot.anyScopedRow?.gameSource
          ?? null,
        coverUrl: sourceSnapshot.userScopedRow?.coverUrl
          ?? sourceSnapshot.anyScopedTitledRow?.coverUrl
          ?? sourceSnapshot.anyScopedRow?.coverUrl
          ?? null,
        updatedAt: sourceSnapshot.userScopedRow?.updatedAt
          ?? sourceSnapshot.anyScopedTitledRow?.updatedAt
          ?? sourceSnapshot.anyScopedRow?.updatedAt
          ?? null
      }
      : null,
    mappingRowFound: Boolean(mappingRow),
    igdbGameId: mappingRow?.igdbGameId ?? null,
    matchStatus: mappingRow?.matchStatus ?? null,
    confidenceScore,
    matchedTitle: mappingRow?.matchedTitle ?? null,
    acceptedByMatchStatus,
    passesConfirmedThreshold: confidenceScore !== null ? confidenceScore >= STEAM_IGDB_CONFIRMED_THRESHOLD : false,
    passesCandidateThreshold: confidenceScore !== null ? confidenceScore >= STEAM_IGDB_CANDIDATE_THRESHOLD : false
  };
}

function resolveSteamDetailFallbackReason({
  diagnostic,
  igdbFetchAttempted = false,
  igdbFetchSucceeded = false,
  fallbackDataFound = false,
  igdbRateLimited = false
}) {
  if (igdbRateLimited) {
    return diagnostic?.acceptedByMatchStatus
      ? 'accepted_mapping_rate_limited_without_cached_detail'
      : 'igdb_rate_limited_before_enrichment';
  }

  if (!diagnostic?.mappingRowFound) {
    return fallbackDataFound ? 'mapping_missing' : 'mapping_missing_and_no_library_row';
  }

  if (!diagnostic.acceptedByMatchStatus) {
    if (diagnostic.matchStatus === 'CANDIDATE') {
      return 'mapping_row_exists_but_rejected_by_threshold';
    }

    return 'mapping_row_exists_but_rejected_by_match_status';
  }

  if (igdbFetchAttempted && !igdbFetchSucceeded) {
    return 'accepted_mapping_but_igdb_detail_fetch_failed';
  }

  return 'steam_fallback_after_unresolved_enrichment';
}

async function getLibraryGameDetail({
  userId,
  gameSource,
  externalGameId,
  igdbGameId
}) {
  const normalizedGameSource = normalizeLibraryGameSource(gameSource);
  const normalizedExternalGameId = typeof externalGameId === 'string' && externalGameId.trim()
    ? externalGameId.trim()
    : null;
  const requestedIgdbGameId = normalizeIgdbGameId(igdbGameId);
  let resolvedIgdbGameId = null;

  if (normalizedGameSource === 'igdb') {
    resolvedIgdbGameId = requestedIgdbGameId;
  }

  if (!resolvedIgdbGameId && normalizedGameSource === 'igdb') {
    resolvedIgdbGameId = normalizeIgdbGameId(normalizedExternalGameId);
  }

  let steamDetailDiagnostic = null;
  let igdbFetchAttempted = false;
  let igdbFetchSucceeded = false;
  let cachedIgdbDetailFound = false;
  let igdbLiveFetchSkippedReason = null;
  let igdbRateLimitedDuringDetail = false;
  const isTargetDebugAppId = TARGET_STEAM_DEBUG_APP_IDS.has(normalizedExternalGameId ?? '');

  if (normalizedGameSource === 'steam' && normalizedExternalGameId) {
    steamDetailDiagnostic = await buildSteamDetailEnrichmentDiagnostic({
      userId,
      gameSource: normalizedGameSource,
      externalGameId: normalizedExternalGameId,
      requestedIgdbGameId
    });

    logger.info('steam-detail-enrichment-diagnostic', {
      ...steamDetailDiagnostic,
      finalEnrichmentStatus: null,
      fallbackReason: null
    });

    logTargetSteamAppIdDebugSummary({
      userId,
      stage: 'initial_lookup',
      context: 'detail_mapping_lookup',
      externalGameId: normalizedExternalGameId,
      rawSteamTitle: steamDetailDiagnostic.rawSteamTitle,
      normalizedSteamTitle: steamDetailDiagnostic.rawSteamTitle
        ? steamIgdbMatchService.normalizeSteamTitle(steamDetailDiagnostic.rawSteamTitle).strippedComparisonTitle
        : null,
      mappingRow: steamDetailDiagnostic.mappingRowFound
        ? {
          steamAppId: normalizedExternalGameId,
          igdbGameId: steamDetailDiagnostic.igdbGameId,
          matchedTitle: steamDetailDiagnostic.matchedTitle,
          matchStatus: steamDetailDiagnostic.matchStatus,
          confidenceScore: steamDetailDiagnostic.confidenceScore
        }
        : null,
      mappingAccepted: steamDetailDiagnostic.acceptedByMatchStatus,
      cachedIgdbDetailExists: false,
      liveIgdbDetailAttempted: false,
      liveIgdbDetailFound: false,
      finalEnrichmentStatus: null,
      finalFallbackReason: null,
      steamOnlyFallbackCacheExists: false,
      steamOnlyFallbackCacheRead: false
    });

    if (isTargetDebugAppId) {
      logger.info('steam-appid-3321460-source-data', {
        userId,
        externalGameId: normalizedExternalGameId,
        libraryRowFound: steamDetailDiagnostic.libraryRowFound,
        rawSteamTitle: steamDetailDiagnostic.rawSteamTitle,
        steamSourceData: steamDetailDiagnostic.steamSourceData ?? null
      });
    }

    if (!steamDetailDiagnostic.rawSteamTitle) {
      try {
        const fallbackSourceData = await resolveSteamFallbackGameData({
          userId,
          externalGameId: normalizedExternalGameId
        });

        if (fallbackSourceData?.gameName) {
          steamDetailDiagnostic = {
            ...steamDetailDiagnostic,
            rawSteamTitle: fallbackSourceData.gameName
          };
        }
      } catch (error) {
        logger.warn('steam-detail-title-source-fallback-failed', {
          userId,
          externalGameId: normalizedExternalGameId,
          code: error?.code ?? null,
          message: error?.message ?? null
        });
      }
    }

    const cachedMapping = steamDetailDiagnostic.mappingRowFound
      ? {
        igdbGameId: steamDetailDiagnostic.igdbGameId,
        matchStatus: steamDetailDiagnostic.matchStatus,
        confidenceScore: steamDetailDiagnostic.confidenceScore,
        matchedTitle: steamDetailDiagnostic.matchedTitle
      }
      : null;

    if (isAcceptedSteamIgdbMapping(cachedMapping)) {
      const confirmedIgdbGameId = normalizeIgdbGameId(cachedMapping.igdbGameId);

      if (requestedIgdbGameId && requestedIgdbGameId !== confirmedIgdbGameId) {
        logger.warn('steam-detail-overriding-stale-requested-igdb-id', {
          userId,
          gameSource: normalizedGameSource,
          externalGameId: normalizedExternalGameId,
          requestedIgdbGameId,
          confirmedIgdbGameId,
          matchStatus: cachedMapping.matchStatus,
          confidenceScore: cachedMapping.confidenceScore ?? null,
          matchedTitle: cachedMapping.matchedTitle ?? null
        });
      }

      resolvedIgdbGameId = confirmedIgdbGameId;
    }

    if (isTargetDebugAppId && !resolvedIgdbGameId && steamDetailDiagnostic?.rawSteamTitle) {
      logger.info('steam-detail-targeted-rematch-attempt', {
        userId,
        externalGameId: normalizedExternalGameId,
        rawSteamTitle: steamDetailDiagnostic.rawSteamTitle,
        reason: 'no_accepted_cached_mapping'
      });

      try {
        const rematchResult = await steamIgdbMatchService.resolveSteamGameMappings([{
          userId,
          externalGameId: normalizedExternalGameId,
          gameName: steamDetailDiagnostic.rawSteamTitle
        }]);
        const rematchedMapping = rematchResult?.mappings?.get(normalizedExternalGameId) ?? null;

        if (isAcceptedSteamIgdbMapping(rematchedMapping)) {
          resolvedIgdbGameId = normalizeIgdbGameId(rematchedMapping.igdbGameId);
          steamDetailDiagnostic = {
            ...steamDetailDiagnostic,
            mappingRowFound: true,
            igdbGameId: rematchedMapping.igdbGameId ?? null,
            matchStatus: rematchedMapping.matchStatus ?? null,
            confidenceScore: typeof rematchedMapping.confidenceScore === 'number'
              ? Number(rematchedMapping.confidenceScore)
              : null,
            matchedTitle: rematchedMapping.matchedTitle ?? null,
            acceptedByMatchStatus: true,
            passesConfirmedThreshold: true,
            passesCandidateThreshold: true
          };
        }

        logger.info('steam-detail-targeted-rematch-result', {
          userId,
          externalGameId: normalizedExternalGameId,
          rawSteamTitle: steamDetailDiagnostic.rawSteamTitle,
          resolvedIgdbGameId: resolvedIgdbGameId ?? null,
          rematchMatchStatus: rematchedMapping?.matchStatus ?? null,
          rematchConfidenceScore: rematchedMapping?.confidenceScore ?? null,
          rematchMatchedTitle: rematchedMapping?.matchedTitle ?? null
        });

        logTargetSteamAppIdDebugSummary({
          userId,
          context: 'detail_targeted_rematch_result',
          externalGameId: normalizedExternalGameId,
          rawSteamTitle: steamDetailDiagnostic.rawSteamTitle,
          normalizedSteamTitle: steamDetailDiagnostic.rawSteamTitle
            ? steamIgdbMatchService.normalizeSteamTitle(steamDetailDiagnostic.rawSteamTitle).strippedComparisonTitle
            : null,
          mappingRow: rematchedMapping,
          mappingAccepted: isAcceptedSteamIgdbMapping(rematchedMapping),
          cachedIgdbDetailExists: resolvedIgdbGameId ? Boolean(igdbService.getCachedGameDetail(resolvedIgdbGameId)) : false,
          liveIgdbDetailAttempted: false,
          liveIgdbDetailFound: false,
          finalEnrichmentStatus: resolvedIgdbGameId ? 'enrichment_pending' : 'steam_only',
          finalFallbackReason: resolvedIgdbGameId
            ? null
            : resolveTargetSteamMappingRejectedReason({
              mappingRowExists: Boolean(rematchedMapping),
              igdbGameId: rematchedMapping?.igdbGameId ?? null,
              matchStatus: rematchedMapping?.matchStatus ?? null,
              mappingAccepted: isAcceptedSteamIgdbMapping(rematchedMapping)
            }),
          steamOnlyFallbackCacheExists: false,
          steamOnlyFallbackCacheRead: false
        });
      } catch (error) {
        logger.warn('steam-detail-targeted-rematch-failed', {
          userId,
          externalGameId: normalizedExternalGameId,
          rawSteamTitle: steamDetailDiagnostic.rawSteamTitle,
          code: error?.code,
          message: error?.message
        });
      }
    }

    if (isTargetDebugAppId && steamDetailDiagnostic?.rawSteamTitle) {
      try {
        const targetedDebugSummary = await steamIgdbMatchService.buildSteamMatchDebugSummary({
          externalGameId: normalizedExternalGameId,
          gameName: steamDetailDiagnostic.rawSteamTitle
        });

        logger.info('steam-detail-targeted-app-debug', {
          userId,
          externalGameId: normalizedExternalGameId,
          rawSteamTitle: steamDetailDiagnostic.rawSteamTitle,
          mappingRowFound: steamDetailDiagnostic.mappingRowFound,
          igdbGameId: steamDetailDiagnostic.igdbGameId,
          matchStatus: steamDetailDiagnostic.matchStatus,
          confidenceScore: steamDetailDiagnostic.confidenceScore,
          acceptedByMatchStatus: steamDetailDiagnostic.acceptedByMatchStatus,
          cachedIgdbDetailFound: resolvedIgdbGameId ? Boolean(igdbService.getCachedGameDetail(resolvedIgdbGameId)) : false,
          debugSummary: targetedDebugSummary
        });
      } catch (error) {
        logger.warn('steam-detail-targeted-app-debug-failed', {
          userId,
          externalGameId: normalizedExternalGameId,
          rawSteamTitle: steamDetailDiagnostic.rawSteamTitle,
          code: error?.code,
          message: error?.message
        });
      }
    }
  }

  if (resolvedIgdbGameId) {
    try {
      cachedIgdbDetailFound = Boolean(igdbService.getCachedGameDetail(resolvedIgdbGameId));
      igdbRateLimitedDuringDetail = igdbService.isIgdbRateLimitCooldownActive();

      if (igdbRateLimitedDuringDetail && !cachedIgdbDetailFound) {
        igdbLiveFetchSkippedReason = 'rate_limited_no_cached_detail';

        logger.warn('steam-detail-igdb-fetch-skipped', {
          userId,
          gameSource: normalizedGameSource,
          externalGameId: normalizedExternalGameId,
          requestedIgdbGameId: requestedIgdbGameId ?? null,
          resolvedIgdbGameId,
          cachedEnrichedDetailFound: false,
          liveIgdbDetailAttempted: false,
          skipReason: igdbLiveFetchSkippedReason,
          finalEnrichmentStatus: 'enrichment_rate_limited'
        });
      } else {
        igdbFetchAttempted = true;

        logger.info('steam-detail-igdb-fetch-attempt', {
          userId,
          gameSource: normalizedGameSource,
          externalGameId: normalizedExternalGameId,
          requestedIgdbGameId: requestedIgdbGameId ?? null,
          resolvedIgdbGameId,
          mappingRowFound: steamDetailDiagnostic?.mappingRowFound ?? null,
          matchStatus: steamDetailDiagnostic?.matchStatus ?? null,
          confidenceScore: steamDetailDiagnostic?.confidenceScore ?? null,
          matchedTitle: steamDetailDiagnostic?.matchedTitle ?? null,
          cachedEnrichedDetailFound,
          liveIgdbDetailAttempted: true,
          skipReason: null
        });

        const result = await igdbService.getGameDetail({
          gameId: resolvedIgdbGameId
        });
        igdbFetchSucceeded = true;
        const source = normalizedGameSource;
        const resolvedExternalId = normalizedExternalGameId ?? resolvedIgdbGameId;
        const steamFallbackData = source === 'steam' && resolvedExternalId
          ? await resolveSteamFallbackGameData({
            userId,
            externalGameId: resolvedExternalId
          })
          : null;
        const genreFallback = source === 'steam' && resolvedExternalId
          ? await resolveSteamGenreFallback({
            userId,
            externalGameId: resolvedExternalId,
            igdbGenres: result.game.genres
          })
          : resolveGenreFallback({
            igdbGenres: result.game.genres
          });
        const resolvedSteamTitle = source === 'steam'
          ? (steamFallbackData?.gameName ?? result.game.name)
          : result.game.name;
        const coverUrl = source === 'steam'
          ? buildGameImageResolverUrl({
            gameSource: 'steam',
            externalGameId: resolvedExternalId,
            igdbCoverUrl: extractUsableIgdbCoverUrl(result.game.coverUrl)
          })
          : result.game.coverUrl;

        logger.info('steam-detail-igdb-fetch-succeeded', {
          userId,
          gameSource: source,
          externalGameId: resolvedExternalId,
          requestedIgdbGameId: requestedIgdbGameId ?? null,
          resolvedIgdbGameId,
          mappingRowFound: steamDetailDiagnostic?.mappingRowFound ?? null,
          matchStatus: steamDetailDiagnostic?.matchStatus ?? null,
          confidenceScore: steamDetailDiagnostic?.confidenceScore ?? null,
          matchedTitle: steamDetailDiagnostic?.matchedTitle ?? null,
          cachedEnrichedDetailFound,
          liveIgdbDetailAttempted: result.meta?.liveFetchAttempted ?? true,
          liveIgdbDetailSkippedReason: result.meta?.liveFetchSkippedReason ?? null,
          igdbDetailFetchSucceeded: true,
          hasCover: Boolean(result.game.coverUrl),
          hasGenres: Array.isArray(result.game.genres) && result.game.genres.length > 0,
          hasSummary: typeof result.game.summary === 'string' && result.game.summary.trim().length > 0,
          hasRating: typeof result.game.rating === 'number',
          hasReleaseYear: Boolean(result.game.releaseDate),
          finalEnrichmentStatus: 'steam_plus_igdb_enriched',
          fallbackReason: null
        });

        logTargetSteamAppIdDebugSummary({
          userId,
          context: 'detail_enriched_response',
          externalGameId: resolvedExternalId,
          rawSteamTitle: resolvedSteamTitle,
          normalizedSteamTitle: steamIgdbMatchService.normalizeSteamTitle(resolvedSteamTitle).strippedComparisonTitle,
          mappingRow: steamDetailDiagnostic?.mappingRowFound
            ? {
              steamAppId: resolvedExternalId,
              igdbGameId: steamDetailDiagnostic.igdbGameId,
              matchedTitle: steamDetailDiagnostic.matchedTitle,
              matchStatus: steamDetailDiagnostic.matchStatus,
              confidenceScore: steamDetailDiagnostic.confidenceScore
            }
            : null,
          mappingAccepted: Boolean(steamDetailDiagnostic?.acceptedByMatchStatus),
          cachedIgdbDetailExists: cachedIgdbDetailFound,
          liveIgdbDetailAttempted: result.meta?.liveFetchAttempted ?? true,
          liveIgdbDetailFound: true,
          finalEnrichmentStatus: 'steam_plus_igdb_enriched',
          finalFallbackReason: null,
          steamOnlyFallbackCacheExists: false,
          steamOnlyFallbackCacheRead: false
        });

          return {
            game: {
              ...result.game,
            name: resolvedSteamTitle,
            source,
            gameSource: source,
            externalGameId: resolvedExternalId,
            gameName: resolvedSteamTitle,
            coverUrl,
              igdbGameId: resolvedIgdbGameId,
              metadataEnriched: true,
              enrichmentStatus: 'steam_plus_igdb_enriched',
              detailAvailable: true,
            playtimeMinutes: steamFallbackData?.playtimeMinutes ?? null,
            recentPlaytimeMinutes: steamFallbackData?.recentPlaytimeMinutes ?? null,
            genreDisplayName: genreFallback.genreDisplayName,
            genreSource: genreFallback.genreSource
          }
        }
      };
    } catch (error) {
      if (normalizedGameSource !== 'steam' || !normalizedExternalGameId) {
        throw error;
      }

      igdbRateLimitedDuringDetail = error?.code === 'IGDB_RATE_LIMITED' || igdbRateLimitedDuringDetail;

      if (igdbRateLimitedDuringDetail && !cachedIgdbDetailFound) {
        igdbLiveFetchSkippedReason = igdbLiveFetchSkippedReason ?? 'rate_limited_no_cached_detail';
      }

      logger.warn('Steam detail falling back after IGDB detail failure', {
        userId,
        externalGameId: normalizedExternalGameId,
        requestedIgdbGameId: requestedIgdbGameId ?? null,
        igdbGameId: resolvedIgdbGameId,
        mappingRowFound: steamDetailDiagnostic?.mappingRowFound ?? null,
        matchStatus: steamDetailDiagnostic?.matchStatus ?? null,
        confidenceScore: steamDetailDiagnostic?.confidenceScore ?? null,
        matchedTitle: steamDetailDiagnostic?.matchedTitle ?? null,
        cachedEnrichedDetailFound,
        liveIgdbDetailSkippedReason: igdbLiveFetchSkippedReason,
        igdbDetailFetchAttempted: igdbFetchAttempted,
        igdbDetailFetchSucceeded: false,
        finalEnrichmentStatus: igdbRateLimitedDuringDetail ? 'enrichment_rate_limited' : 'steam_only',
        fallbackReason: igdbRateLimitedDuringDetail
          ? 'accepted_mapping_rate_limited_without_cached_detail'
          : 'accepted_mapping_but_igdb_detail_fetch_failed',
        code: error?.code,
        message: error?.message
      });
    }
  }

  if (normalizedGameSource !== 'steam' || !normalizedExternalGameId) {
    throw new AppError(404, 'GAME_DETAIL_NOT_AVAILABLE', 'Game detail is not available');
  }

  const steamFallbackData = await resolveSteamFallbackGameData({
    userId,
    externalGameId: normalizedExternalGameId
  });
  const genreFallback = await resolveSteamGenreFallback({
    userId,
    externalGameId: normalizedExternalGameId
  });
  const coverUrl = buildGameImageResolverUrl({
    gameSource: 'steam',
    externalGameId: normalizedExternalGameId,
    igdbCoverUrl: steamFallbackData.igdbCoverUrl
  });
  const fallbackReason = resolveSteamDetailFallbackReason({
    diagnostic: steamDetailDiagnostic,
    igdbFetchAttempted,
    igdbFetchSucceeded,
    fallbackDataFound: Boolean(steamFallbackData?.gameName || steamFallbackData?.igdbCoverUrl),
    igdbRateLimited: igdbRateLimitedDuringDetail
  });
  const fallbackEnrichmentStatus = igdbRateLimitedDuringDetail
    ? 'enrichment_rate_limited'
    : resolveSteamEnrichmentStatus({
      gameSource: 'steam',
      metadataEnriched: false,
      matchStatus: steamDetailDiagnostic?.matchStatus ?? null
    });

  logger.info('steam-detail-fallback-selected', {
    userId,
    gameSource: normalizedGameSource,
    externalGameId: normalizedExternalGameId,
    requestedIgdbGameId: requestedIgdbGameId ?? null,
    libraryRowFound: steamDetailDiagnostic?.libraryRowFound ?? null,
    mappingRowFound: steamDetailDiagnostic?.mappingRowFound ?? null,
    igdbGameId: steamDetailDiagnostic?.igdbGameId ?? null,
    matchStatus: steamDetailDiagnostic?.matchStatus ?? null,
    confidenceScore: steamDetailDiagnostic?.confidenceScore ?? null,
    matchedTitle: steamDetailDiagnostic?.matchedTitle ?? null,
    acceptedByMatchStatus: steamDetailDiagnostic?.acceptedByMatchStatus ?? null,
    passesConfirmedThreshold: steamDetailDiagnostic?.passesConfirmedThreshold ?? null,
    passesCandidateThreshold: steamDetailDiagnostic?.passesCandidateThreshold ?? null,
    cachedEnrichedDetailFound,
    liveIgdbDetailSkippedReason: igdbLiveFetchSkippedReason,
    igdbDetailFetchAttempted: igdbFetchAttempted,
    igdbDetailFetchSucceeded: igdbFetchSucceeded,
    hasFallbackCover: Boolean(steamFallbackData?.igdbCoverUrl),
    genreDisplayName: genreFallback.genreDisplayName ?? null,
    finalEnrichmentStatus: fallbackEnrichmentStatus,
    fallbackReason
  });

  logTargetSteamAppIdDebugSummary({
    userId,
    context: 'detail_fallback_response',
    externalGameId: normalizedExternalGameId,
    rawSteamTitle: steamFallbackData?.gameName ?? steamDetailDiagnostic?.rawSteamTitle ?? null,
    normalizedSteamTitle: (steamFallbackData?.gameName ?? steamDetailDiagnostic?.rawSteamTitle)
      ? steamIgdbMatchService.normalizeSteamTitle(steamFallbackData?.gameName ?? steamDetailDiagnostic?.rawSteamTitle).strippedComparisonTitle
      : null,
    mappingRow: steamDetailDiagnostic?.mappingRowFound
      ? {
        steamAppId: normalizedExternalGameId,
        igdbGameId: steamDetailDiagnostic.igdbGameId,
        matchedTitle: steamDetailDiagnostic.matchedTitle,
        matchStatus: steamDetailDiagnostic.matchStatus,
        confidenceScore: steamDetailDiagnostic.confidenceScore
      }
      : null,
    mappingAccepted: Boolean(steamDetailDiagnostic?.acceptedByMatchStatus),
    cachedIgdbDetailExists: cachedIgdbDetailFound,
    liveIgdbDetailAttempted: igdbFetchAttempted,
    liveIgdbDetailFound: igdbFetchSucceeded,
    finalEnrichmentStatus: fallbackEnrichmentStatus,
    finalFallbackReason: fallbackReason,
    steamOnlyFallbackCacheExists: false,
    steamOnlyFallbackCacheRead: false
  });

  return {
    game: buildSteamFallbackDetailGame({
      externalGameId: normalizedExternalGameId,
      gameName: steamFallbackData.gameName,
      coverUrl,
      playtimeMinutes: steamFallbackData.playtimeMinutes,
      recentPlaytimeMinutes: steamFallbackData.recentPlaytimeMinutes,
      genreDisplayName: genreFallback.genreDisplayName,
      genreSource: genreFallback.genreSource,
      igdbGameId: steamDetailDiagnostic?.acceptedByMatchStatus ? steamDetailDiagnostic.igdbGameId : null,
      enrichmentStatus: fallbackEnrichmentStatus
    })
  };
}

async function syncOwnedSteamGames({ userId }) {
  const steamAccount = await getSteamSocialAccount(userId);

  if (!steamAccount) {
    logger.warn('steam-owned-sync-failed', {
      userId,
      steamConnected: false,
      steamSyncStatus: STEAM_SYNC_STATUS.NOT_CONNECTED,
      reason: 'steam_not_connected'
    });

    throw new AppError(
      404,
      'STEAM_ACCOUNT_NOT_LINKED',
      'Link a Steam account before syncing owned games',
      {
        steamSyncStatus: STEAM_SYNC_STATUS.NOT_CONNECTED
      }
    );
  }

  const steamId64 = steamService.normalizeSteamId64(steamAccount.providerSubject);

  if (!steamId64) {
    logger.warn('steam-owned-sync-failed', {
      userId,
      steamConnected: true,
      steamSyncStatus: STEAM_SYNC_STATUS.TOKEN_EXPIRED,
      reason: 'invalid_steam_provider_subject',
      providerSubject: steamAccount.providerSubject ?? null
    });

    throw new AppError(
      401,
      'STEAM_CONNECTION_EXPIRED',
      'Reconnect your Steam account before syncing owned games',
      {
        steamSyncStatus: STEAM_SYNC_STATUS.TOKEN_EXPIRED
      }
    );
  }

  markSteamSyncInProgress(userId);

  try {
    let ownedGamesResult;
    let recentGamesResult;

    try {
      [ownedGamesResult, recentGamesResult] = await Promise.all([
        fetchOwnedGamesDedup({ userId, steamId64 }),
        fetchRecentlyPlayedGamesDedup({ userId, steamId64 })
          .catch((error) => {
            logger.warn('Steam owned games sync could not load recent activity', {
              userId,
              steamId64,
              code: error?.code,
              message: error?.message
            });

            return {
              games: []
            };
          })
      ]);
    } catch (error) {
      const steamSyncStatus = resolveSteamSyncStatus({
        steamAccount,
        errorCode: error?.code ?? null
      });

      logger.warn('steam-owned-sync-failed', {
        userId,
        steamConnected: true,
        steamId64,
        steamSyncStatus,
        code: error?.code ?? 'STEAM_SYNC_FAILED',
        message: error?.message
      });

      throw new AppError(
        error?.statusCode ?? 502,
        error?.code ?? 'STEAM_SYNC_FAILED',
        error?.message ?? 'Steam sync failed',
        {
          steamSyncStatus
        }
      );
    }

    const recentGameIds = new Set(
      recentGamesResult.games
        .map((game) => game.externalGameId)
        .filter((gameId) => typeof gameId === 'string' && gameId.trim().length > 0)
    );
    const recentGameMap = new Map(
      (recentGamesResult.games ?? [])
        .filter((game) => typeof game?.externalGameId === 'string' && game.externalGameId.trim())
        .map((game) => [game.externalGameId, game])
    );
    const externalGameIds = ownedGamesResult.games.map((game) => game.externalGameId);
    const existingEntries = externalGameIds.length > 0
      ? await prisma.userGameLibrary.findMany({
        where: {
          userId,
          gameSource: GameSource.STEAM,
          externalGameId: {
            in: externalGameIds
          }
        }
      })
      : [];
    const existingEntryMap = new Map(existingEntries.map((entry) => [entry.externalGameId, entry]));
    let insertedCount = 0;
    let updatedCount = 0;

    const operations = ownedGamesResult.games.map((game) => {
      if (!game.externalGameId) {
        logger.warn('Steam owned game missing externalGameId during sync', {
          userId,
          steamId64,
          game
        });
        return null;
      }

      const existingEntry = existingEntryMap.get(game.externalGameId);
      const existingIgdbCoverUrl = extractUsableIgdbCoverUrl(existingEntry?.coverUrl);
      const statusDecision = determineOwnedGameStatus({
        existingEntry,
        recentlyPlayedGameIds: recentGameIds,
        externalGameId: game.externalGameId,
        playtimeMinutes: game.playtimeMinutes
      });
      const status = statusDecision.status;

      logger.info('library-status-classification', {
        userId,
        externalGameId: game.externalGameId,
        playtimeMinutes: Number.isInteger(game.playtimeMinutes) ? game.playtimeMinutes : null,
        derivedStatus: status,
        reason: statusDecision.reason
      });
      const recentGame = recentGameMap.get(game.externalGameId) ?? null;
      const data = {
        gameName: game.gameName,
        coverUrl: existingIgdbCoverUrl ?? null,
        playtimeMinutes: game.playtimeMinutes,
        status,
        startedAt: existingEntry?.startedAt ?? null,
        completedAt: existingEntry?.completedAt ?? null,
        lastPlayedAt: recentGame?.lastPlayedAt
          ?? existingEntry?.lastPlayedAt
          ?? null
      };

      logger.info('[Library Derived RecentPlay]', {
        appid: game.externalGameId,
        lastPlayedAt: data.lastPlayedAt ? new Date(data.lastPlayedAt).toISOString() : null,
        recentPlaytimeMinutes: recentGame?.recentPlaytimeMinutes ?? null,
        totalPlaytimeMinutes: game.playtimeMinutes ?? null,
        source: recentGame?.lastPlayedAt
          ? 'steam_recently_played_api'
          : 'existing_library_row'
      });

      if (existingEntry) {
        updatedCount += 1;

        return prisma.userGameLibrary.update({
          where: {
            id: existingEntry.id
          },
          data
        });
      }

      insertedCount += 1;

      return prisma.userGameLibrary.create({
        data: {
          userId,
          gameSource: GameSource.STEAM,
          externalGameId: game.externalGameId,
          ...data
        }
      });
    }).filter(Boolean);

    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }

    let igdbEnrichmentApplied = true;
    let igdbEnrichmentSkippedReason = null;
    let coverUpdateCount = 0;
    let confirmedMappingCount = 0;
    let candidateMappingCount = 0;
    let unmatchedCount = 0;

    if (ownedGamesResult.games.length > 0) {
      const enrichmentStartedAt = Date.now();
      const enrichmentResult = await steamIgdbMatchService.resolveSteamGameMappings(ownedGamesResult.games);
      const steamIgdbMappings = enrichmentResult.mappings;
      igdbEnrichmentApplied = enrichmentResult.igdbEnrichmentApplied;
      igdbEnrichmentSkippedReason = enrichmentResult.igdbEnrichmentSkippedReason;
      logger.info('Steam IGDB enrichment batch timing', {
        userId,
        steamId64,
        elapsedMs: Date.now() - enrichmentStartedAt,
        ownedGameCount: ownedGamesResult.games.length,
        unmatchedCountBeforeResolution: enrichmentResult?.resolutionSummary?.unmatchedCountBeforeResolution ?? null,
        unmatchedCountAfterResolution: enrichmentResult?.resolutionSummary?.unmatchedCountAfterResolution ?? null
      });

      for (const game of ownedGamesResult.games) {
        const mapping = steamIgdbMappings.get(game.externalGameId) ?? null;

        if (mapping?.matchStatus === SteamIgdbMatchStatus.CONFIRMED) {
          confirmedMappingCount += 1;
        } else if (mapping?.matchStatus === SteamIgdbMatchStatus.CANDIDATE) {
          candidateMappingCount += 1;
        } else {
          unmatchedCount += 1;
        }
      }

      if (!igdbEnrichmentApplied) {
        logger.warn('Steam owned games IGDB enrichment skipped', {
          userId,
          steamId64,
          reason: igdbEnrichmentSkippedReason ?? 'UPSTREAM_UNAVAILABLE'
        });
      } else {
        const coverUpdateOperations = ownedGamesResult.games.map((game) => {
          const mapping = steamIgdbMappings.get(game.externalGameId);
          const matchedIgdbCoverUrl = mapping?.accepted ? extractUsableIgdbCoverUrl(mapping?.igdbGame?.coverUrl) : null;
          const existingIgdbCoverUrl = extractUsableIgdbCoverUrl(existingEntryMap.get(game.externalGameId)?.coverUrl);

          if (!matchedIgdbCoverUrl || matchedIgdbCoverUrl === existingIgdbCoverUrl) {
            return null;
          }

          coverUpdateCount += 1;

          return prisma.userGameLibrary.update({
            where: {
              userId_gameSource_externalGameId: {
                userId,
                gameSource: GameSource.STEAM,
                externalGameId: game.externalGameId
              }
            },
            data: {
              coverUrl: matchedIgdbCoverUrl
            }
          });
        }).filter(Boolean);

        if (coverUpdateOperations.length > 0) {
          await prisma.$transaction(coverUpdateOperations);
        }
      }
    }

    const steamStatusEntries = await prisma.userGameLibrary.findMany({
      where: {
        userId,
        gameSource: GameSource.STEAM
      },
      select: {
        status: true
      }
    });
    const steamStatusCounts = steamStatusEntries.reduce((counts, entry) => {
      const key = entry.status;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    const steamPlayingCount = steamStatusCounts[GameLibraryStatus.PLAYING] ?? 0;
    const steamBacklogCount = steamStatusCounts[GameLibraryStatus.BACKLOG] ?? 0;
    const steamOwnedCount = steamStatusEntries.length;
    const steamSyncStatus = resolveSteamSyncStatus({
      steamAccount,
      warningCode: ownedGamesResult.syncWarningCode ?? null,
      wasSuccessful: !ownedGamesResult.syncWarningCode
    });
    const persistedRecentPlayedSnapshot = !recentGamesResult.syncWarningCode
      ? {
        syncedAt: new Date().toISOString(),
        games: (recentGamesResult.games ?? []).map((game, index) => ({
          externalGameId: game.externalGameId,
          title: game.title ?? null,
          playtimeMinutes: Number.isInteger(game.playtimeMinutes) ? game.playtimeMinutes : null,
          recentPlaytimeMinutes: Number.isInteger(game.recentPlaytimeMinutes) ? game.recentPlaytimeMinutes : null,
          lastPlayedAt: typeof game.lastPlayedAt === 'string' && game.lastPlayedAt.trim()
            ? game.lastPlayedAt.trim()
            : null,
          hasReliableLastPlayedAt: typeof game.lastPlayedAt === 'string' && game.lastPlayedAt.trim().length > 0,
          snapshotRank: index
        }))
      }
      : null;

    if (persistedRecentPlayedSnapshot) {
      for (const snapshotGame of persistedRecentPlayedSnapshot.games) {
        logger.info('[SteamSnapshot Stored]', {
          appid: snapshotGame.externalGameId,
          snapshot_last_played: snapshotGame.lastPlayedAt,
          snapshot_playtime_2weeks: snapshotGame.recentPlaytimeMinutes,
          snapshot_created_at: persistedRecentPlayedSnapshot.syncedAt
        });
      }

      await prisma.socialAccount.update({
        where: {
          id: steamAccount.id
        },
        data: {
          steamRecentPlayedSnapshot: persistedRecentPlayedSnapshot
        }
      });
      steamAccount.steamRecentPlayedSnapshot = persistedRecentPlayedSnapshot;

      logger.info('library-recent-played-source', {
        userId,
        source: 'live_sync',
        cachedCount: persistedRecentPlayedSnapshot.games.length,
        resolvedCount: persistedRecentPlayedSnapshot.games.length,
        droppedCount: 0,
        droppedExternalGameIds: [],
        syncTriggered: true
      });
    }

    const lastSteamSyncAt = steamSyncStatus === STEAM_SYNC_STATUS.SUCCESS
      ? await markSteamSyncSuccess(steamAccount)
      : (steamAccount.lastSteamSyncAt ?? null);
    invalidateSteamLibraryRuntimeCaches({ steamId64 });

    logger.info('Steam owned games sync completed', {
      userId,
      steamId64,
      steamConnected: true,
      steamSyncStatus,
      enrichmentStatus: igdbEnrichmentApplied
        ? 'applied'
        : (igdbEnrichmentSkippedReason === 'RATE_LIMITED' ? 'skipped_rate_limited' : 'skipped'),
      lastSteamSyncAt: lastSteamSyncAt ? new Date(lastSteamSyncAt).toISOString() : null,
      ownedGamesRawCount: ownedGamesResult.rawCount,
      ownedGameCount: ownedGamesResult.games.length,
      insertedCount,
      updatedCount,
      confirmedMappingCount,
      candidateMappingCount,
      unmatchedCount,
      igdbEnrichmentApplied,
      igdbEnrichmentSkippedReason,
      igdbCoverUpdateCount: coverUpdateCount,
      skippedCount: ownedGamesResult.skippedCount,
      code: ownedGamesResult.syncWarningCode
    });
    try {
      await userActivityService.recordSteamRecentlyPlayedSyncActivities({
        userId,
        games: recentGamesResult.games ?? [],
        syncedAt: lastSteamSyncAt ?? new Date()
      });
    } catch (activityError) {
      logger.warn('steam-recent-activity-record-failed', {
        userId,
        steamId64,
        code: activityError?.code ?? null,
        message: activityError?.message ?? 'Steam recent activity record failed'
      });
    }
    logger.info('Steam owned games status distribution', {
      userId,
      steamId64,
      totalSteamLibraryCount: steamOwnedCount,
      playingCount: steamPlayingCount,
      nonPlayingOwnedCount: Math.max(steamOwnedCount - steamPlayingCount, 0),
      backlogCount: steamBacklogCount,
      noneCount: 0
    });

    return {
      syncedCount: insertedCount + updatedCount,
      insertedCount,
      updatedCount,
      igdbEnrichmentApplied,
      igdbEnrichmentSkippedReason,
      steamSyncStatus,
      lastSteamSyncAt,
      syncWarningCode: ownedGamesResult.syncWarningCode ?? null
    };
  } finally {
    clearSteamSyncInProgress(userId);
  }
}

async function updateLibraryStatus({
  userId,
  source,
  externalGameId,
  title,
  coverUrl,
  status,
  startedAt,
  completedAt,
  lastPlayedAt,
  playtimeMinutes
}) {
  const gameSource = resolveGameSource(source);
  const existingEntry = await prisma.userGameLibrary.findUnique({
    where: {
      userId_gameSource_externalGameId: {
        userId,
        gameSource,
        externalGameId
      }
    }
  });

  const data = buildLibraryEntryWriteData({
    existingEntry,
    source,
    externalGameId,
    title,
    coverUrl,
    status,
    startedAt,
    completedAt,
    lastPlayedAt,
    playtimeMinutes
  });

  const libraryEntry = existingEntry
    ? await prisma.userGameLibrary.update({
      where: { id: existingEntry.id },
      data
    })
    : await prisma.userGameLibrary.create({
      data: {
        userId,
        ...data
      }
    });

  try {
    await userPresenceService.updatePresenceFromLibraryEntry({
      userId,
      libraryEntry
    });
  } catch (presenceError) {
    logger.warn('library-presence-update-failed', {
      userId,
      source,
      externalGameId,
      code: presenceError?.code ?? null,
      message: presenceError?.message ?? 'Library presence update failed'
    });
  }

  try {
    await userActivityService.recordPlayStatusChangedActivity({
      userId,
      previousEntry: existingEntry,
      libraryEntry
    });
  } catch (activityError) {
    logger.warn('library-activity-update-failed', {
      userId,
      source,
      externalGameId,
      code: activityError?.code ?? null,
      message: activityError?.message ?? 'Library activity update failed'
    });
  }

  return {
    libraryEntry: mapLibraryStatusEntry(libraryEntry)
  };
}

module.exports = {
  buildSteamDetailEnrichmentDiagnostic,
  completeSteamLink,
  getLibraryGameDetail,
  getMyLibrary,
  getMyLikedLibrary,
  getMyOwnedLibrary,
  getMyPlayingLibrary,
  getMyPlaytimeBasedRecommendations,
  getMyRecentlyPlayedLibrary,
  getMyReviewedLibrary,
  getMySteamFriendRecommendations,
  resolveSteamMappingContextForGames,
  startSteamLink,
  syncOwnedSteamGames,
  unlinkSteamAccount,
  updateLibraryStatus
};
