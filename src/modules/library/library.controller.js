const steamService = require('../../services/steam.service');
const { logger } = require('../../utils/logger');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const libraryService = require('./library.service');
const libraryImageService = require('./library-image.service');
const { runWithLibraryRequestContext } = require('./library-request-context');
const {
  buildSteamLinkFailureRedirectUrl,
  buildSteamLinkSuccessRedirectUrl
} = require('./library.redirect');

function getArrayCount(result, keys) {
  for (const key of keys) {
    if (Array.isArray(result?.[key])) {
      return result[key].length;
    }
  }

  return 0;
}

function logLibraryFullList({
  userId,
  section,
  result,
  elapsedMs
}) {
  logger.info('library-full-response', {
    userId,
    section,
    page: result?.meta?.page ?? null,
    limit: result?.meta?.limit ?? null,
    count: result?.meta?.totalCount ?? getArrayCount(result, [section]),
    resultCount: getArrayCount(result, [section]),
    sort: result?.meta?.sort ?? null,
    selectedTab: result?.summary?.selectedTab ?? null,
    summarySource: result?.summary?.source ?? null,
    reviewCount: result?.summary?.reviewCount ?? 0,
    averageRating: result?.summary?.averageRating ?? null,
    gameCount: result?.summary?.gameCount ?? 0,
    totalPlaytimeHours: result?.summary?.totalPlaytimeHours ?? 0,
    steamConnected: typeof result?.steamConnected === 'boolean' ? result.steamConnected : null,
    summaryDatasetBasis: result?.responseMeta?.summaryDatasetBasis ?? null,
    isPartialFailure: result?.responseMeta?.isPartialFailure ?? false,
    syncTriggered: false,
    elapsedMs
  });
}

function logLibrarySummaryResponse({
  eventName,
  userId,
  result,
  elapsedMs,
  syncTriggered = false,
  section = null
}) {
  logger.info(eventName, {
    userId,
    section,
    selectedTab: result?.summary?.selectedTab ?? null,
    summarySource: result?.summary?.source ?? null,
    reviewCount: result?.summary?.reviewCount ?? 0,
    averageRating: result?.summary?.averageRating ?? null,
    gameCount: result?.summary?.gameCount ?? 0,
    totalPlaytimeHours: result?.summary?.totalPlaytimeHours ?? 0,
    steamConnected: typeof result?.steamConnected === 'boolean' ? result.steamConnected : null,
    steamSyncStatus: result?.steamSyncStatus ?? null,
    recentlyPlayedSource: result?.steam?.recentlyPlayedSource ?? null,
    friendRecommendationPreviewDeferred: result?.steam?.friendRecommendationPreviewDeferred ?? null,
    summaryDatasetBasis: result?.responseMeta?.summaryDatasetBasis ?? null,
    generatedAt: result?.responseMeta?.generatedAt ?? null,
    isPartialFailure: result?.responseMeta?.isPartialFailure ?? false,
    syncTriggered,
    elapsedMs
  });
}

const getMyLibrary = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await runWithLibraryRequestContext(() => libraryService.getMyLibrary({
    userId: req.auth.userId,
    selectedTab: req.query.selectedTab
  }));
  logLibrarySummaryResponse({
    eventName: 'library-preview-response',
    userId: req.auth.userId,
    result,
    elapsedMs: Date.now() - startedAt,
    syncTriggered: false,
    section: 'preview'
  });
  logger.info('library-controller-response-preview', {
    userId: req.auth.userId,
    selectedTab: result?.summary?.selectedTab ?? req.query.selectedTab ?? null,
    gameCount: result?.summary?.gameCount ?? result?.gameCount ?? 0,
    totalPlaytimeHours: result?.summary?.totalPlaytimeHours ?? result?.totalPlaytimeHours ?? 0,
    summaryDatasetBasis: result?.responseMeta?.summaryDatasetBasis ?? null,
    responseSummaryPreview: JSON.stringify({
      selectedTab: result?.summary?.selectedTab ?? null,
      source: result?.summary?.source ?? result?.summarySource ?? null,
      gameCount: result?.summary?.gameCount ?? result?.gameCount ?? 0,
      totalPlaytimeHours: result?.summary?.totalPlaytimeHours ?? result?.totalPlaytimeHours ?? 0,
      totalPlaytimeMinutes: result?.summary?.totalPlaytimeMinutes ?? result?.totalPlaytimeMinutes ?? 0
    })
  });

  res.status(200).json(successResponse(result));
});

