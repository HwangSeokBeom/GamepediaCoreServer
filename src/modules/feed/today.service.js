const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const { resolveFeatureFlags } = require('../product/feature-flag.service');
const gameDnaService = require('../play/game-dna.service');
const playCompassService = require('../play/play-compass.service');
const monthlyReplayService = require('../play/monthly-replay.service');
const articleService = require('./article.service');
const { toZonedDateKey } = require('../play/play-time.util');

// Today feed.
//
// Each section is produced independently and settled independently: a section
// that throws is reported as `unavailable` with a reason code while every other
// section still renders. One failing section can never fail the whole response.
//
// Ordering is deterministic — a fixed section order, a deterministic sort inside
// each section, and an opaque cursor over the section index.

const SECTION_ORDER = Object.freeze([
  'playCompass',
  'gameDNA',
  'gameBriefing',
  'backlogRescue',
  'spoilerFreeStartGuide',
  'editorialCuration',
  'monthlyReplay',
  'friendActivity'
]);

/// Which kill switch, if any, gates each section.
const SECTION_FEATURE_FLAG = Object.freeze({
  playCompass: 'playCompass',
  gameDNA: 'gameDNA',
  gameBriefing: null,
  backlogRescue: null,
  spoilerFreeStartGuide: null,
  editorialCuration: 'magazine',
  monthlyReplay: 'monthlyReplay',
  friendActivity: null
});

const FRIEND_ACTIVITY_LIMIT = 10;
const BRIEFING_LIMIT = 5;
const BACKLOG_RESCUE_LIMIT = 3;
const START_GUIDE_LIMIT = 3;

function encodeCursor(index) {
  return Buffer.from(JSON.stringify({ v: 1, s: index }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

    if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.s) || parsed.s < 0) {
      throw new Error('malformed cursor');
    }

    return Math.min(parsed.s, SECTION_ORDER.length);
  } catch (error) {
    throw new AppError(400, 'INVALID_CURSOR', 'The supplied today cursor could not be decoded');
  }
}

async function buildPlayCompassSection({ userId, now }) {
  const result = await playCompassService.recommend({
    userId,
    request: {
      // Neutral defaults: the section is a preview, the full request comes from
      // POST /users/me/play-compass.
      availableMinutes: 60,
      mood: null,
      energy: 'MEDIUM',
      soloOrParty: 'EITHER',
      continueOrStart: 'EITHER',
      availablePlatforms: [],
      friendUserIds: []
    },
    now
  });

  return {
    recommendations: result.recommendations,
    confidence: result.confidence,
    dataFreshness: result.dataFreshness,
    emptyReason: result.emptyReason,
    ownedOnly: true
  };
}

async function buildGameDnaSection({ userId, now }) {
  const dna = await gameDnaService.getGameDna({ userId, now });

  return {
    signalCount: dna.signalCount,
    confidence: dna.confidence,
    generatedAt: dna.generatedAt,
    topGenres: dna.genreProfile.topGenres,
    sessionLengthLabel: dna.sessionLengthProfile.label,
    socialLabel: dna.socialProfile.label,
    toneLabel: dna.toneProfile.label,
    missingSignals: dna.missingSignals,
    reasonCodes: dna.reasonCodes
  };
}

