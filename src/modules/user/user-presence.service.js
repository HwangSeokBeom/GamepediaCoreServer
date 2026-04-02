const { GameSource, GameLibraryStatus } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const steamService = require('../../services/steam.service');
const {
  PRESENCE_LAST_PLAYED_WINDOW_MS,
  PRESENCE_ONLINE_WINDOW_MS,
  PRESENCE_PLAYING_WINDOW_MS,
  PRESENCE_RECENT_WINDOW_MS,
  USER_ACTIVITY_TYPE,
  USER_PRESENCE_STATE
} = require('./user-social.constants');

function uniqueStringValues(values) {
  return [...new Set(
    (values ?? [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  )];
}

function normalizePresenceState(state) {
  switch (state) {
  case USER_PRESENCE_STATE.ONLINE:
    return 'online';
  case USER_PRESENCE_STATE.RECENTLY_ACTIVE:
    return 'recentlyActive';
  case USER_PRESENCE_STATE.PLAYING:
    return 'playing';
  case USER_PRESENCE_STATE.LAST_PLAYED:
    return 'lastPlayed';
  default:
    return 'unknown';
  }
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

function resolvePresenceGame(entry) {
  if (!entry) {
    return null;
  }

  const gameSource = normalizeGameSource(entry.gameSource);

  if (!gameSource || !entry.externalGameId) {
    return null;
  }

  return {
    gameSource,
    externalGameId: entry.externalGameId,
    title: entry.gameName ?? null,
    coverUrl: entry.coverUrl ?? null
  };
}

function buildPresenceDto({
  state = USER_PRESENCE_STATE.UNKNOWN,
  source = null,
  updatedAt = null,
  lastActiveAt = null,
  lastPlayedAt = null,
  game = null
} = {}) {
  return {
    state: normalizePresenceState(state),
    source: typeof source === 'string' && source.trim() ? source.trim() : null,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    lastActiveAt: lastActiveAt ? new Date(lastActiveAt).toISOString() : null,
    lastPlayedAt: lastPlayedAt ? new Date(lastPlayedAt).toISOString() : null,
    game
  };
}

async function upsertPresenceSnapshot({
  userId,
  state,
  source = null,
  gameSource = null,
  externalGameId = null,
  lastActiveAt = null,
  lastPlayedAt = null
}) {
  if (typeof userId !== 'string' || !userId.trim()) {
    return null;
  }

  const snapshot = await prisma.userPresenceSnapshot.upsert({
    where: { userId },
    update: {
      state,
      source,
      gameSource,
      externalGameId,
      lastActiveAt,
      lastPlayedAt
    },
    create: {
      userId,
      state,
      source,
      gameSource,
      externalGameId,
      lastActiveAt,
      lastPlayedAt
    }
  });

  logger.info('presence-updated', {
    userId,
    state: normalizePresenceState(state),
    source: source ?? null,
    gameSource: normalizeGameSource(gameSource),
    externalGameId: externalGameId ?? null
  });

  return snapshot;
}

async function updatePresenceFromActivityEvent(activityEvent) {
  if (!activityEvent?.actorUserId) {
    return null;
  }

  const metadata = activityEvent.metadata && typeof activityEvent.metadata === 'object'
    ? activityEvent.metadata
    : {};
  const activityAt = activityEvent.createdAt ? new Date(activityEvent.createdAt) : new Date();
  const nextStatus = typeof metadata.nextStatus === 'string' ? metadata.nextStatus.trim().toUpperCase() : null;
  const activityType = activityEvent.activityType;

  if (
    activityType === USER_ACTIVITY_TYPE.PLAY_STATUS_CHANGED &&
    nextStatus === GameLibraryStatus.PLAYING
  ) {
    return upsertPresenceSnapshot({
      userId: activityEvent.actorUserId,
      state: USER_PRESENCE_STATE.PLAYING,
      source: 'library_status',
      gameSource: activityEvent.gameSource ?? null,
      externalGameId: activityEvent.externalGameId ?? null,
      lastActiveAt: activityAt,
      lastPlayedAt: activityAt
    });
  }

  if (activityType === USER_ACTIVITY_TYPE.STEAM_RECENTLY_PLAYED_SYNC) {
    return upsertPresenceSnapshot({
      userId: activityEvent.actorUserId,
      state: USER_PRESENCE_STATE.LAST_PLAYED,
      source: 'steam_recent_sync',
      gameSource: activityEvent.gameSource ?? null,
      externalGameId: activityEvent.externalGameId ?? null,
      lastActiveAt: activityAt,
      lastPlayedAt: activityAt
    });
  }

  return upsertPresenceSnapshot({
    userId: activityEvent.actorUserId,
    state: USER_PRESENCE_STATE.RECENTLY_ACTIVE,
    source: 'app_activity',
    gameSource: activityEvent.gameSource ?? null,
    externalGameId: activityEvent.externalGameId ?? null,
    lastActiveAt: activityAt,
    lastPlayedAt: metadata.lastPlayedAt ? new Date(metadata.lastPlayedAt) : null
  });
}

async function updatePresenceFromLibraryEntry({ userId, libraryEntry }) {
  if (!userId || !libraryEntry) {
    return null;
  }

  const updatedAt = libraryEntry.updatedAt ? new Date(libraryEntry.updatedAt) : new Date();
  const lastPlayedAt = libraryEntry.lastPlayedAt ? new Date(libraryEntry.lastPlayedAt) : updatedAt;

  if (String(libraryEntry.status).toUpperCase() === GameLibraryStatus.PLAYING) {
    return upsertPresenceSnapshot({
      userId,
      state: USER_PRESENCE_STATE.PLAYING,
      source: libraryEntry.gameSource === GameSource.STEAM ? 'steam_library_status' : 'library_status',
      gameSource: libraryEntry.gameSource,
      externalGameId: libraryEntry.externalGameId,
      lastActiveAt: updatedAt,
      lastPlayedAt
    });
  }

  if (libraryEntry.lastPlayedAt) {
    return upsertPresenceSnapshot({
      userId,
      state: USER_PRESENCE_STATE.LAST_PLAYED,
      source: libraryEntry.gameSource === GameSource.STEAM ? 'steam_library_sync' : 'library_status',
      gameSource: libraryEntry.gameSource,
      externalGameId: libraryEntry.externalGameId,
      lastActiveAt: updatedAt,
      lastPlayedAt
    });
  }

  return null;
}

async function updatePresenceFromSteamSync({ userId, recentGames = [], syncedAt = new Date() }) {
  const latestGame = (recentGames ?? []).find((game) => typeof game?.externalGameId === 'string' && game.externalGameId.trim());

  if (!latestGame) {
    return upsertPresenceSnapshot({
      userId,
      state: USER_PRESENCE_STATE.RECENTLY_ACTIVE,
      source: 'steam_sync',
      lastActiveAt: syncedAt
    });
  }

  return upsertPresenceSnapshot({
    userId,
    state: USER_PRESENCE_STATE.LAST_PLAYED,
    source: 'steam_recent_sync',
    gameSource: GameSource.STEAM,
    externalGameId: latestGame.externalGameId,
    lastActiveAt: syncedAt,
    lastPlayedAt: syncedAt
  });
}

function pickLatestEntry(map, entry, timestamp) {
  if (!entry || !(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    return;
  }

  const existing = map.get(entry.userId);

  if (!existing || existing.timestamp.getTime() < timestamp.getTime()) {
    map.set(entry.userId, {
      entry,
      timestamp
    });
  }
}

async function derivePresenceMap(userIds) {
  const normalizedUserIds = uniqueStringValues(userIds);

  if (normalizedUserIds.length === 0) {
    return new Map();
  }

  const [snapshots, recentActivityEvents, relevantLibraryEntries, steamAccounts] = await Promise.all([
    prisma.userPresenceSnapshot.findMany({
      where: {
        userId: {
          in: normalizedUserIds
        }
      }
    }).catch((error) => {
      logger.warn('presence-snapshot-query-degraded', {
        userCount: normalizedUserIds.length,
        code: error?.code ?? null,
        message: error?.message ?? 'Presence snapshot query failed'
      });
      return [];
    }),
    prisma.userActivityEvent.findMany({
      where: {
        actorUserId: {
          in: normalizedUserIds
        }
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        actorUserId: true,
        createdAt: true,
        activityType: true
      }
    }).catch((error) => {
      logger.warn('presence-activity-query-degraded', {
        userCount: normalizedUserIds.length,
        code: error?.code ?? null,
        message: error?.message ?? 'Presence activity query failed'
      });
      return [];
    }),
    prisma.userGameLibrary.findMany({
      where: {
        userId: {
          in: normalizedUserIds
        },
        OR: [
          {
            status: GameLibraryStatus.PLAYING
          },
          {
            lastPlayedAt: {
              not: null
            }
          }
        ]
      },
      orderBy: [{ updatedAt: 'desc' }],
      select: {
        userId: true,
        gameSource: true,
        externalGameId: true,
        gameName: true,
        coverUrl: true,
        status: true,
        lastPlayedAt: true,
        updatedAt: true
      }
    }),
    prisma.socialAccount.findMany({
      where: {
        userId: {
          in: normalizedUserIds
        },
        provider: steamService.STEAM_AUTH_PROVIDER
      },
      select: {
        userId: true,
        lastSteamSyncAt: true
      }
    })
  ]);
  const now = Date.now();
  const snapshotMap = new Map(snapshots.map((snapshot) => [snapshot.userId, snapshot]));
  const latestActivityByUser = new Map();

  for (const event of recentActivityEvents) {
    if (!latestActivityByUser.has(event.actorUserId)) {
      latestActivityByUser.set(event.actorUserId, event);
    }
  }

  const latestPlayingByUser = new Map();
  const latestPlayedByUser = new Map();

  for (const entry of relevantLibraryEntries) {
    const updatedTimestamp = entry.updatedAt ? new Date(entry.updatedAt) : null;
    const lastPlayedTimestamp = entry.lastPlayedAt ? new Date(entry.lastPlayedAt) : updatedTimestamp;

    if (String(entry.status).toUpperCase() === GameLibraryStatus.PLAYING && updatedTimestamp) {
      pickLatestEntry(latestPlayingByUser, entry, updatedTimestamp);
    }

    if (lastPlayedTimestamp) {
      pickLatestEntry(latestPlayedByUser, entry, lastPlayedTimestamp);
    }
  }

  const steamSyncMap = new Map(steamAccounts.map((account) => [account.userId, account.lastSteamSyncAt]));
  const resultMap = new Map();

  for (const userId of normalizedUserIds) {
    const snapshot = snapshotMap.get(userId) ?? null;
    const latestActivity = latestActivityByUser.get(userId) ?? null;
    const latestPlaying = latestPlayingByUser.get(userId) ?? null;
    const latestPlayed = latestPlayedByUser.get(userId) ?? null;
    const steamSyncAt = steamSyncMap.get(userId) ?? null;
    let resolvedState = USER_PRESENCE_STATE.UNKNOWN;
    let resolvedSource = snapshot?.source ?? null;
    let resolvedUpdatedAt = snapshot?.updatedAt ?? null;
    let resolvedLastActiveAt = snapshot?.lastActiveAt ?? null;
    let resolvedLastPlayedAt = snapshot?.lastPlayedAt ?? null;
    let resolvedGame = null;

    if (latestPlaying && now - latestPlaying.timestamp.getTime() <= PRESENCE_PLAYING_WINDOW_MS) {
      resolvedState = USER_PRESENCE_STATE.PLAYING;
      resolvedSource = latestPlaying.entry.gameSource === GameSource.STEAM ? 'steam_recent_sync' : 'library_status';
      resolvedUpdatedAt = latestPlaying.timestamp;
      resolvedLastActiveAt = latestPlaying.timestamp;
      resolvedLastPlayedAt = latestPlaying.entry.lastPlayedAt ?? latestPlaying.timestamp;
      resolvedGame = resolvePresenceGame(latestPlaying.entry);
    } else if (latestActivity && now - new Date(latestActivity.createdAt).getTime() <= PRESENCE_ONLINE_WINDOW_MS) {
      resolvedState = USER_PRESENCE_STATE.ONLINE;
      resolvedSource = 'app_activity';
      resolvedUpdatedAt = latestActivity.createdAt;
      resolvedLastActiveAt = latestActivity.createdAt;
    } else if (latestActivity && now - new Date(latestActivity.createdAt).getTime() <= PRESENCE_RECENT_WINDOW_MS) {
      resolvedState = USER_PRESENCE_STATE.RECENTLY_ACTIVE;
      resolvedSource = 'app_activity';
      resolvedUpdatedAt = latestActivity.createdAt;
      resolvedLastActiveAt = latestActivity.createdAt;
    } else if (latestPlayed && now - latestPlayed.timestamp.getTime() <= PRESENCE_LAST_PLAYED_WINDOW_MS) {
      resolvedState = USER_PRESENCE_STATE.LAST_PLAYED;
      resolvedSource = latestPlayed.entry.gameSource === GameSource.STEAM ? 'steam_recent_sync' : 'library_status';
      resolvedUpdatedAt = latestPlayed.timestamp;
      resolvedLastPlayedAt = latestPlayed.timestamp;
      resolvedGame = resolvePresenceGame(latestPlayed.entry);
    } else if (snapshot) {
      resolvedState = snapshot.state;
      resolvedSource = snapshot.source ?? null;
      resolvedUpdatedAt = snapshot.updatedAt;
      resolvedLastActiveAt = snapshot.lastActiveAt ?? null;
      resolvedLastPlayedAt = snapshot.lastPlayedAt ?? null;
      resolvedGame = snapshot.externalGameId
        ? {
          gameSource: normalizeGameSource(snapshot.gameSource),
          externalGameId: snapshot.externalGameId,
          title: null,
          coverUrl: null
        }
        : null;
    } else if (steamSyncAt && now - new Date(steamSyncAt).getTime() <= PRESENCE_RECENT_WINDOW_MS) {
      resolvedState = USER_PRESENCE_STATE.RECENTLY_ACTIVE;
      resolvedSource = 'steam_sync';
      resolvedUpdatedAt = steamSyncAt;
      resolvedLastActiveAt = steamSyncAt;
    }

    logger.info('presence-derived', {
      userId,
      state: normalizePresenceState(resolvedState),
      source: resolvedSource,
      snapshotState: snapshot ? normalizePresenceState(snapshot.state) : null,
      steamSyncAt: steamSyncAt ? new Date(steamSyncAt).toISOString() : null
    });

    resultMap.set(userId, buildPresenceDto({
      state: resolvedState,
      source: resolvedSource,
      updatedAt: resolvedUpdatedAt,
      lastActiveAt: resolvedLastActiveAt,
      lastPlayedAt: resolvedLastPlayedAt,
      game: resolvedGame
    }));
  }

  return resultMap;
}

async function derivePresenceForUser(userId) {
  return (await derivePresenceMap([userId])).get(userId) ?? buildPresenceDto();
}

module.exports = {
  buildPresenceDto,
  derivePresenceForUser,
  derivePresenceMap,
  normalizePresenceState,
  updatePresenceFromActivityEvent,
  updatePresenceFromLibraryEntry,
  updatePresenceFromSteamSync,
  upsertPresenceSnapshot
};