const getMyOwnedLibrary = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await runWithLibraryRequestContext(() => libraryService.getMyOwnedLibrary({
    userId: req.auth.userId,
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort
  }));

  logLibraryFullList({
    userId: req.auth.userId,
    section: 'owned',
    result,
    elapsedMs: Date.now() - startedAt
  });

  res.status(200).json(successResponse(result));
});

const getMyPlayingLibrary = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await runWithLibraryRequestContext(() => libraryService.getMyPlayingLibrary({
    userId: req.auth.userId,
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort
  }));

  logLibraryFullList({
    userId: req.auth.userId,
    section: 'playing',
    result,
    elapsedMs: Date.now() - startedAt
  });
  logger.info('library-controller-response-playing', {
    userId: req.auth.userId,
    selectedTab: result?.summary?.selectedTab ?? 'playing',
    gameCount: result?.summary?.gameCount ?? result?.gameCount ?? 0,
    totalPlaytimeHours: result?.summary?.totalPlaytimeHours ?? result?.totalPlaytimeHours ?? 0,
    summaryDatasetBasis: result?.responseMeta?.summaryDatasetBasis ?? null,
    responseSummaryPreview: JSON.stringify({
      selectedTab: result?.summary?.selectedTab ?? null,
      source: result?.summary?.source ?? result?.summarySource ?? null,
      gameCount: result?.summary?.gameCount ?? result?.gameCount ?? 0,
      totalPlaytimeHours: result?.summary?.totalPlaytimeHours ?? result?.totalPlaytimeHours ?? 0,
      totalPlaytimeMinutes: result?.summary?.totalPlaytimeMinutes ?? result?.totalPlaytimeMinutes ?? 0
    })
  });

  res.status(200).json(successResponse(result));
});

const getMyRecentlyPlayedLibrary = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await runWithLibraryRequestContext(() => libraryService.getMyRecentlyPlayedLibrary({
    userId: req.auth.userId,
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort
  }));

  logLibraryFullList({
    userId: req.auth.userId,
    section: 'recentlyPlayed',
    result,
    elapsedMs: Date.now() - startedAt
  });

  res.status(200).json(successResponse(result));
});

const getMyLikedLibrary = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await runWithLibraryRequestContext(() => libraryService.getMyLikedLibrary({
    userId: req.auth.userId,
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort
  }));

  logLibraryFullList({
    userId: req.auth.userId,
    section: 'liked',
    result,
    elapsedMs: Date.now() - startedAt
  });

  res.status(200).json(successResponse(result));
});

const getMyReviewedLibrary = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await runWithLibraryRequestContext(() => libraryService.getMyReviewedLibrary({
    userId: req.auth.userId,
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort
  }));

  logLibraryFullList({
    userId: req.auth.userId,
    section: 'reviews',
    result,
    elapsedMs: Date.now() - startedAt
  });

  res.status(200).json(successResponse(result));
});

const getMySteamFriendRecommendations = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await runWithLibraryRequestContext(() => libraryService.getMySteamFriendRecommendations({
    userId: req.auth.userId,
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort
  }));

  logLibraryFullList({
    userId: req.auth.userId,
    section: 'friendRecommendations',
    result,
    elapsedMs: Date.now() - startedAt
  });
  logger.info('friend-recommendation-response', {
    userId: req.auth.userId,
    appFriendCount: result?.metadata?.appFriendCount ?? 0,
    steamFriendCount: result?.metadata?.steamFriendCount ?? 0,
    finalRecommendationSource: result?.source ?? 'none',
    emptyReason: result?.emptyReason ?? null,
    recommendationCount: getArrayCount(result, ['friendRecommendations', 'recommendations', 'items'])
  });

  res.status(200).json(successResponse(result));
});