/// "My game briefing": followed and in-progress games whose regional service
/// state changed recently, plus articles linked to them.
async function buildGameBriefingSection({ userId, now }) {
  const [follows, playing] = await Promise.all([
    prisma.gameFollow.findMany({
      where: { userId },
      select: { catalogGameId: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50
    }),
    prisma.userGameLibrary.findMany({
      where: { userId, status: 'PLAYING', catalogGameId: { not: null } },
      select: { catalogGameId: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: 50
    })
  ]);

  const catalogGameIds = [...new Set([
    ...follows.map((follow) => follow.catalogGameId),
    ...playing.map((entry) => entry.catalogGameId)
  ])];

  if (catalogGameIds.length === 0) {
    return { items: [], emptyReason: 'no_followed_or_playing_games' };
  }

  const games = await prisma.catalogGame.findMany({
    where: { id: { in: catalogGameIds }, mergedIntoCatalogGameId: null },
    select: {
      id: true,
      originalTitle: true,
      updatedAt: true,
      regionalReleases: {
        select: { countryCode: true, platform: true, serviceStatus: true, shutdownDate: true, provenance: true },
        orderBy: [{ countryCode: 'asc' }, { platform: 'asc' }]
      }
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: BRIEFING_LIMIT
  });

  return {
    items: games.map((game) => ({
      catalogGameId: game.id,
      title: game.originalTitle,
      updatedAt: game.updatedAt.toISOString(),
      // A sunset or shutdown is the thing a player most needs to know about.
      noteworthyReleases: game.regionalReleases
        .filter((release) => ['SUNSET_ANNOUNCED', 'SHUTDOWN', 'MAINTENANCE', 'PRE_REGISTRATION'].includes(release.serviceStatus))
        .map((release) => ({
          countryCode: release.countryCode,
          platform: release.platform,
          serviceStatus: release.serviceStatus,
          shutdownDate: release.shutdownDate ? release.shutdownDate.toISOString().slice(0, 10) : null,
          provenance: release.provenance
        }))
    })),
    emptyReason: games.length === 0 ? 'no_catalog_metadata_available' : null,
    generatedAt: now.toISOString()
  };
}

/// "Backlog rescue": owned BACKLOG entries never recorded in the Playlog,
/// oldest first.
async function buildBacklogRescueSection({ userId }) {
  const entries = await prisma.userGameLibrary.findMany({
    where: { userId, status: 'BACKLOG', catalogGameId: { not: null } },
    select: { catalogGameId: true, createdAt: true, gameName: true, gameSource: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 50
  });

  if (entries.length === 0) {
    return { items: [], emptyReason: 'no_backlog_entries' };
  }

  const catalogGameIds = entries.map((entry) => entry.catalogGameId);
  const playedSessions = await prisma.playSession.findMany({
    where: { userId, catalogGameId: { in: catalogGameIds } },
    select: { catalogGameId: true },
    distinct: ['catalogGameId']
  });
  const played = new Set(playedSessions.map((session) => session.catalogGameId));
  const items = entries
    .filter((entry) => !played.has(entry.catalogGameId))
    .slice(0, BACKLOG_RESCUE_LIMIT)
    .map((entry) => ({
      catalogGameId: entry.catalogGameId,
      title: entry.gameName,
      addedAt: entry.createdAt.toISOString(),
      reasonCode: 'backlog_never_logged',
      ownershipProvenance: entry.gameSource === 'STEAM' ? 'PROVIDER_VERIFIED' : 'USER_CONFIRMED'
    }));

  return {
    items,
    emptyReason: items.length === 0 ? 'every_backlog_entry_already_logged' : null
  };
}

/// "Spoiler-free start guide": structured, non-narrative pointers only. No
/// article body and no review content is included, so nothing can spoil a game.
async function buildStartGuideSection({ userId }) {
  const entries = await prisma.userGameLibrary.findMany({
    where: { userId, status: { in: ['BACKLOG', 'PLAYING'] }, catalogGameId: { not: null } },
    select: { catalogGameId: true, status: true, gameName: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: 30
  });

  if (entries.length === 0) {
    return { items: [], emptyReason: 'no_startable_games' };
  }

  const games = await prisma.catalogGame.findMany({
    where: { id: { in: entries.map((entry) => entry.catalogGameId) }, mergedIntoCatalogGameId: null },
    select: {
      id: true,
      originalTitle: true,
      genres: true,
      platforms: true,
      typicalSessionMinutes: true,
      supportsSinglePlayer: true,
      supportsMultiplayer: true
    }
  });
  const gameById = new Map(games.map((game) => [game.id, game]));

  const items = entries
    .slice(0, START_GUIDE_LIMIT)
    .map((entry) => {
      const game = gameById.get(entry.catalogGameId);

      return {
        catalogGameId: entry.catalogGameId,
        title: game?.originalTitle ?? entry.gameName,
        libraryStatus: entry.status,
        // Metadata only: genre, platform, expected session length, solo/party.
        genres: [...(game?.genres ?? [])],
        platforms: [...(game?.platforms ?? [])],
        estimatedFirstSessionMinutes: game?.typicalSessionMinutes ?? null,
        soloFriendly: game?.supportsSinglePlayer ?? null,
        partyFriendly: game?.supportsMultiplayer ?? null,
        spoilerFree: true
      };
    });

  return { items, emptyReason: items.length === 0 ? 'no_catalog_metadata_available' : null };
}

async function buildEditorialSection({ locale, now }) {
  const articles = await articleService.listPublishedArticles({ locale, limit: 5, now });

  return {
    articles,
    emptyReason: articles.length === 0 ? 'no_published_articles' : null
  };
}

async function buildMonthlyReplaySection({ userId, timezone, now }) {
  const monthKey = toZonedDateKey(now, timezone).slice(0, 7);
  const replay = await monthlyReplayService.getMonthlyReplay({ userId, month: monthKey, timezone, now });

  return {
    monthKey: replay.monthKey,
    timezone,
    isEmpty: replay.isEmpty,
    playedDayCount: replay.totals.playedDayCount,
    totalMinutes: replay.totals.totalMinutes,
    mostPlayedGame: replay.mostPlayedGame,
    surpriseGame: replay.surpriseGame,
    missingData: replay.missingData
  };
}

/// Existing friend activity, surfaced unchanged: visibility still depends on the
/// accepted friendship plus the friend's own privacy settings.
async function buildFriendActivitySection({ userId }) {
  const friendships = await prisma.friendship.findMany({
    where: { userId },
    select: { friendUserId: true },
    take: 200
  });
  const friendIds = friendships.map((friendship) => friendship.friendUserId);

  if (friendIds.length === 0) {
    return { items: [], emptyReason: 'no_friends' };
  }

  const visibleFriends = await prisma.userPrivacySettings.findMany({
    where: { userId: { in: friendIds }, showRecentlyPlayed: true },
    select: { userId: true }
  });
  const visibleFriendIds = new Set(visibleFriends.map((settings) => settings.userId));
  // A friend with no explicit settings row keeps the shipped default (visible).
  const settingsPresent = new Set(visibleFriends.map((settings) => settings.userId));
  const eligibleIds = friendIds.filter((friendId) => visibleFriendIds.has(friendId) || !settingsPresent.has(friendId));

  if (eligibleIds.length === 0) {
    return { items: [], emptyReason: 'friend_activity_hidden_by_privacy' };
  }

  const events = await prisma.userActivityEvent.findMany({
    where: { actorUserId: { in: eligibleIds }, isVisible: true },
    select: {
      id: true,
      actorUserId: true,
      activityType: true,
      catalogGameId: true,
      igdbGameId: true,
      externalGameId: true,
      gameSource: true,
      createdAt: true
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: FRIEND_ACTIVITY_LIMIT
  });

  return {
    items: events.map((event) => ({
      activityId: event.id,
      actorUserId: event.actorUserId,
      activityType: event.activityType,
      catalogGameId: event.catalogGameId,
      // Legacy identity is preserved alongside the canonical id.
      legacyIdentity: {
        gameSource: event.gameSource,
        externalGameId: event.externalGameId,
        igdbGameId: event.igdbGameId
      },
      createdAt: event.createdAt.toISOString()
    })),
    emptyReason: events.length === 0 ? 'no_recent_friend_activity' : null
  };
}

const SECTION_BUILDERS = Object.freeze({
  playCompass: buildPlayCompassSection,
  gameDNA: buildGameDnaSection,
  gameBriefing: buildGameBriefingSection,
  backlogRescue: buildBacklogRescueSection,
  spoilerFreeStartGuide: buildStartGuideSection,
  editorialCuration: buildEditorialSection,
  monthlyReplay: buildMonthlyReplaySection,
  friendActivity: buildFriendActivitySection
});

async function getTodayFeed({ userId, locale = null, timezone = 'UTC', limit = SECTION_ORDER.length, cursor = null, now = new Date() }) {
  const startIndex = decodeCursor(cursor);
  const requestedKeys = SECTION_ORDER.slice(startIndex, startIndex + limit);
  const { flags } = await resolveFeatureFlags();

  const settled = await Promise.allSettled(requestedKeys.map(async (sectionKey) => {
    const flagKey = SECTION_FEATURE_FLAG[sectionKey];

    if (flagKey && flags[flagKey] !== true) {
      return { sectionKey, status: 'disabled', reasonCode: `feature_disabled:${flagKey}`, data: null };
    }

    const data = await SECTION_BUILDERS[sectionKey]({ userId, locale, timezone, now });

    return { sectionKey, status: 'ok', reasonCode: null, data };
  }));

  const sections = settled.map((outcome, index) => {
    const sectionKey = requestedKeys[index];

    if (outcome.status === 'fulfilled') {
      const { sectionKey: _ignored, ...value } = outcome.value;

      return { key: sectionKey, ...value };
    }

    // One section failing degrades only that section.
    logger.warn('today-feed-section-failed', {
      sectionKey,
      errorCategory: outcome.reason?.code ?? outcome.reason?.name ?? 'unknown'
    });

    return {
      key: sectionKey,
      status: 'unavailable',
      reasonCode: 'section_build_failed',
      data: null
    };
  });

  const nextIndex = startIndex + requestedKeys.length;

  logger.info('today-feed-served', {
    sectionCount: sections.length,
    okCount: sections.filter((section) => section.status === 'ok').length,
    disabledCount: sections.filter((section) => section.status === 'disabled').length,
    unavailableCount: sections.filter((section) => section.status === 'unavailable').length
  });

  return {
    generatedAt: now.toISOString(),
    timezone,
    locale,
    sections,
    meta: {
      sectionOrder: [...SECTION_ORDER],
      limit,
      nextCursor: nextIndex < SECTION_ORDER.length ? encodeCursor(nextIndex) : null,
      partialFailure: sections.some((section) => section.status === 'unavailable')
    }
  };
}

module.exports = {
  SECTION_FEATURE_FLAG,
  SECTION_ORDER,
  decodeCursor,
  encodeCursor,
  getTodayFeed
};