const getMyPlaytimeBasedRecommendations = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await runWithLibraryRequestContext(() => libraryService.getMyPlaytimeBasedRecommendations({
    userId: req.auth.userId,
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort
  }));

  logLibraryFullList({
    userId: req.auth.userId,
    section: 'playtimeRecommendations',
    result,
    elapsedMs: Date.now() - startedAt
  });

  res.status(200).json(successResponse(result));
});

const resolveGameImage = asyncHandler(async (req, res) => {
  await runWithLibraryRequestContext(() => libraryImageService.sendResolvedGameImage({
    res,
    gameSource: req.query.gameSource,
    externalGameId: req.query.externalGameId,
    igdbCoverUrl: req.query.igdbCoverUrl
  }));
});

const startSteamLink = asyncHandler(async (req, res) => {
  const result = await libraryService.startSteamLink({
    userId: req.auth.userId,
    redirectUri: req.body.redirectUri
  });

  res.status(200).json(successResponse(result));
});

const completeSteamLink = async (req, res) => {
  let callbackContext = null;

  logger.info('Steam link callback received', {
    hasState: typeof req.query.state === 'string' && req.query.state.trim().length > 0,
    hasClaimedId: typeof req.query['openid.claimed_id'] === 'string',
    hasIdentity: typeof req.query['openid.identity'] === 'string'
  });

  try {
    callbackContext = steamService.parseSteamLinkState(req.query.state);
  } catch (error) {
    callbackContext = null;
  }

  try {
    const result = await libraryService.completeSteamLink({
      query: req.query,
      callbackContext
    });
    const redirectUrl = buildSteamLinkSuccessRedirectUrl(result.redirectUri);

    logger.info('Steam link callback redirecting', {
      outcome: 'success',
      redirectTargetType: 'mobile-app'
    });

    res.redirect(302, redirectUrl);
  } catch (error) {
    const redirectUrl = buildSteamLinkFailureRedirectUrl(callbackContext?.redirectUri, error);

    logger.warn('Steam link callback redirecting', {
      outcome: 'failure',
      redirectTargetType: 'mobile-app',
      code: error?.code ?? 'STEAM_LINK_FAILED'
    });

    res.redirect(302, redirectUrl);
  }
};

const unlinkSteamAccount = asyncHandler(async (req, res) => {
  const result = await libraryService.unlinkSteamAccount({
    userId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const syncOwnedSteamGames = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const result = await runWithLibraryRequestContext(() => libraryService.syncOwnedSteamGames({
    userId: req.auth.userId
  }));

  logger.info('library-sync-response', {
    userId: req.auth.userId,
    selectedTab: null,
    summarySource: null,
    reviewCount: 0,
    averageRating: null,
    gameCount: result?.syncedCount ?? 0,
    totalPlaytimeHours: 0,
    steamConnected: true,
    syncTriggered: true,
    steamSyncStatus: result?.steamSyncStatus ?? null,
    enrichmentStatus: result?.igdbEnrichmentApplied
      ? 'applied'
      : (result?.igdbEnrichmentSkippedReason === 'RATE_LIMITED' ? 'skipped_rate_limited' : 'skipped'),
    elapsedMs: Date.now() - startedAt
  });

  res.status(200).json(successResponse(result));
});

const updateLibraryStatus = asyncHandler(async (req, res) => {
  const result = await libraryService.updateLibraryStatus({
    userId: req.auth.userId,
    ...req.body
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  completeSteamLink,
  getMyLibrary,
  getMyLikedLibrary,
  getMyOwnedLibrary,
  getMyPlayingLibrary,
  getMyPlaytimeBasedRecommendations,
  getMyRecentlyPlayedLibrary,
  getMyReviewedLibrary,
  getMySteamFriendRecommendations,
  resolveGameImage,
  startSteamLink,
  syncOwnedSteamGames,
  unlinkSteamAccount,
  updateLibraryStatus
};
