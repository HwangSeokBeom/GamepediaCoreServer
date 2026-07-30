const crypto = require('node:crypto');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const {
  GENRE_BUCKETS,
  PLAY_COMPASS_MAX_RESULTS
} = require('./play.constants');

// Play Compass is a deterministic ranker. No model is consulted, so the same
// request over the same data always produces the same three picks with the same
// reason codes.
//
// Hard rules:
//   * candidates are library entries the account actually owns, restricted to
//     PLAYING and BACKLOG. A default request never proposes an unowned game.
//   * at most three results.
//   * every explanation is an allowlisted reason code, never free text.
//   * ownership evidence and its provenance travel with each pick.

const SNOOZE_WINDOW_DAYS = 7;
const RECENT_PLAY_WINDOW_DAYS = 14;
const CANDIDATE_SCAN_LIMIT = 300;

function daysBetween(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
}

function bucketScore(bucket, values) {
  const lowered = values.map((value) => String(value).toLowerCase());

  return lowered.filter((value) => bucket.some((token) => value === token || value.includes(token))).length;
}

/// Best available estimate of a typical session for one candidate, in minutes.
/// Falls back to genre shape and then to a neutral default.
function estimateSessionMinutes({ game, playSessions }) {
  const durations = playSessions
    .map((session) => session.durationMinutes)
    .filter((value) => Number.isInteger(value) && value > 0);

  if (durations.length > 0) {
    return {
      minutes: [...durations].sort((left, right) => left - right)[Math.floor(durations.length / 2)],
      basis: 'playlog_median'
    };
  }

  if (Number.isInteger(game?.typicalSessionMinutes) && game.typicalSessionMinutes > 0) {
    return { minutes: game.typicalSessionMinutes, basis: 'catalog_typical_session' };
  }

  const values = [...(game?.genres ?? []), ...(game?.steamTags ?? [])];
  const shortAffinity = bucketScore(GENRE_BUCKETS.shortSession, values);
  const longAffinity = bucketScore(GENRE_BUCKETS.longSession, values);

  if (shortAffinity > longAffinity) {
    return { minutes: 30, basis: 'genre_short_session' };
  }

  if (longAffinity > shortAffinity) {
    return { minutes: 120, basis: 'genre_long_session' };
  }

  return { minutes: 60, basis: 'default_estimate' };
}

function buildOwnershipEvidence(entry) {
  return {
    source: entry.gameSource,
    externalGameId: entry.externalGameId,
    libraryStatus: entry.status,
    // The stored provenance is the only answer. gameSource is a label a client can
    // set on a manual write, so inferring PROVIDER_VERIFIED from gameSource ===
    // 'STEAM' would let a user's own claim present itself as a provider fact.
    provenance: entry.ownershipProvenance ?? 'UNKNOWN',
    ownershipVerified: entry.ownershipProvenance === 'PROVIDER_VERIFIED',
    playtimeMinutes: entry.playtimeMinutes ?? null,
    lastPlayedAt: entry.lastPlayedAt ? entry.lastPlayedAt.toISOString() : null,
    // The library records ownership, not installation. Install state is not
    // tracked by this backend, so it is reported as unknown rather than guessed.
    installEvidence: {
      known: false,
      reason: 'install_state_not_tracked'
    }
  };
}

/// Pure scoring for one candidate. Returns null when a hard constraint fails.
function scoreCandidate({ entry, game, playSessions, compassEvents, request, now }) {
  const reasonCodes = new Set();
  const components = {};

  const platforms = new Set([
    ...(game?.platforms ?? []).map((platform) => String(platform).toUpperCase()),
    entry.gameSource === 'STEAM' ? 'STEAM' : null
  ].filter(Boolean));

  if (request.availablePlatforms.length > 0) {
    const requested = request.availablePlatforms.map((platform) => String(platform).toUpperCase());
    const platformMatch = requested.some((platform) => platforms.has(platform));

    // Hard filter: a game the account cannot start right now is not a pick.
    if (!platformMatch) {
      return null;
    }

    reasonCodes.add('platform_available');
    components.platform = 1;
  } else {
    components.platform = 0;
  }

  if (entry.gameSource === 'STEAM') {
    reasonCodes.add('owned_on_steam');
  }

  const estimate = estimateSessionMinutes({ game, playSessions });

  if (estimate.minutes <= request.availableMinutes) {
    reasonCodes.add(estimate.minutes <= request.availableMinutes * 0.6
      ? 'shorter_than_available_time'
      : 'fits_available_time');
    components.timeFit = Number((1 - Math.abs(request.availableMinutes - estimate.minutes) / Math.max(request.availableMinutes, 1)).toFixed(4));
  } else {
    // Over budget: allowed but heavily penalised rather than filtered out, so a
    // short window still returns something when nothing fits perfectly.
    components.timeFit = Number((-Math.min((estimate.minutes - request.availableMinutes) / Math.max(request.availableMinutes, 1), 1)).toFixed(4));
  }

  const inProgress = entry.status === 'PLAYING';

  if (request.continueOrStart === 'CONTINUE') {
    if (!inProgress) {
      return null;
    }

    reasonCodes.add('already_in_progress');
    components.continuity = 1;
  } else if (request.continueOrStart === 'START') {
    if (inProgress) {
      return null;
    }

    reasonCodes.add('fresh_start_available');
    components.continuity = 1;
  } else {
    reasonCodes.add(inProgress ? 'already_in_progress' : 'fresh_start_available');
    components.continuity = inProgress ? 0.6 : 0.4;
  }

  const values = [...(game?.genres ?? []), ...(game?.steamTags ?? [])];
  const multiplayerAffinity = bucketScore(GENRE_BUCKETS.multiplayer, values) + (game?.supportsMultiplayer === true ? 1 : 0);
  const singleplayerAffinity = bucketScore(GENRE_BUCKETS.singleplayer, values) + (game?.supportsSinglePlayer === true ? 1 : 0);

  if (request.soloOrParty === 'PARTY') {
    if (multiplayerAffinity === 0) {
      return null;
    }

    reasonCodes.add('party_friendly');
    components.social = 1;
  } else if (request.soloOrParty === 'SOLO') {
    if (singleplayerAffinity === 0 && multiplayerAffinity > 0) {
      return null;
    }

    reasonCodes.add('solo_friendly');
    components.social = singleplayerAffinity > 0 ? 1 : 0.5;
  } else {
    components.social = 0.5;
  }

  const comfortAffinity = bucketScore(GENRE_BUCKETS.comfort, values);
  const challengeAffinity = bucketScore(GENRE_BUCKETS.challenge, values);
  const lowEnergy = request.energy === 'LOW';
  const highEnergy = request.energy === 'HIGH';

  if (lowEnergy && comfortAffinity > 0) {
    reasonCodes.add('low_energy_friendly');
    reasonCodes.add('comfort_pick');
    components.energy = 1;
  } else if (highEnergy && challengeAffinity > 0) {
    reasonCodes.add('high_energy_friendly');
    reasonCodes.add('challenge_pick');
    components.energy = 1;
  } else if (lowEnergy && challengeAffinity > comfortAffinity) {
    components.energy = -0.5;
  } else {
    components.energy = 0.2;
  }

  if (request.mood === 'RELAXED' && comfortAffinity > 0) {
    reasonCodes.add('comfort_pick');
    components.mood = 0.6;
  } else if ((request.mood === 'EXCITED' || request.mood === 'FOCUSED') && challengeAffinity > 0) {
    reasonCodes.add('challenge_pick');
    components.mood = 0.6;
  } else {
    components.mood = 0;
  }

  const lastPlayedAt = [
    entry.lastPlayedAt,
    ...playSessions.map((session) => session.playedAt)
  ].filter(Boolean).sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

  if (lastPlayedAt && daysBetween(now, lastPlayedAt) <= RECENT_PLAY_WINDOW_DAYS) {
    reasonCodes.add('recently_played');
    components.recency = 0.4;
  } else if (lastPlayedAt) {
    reasonCodes.add('not_played_recently');
    components.recency = 0.1;
  } else {
    reasonCodes.add('backlog_oldest_untouched');
    components.recency = 0.2;
  }

  const snoozed = compassEvents.some((event) => event.action === 'SNOOZED'
    && daysBetween(now, event.occurredAt) <= SNOOZE_WINDOW_DAYS);
  const excluded = compassEvents.some((event) => event.action === 'EXCLUDED');

  // An explicit exclusion is respected permanently; a snooze only decays a pick.
  if (excluded) {
    return null;
  }

  if (snoozed) {
    reasonCodes.add('snoozed_recently_deprioritized');
    components.snooze = -0.8;
  } else {
    components.snooze = 0;
  }

  const score = Number((
    components.timeFit * 2
    + components.continuity * 1.5
    + components.social
    + components.energy
    + components.mood
    + components.recency
    + components.platform * 0.5
    + components.snooze
  ).toFixed(4));

  return {
    catalogGameId: entry.catalogGameId,
    title: game?.originalTitle ?? null,
    score,
    scoreComponents: components,
    reasonCodes: [...reasonCodes].sort(),
    estimatedSessionMinutes: estimate.minutes,
    estimatedSessionBasis: estimate.basis,
    ownershipEvidence: buildOwnershipEvidence(entry)
  };
}

function resolveConfidence({ candidateCount, signalCount }) {
  if (candidateCount === 0) {
    return 'LOW';
  }

  if (signalCount >= 20 && candidateCount >= 3) {
    return 'HIGH';
  }

  if (signalCount >= 6) {
    return 'MEDIUM';
  }

  return 'LOW';
}

function hashCompassRequest(request) {
  return crypto
    .createHash('sha256')
    // Only structured request fields, so the hash cannot reconstruct free text.
    .update(JSON.stringify({
      availableMinutes: request.availableMinutes,
      mood: request.mood,
      energy: request.energy,
      soloOrParty: request.soloOrParty,
      continueOrStart: request.continueOrStart,
      availablePlatforms: [...request.availablePlatforms].sort(),
      friendUserIds: [...(request.friendUserIds ?? [])].sort()
    }))
    .digest('hex');
}

async function recommend({ userId, request, now = new Date() }) {
  const libraryEntries = await prisma.userGameLibrary.findMany({
    where: {
      userId,
      // Owned-only, in-progress or queued. Nothing outside the library is
      // eligible for a default Play Compass request.
      status: { in: ['PLAYING', 'BACKLOG'] },
      catalogGameId: { not: null }
    },
    select: {
      catalogGameId: true,
      status: true,
      gameSource: true,
      externalGameId: true,
      ownershipProvenance: true,
      playtimeMinutes: true,
      lastPlayedAt: true,
      updatedAt: true
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: CANDIDATE_SCAN_LIMIT
  });

  const catalogGameIds = [...new Set(libraryEntries.map((entry) => entry.catalogGameId))];

  if (catalogGameIds.length === 0) {
    logger.info('play-compass-recommended', {
      candidateCount: 0,
      resultCount: 0,
      emptyReason: 'no_owned_playing_or_backlog_games'
    });

    return {
      recommendations: [],
      confidence: 'LOW',
      generatedAt: now.toISOString(),
      dataFreshness: { candidatePoolSize: 0, freshestLibraryUpdateAt: null, stale: true },
      emptyReason: 'no_owned_playing_or_backlog_games',
      ownedOnly: true,
      requestHash: hashCompassRequest(request)
    };
  }

  const [catalogGames, playSessions, compassEvents, friendOverlap] = await Promise.all([
    prisma.catalogGame.findMany({
      // Visibility is enforced here, not only in the catalog module. Without it a
      // quick-add claim could bind one account's library row to another account's
      // PRIVATE game and leak its title and metadata into these recommendations.
      where: {
        id: { in: catalogGameIds },
        mergedIntoCatalogGameId: null,
        OR: [{ publicationStatus: 'PUBLISHED' }, { createdByUserId: userId }]
      },
      select: {
        id: true,
        originalTitle: true,
        genres: true,
        steamTags: true,
        platforms: true,
        supportsSinglePlayer: true,
        supportsMultiplayer: true,
        typicalSessionMinutes: true
      }
    }),
    prisma.playSession.findMany({
      where: { userId, catalogGameId: { in: catalogGameIds } },
      // `note` and `mood` are not selected: Play Compass does not read them.
      select: { catalogGameId: true, playedAt: true, durationMinutes: true, outcome: true },
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
      take: 500
    }),
    prisma.playCompassEvent.findMany({
      where: { userId, catalogGameId: { in: catalogGameIds } },
      select: { catalogGameId: true, action: true, occurredAt: true },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 500
    }),
    request.friendUserIds.length > 0
      ? loadFriendOwnedOverlap({ userId, friendUserIds: request.friendUserIds, catalogGameIds })
      : Promise.resolve(new Set())
  ]);

  const gameById = new Map(catalogGames.map((game) => [game.id, game]));
  const sessionsByGame = new Map();
  const eventsByGame = new Map();

  for (const session of playSessions) {
    const list = sessionsByGame.get(session.catalogGameId) ?? [];
    list.push(session);
    sessionsByGame.set(session.catalogGameId, list);
  }

  for (const event of compassEvents) {
    const list = eventsByGame.get(event.catalogGameId) ?? [];
    list.push(event);
    eventsByGame.set(event.catalogGameId, list);
  }

  const scored = [];

  for (const entry of libraryEntries) {
    const candidate = scoreCandidate({
      entry,
      game: gameById.get(entry.catalogGameId),
      playSessions: sessionsByGame.get(entry.catalogGameId) ?? [],
      compassEvents: eventsByGame.get(entry.catalogGameId) ?? [],
      request,
      now
    });

    if (!candidate) {
      continue;
    }

    if (friendOverlap.has(entry.catalogGameId)) {
      candidate.reasonCodes = [...new Set([...candidate.reasonCodes, 'friend_owned_overlap'])].sort();
      candidate.score = Number((candidate.score + 0.4).toFixed(4));
      candidate.scoreComponents.friendOverlap = 0.4;
    }

    scored.push(candidate);
  }

  // Deterministic total order: score desc, then title asc, then id asc.
  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    const leftTitle = left.title ?? '';
    const rightTitle = right.title ?? '';

    if (leftTitle !== rightTitle) {
      return leftTitle < rightTitle ? -1 : 1;
    }

    return left.catalogGameId < right.catalogGameId ? -1 : 1;
  });

  const recommendations = scored.slice(0, PLAY_COMPASS_MAX_RESULTS)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const freshestLibraryUpdateAt = libraryEntries
    .map((entry) => entry.updatedAt)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

  logger.info('play-compass-recommended', {
    candidateCount: scored.length,
    resultCount: recommendations.length,
    availableMinutes: request.availableMinutes,
    soloOrParty: request.soloOrParty,
    continueOrStart: request.continueOrStart,
    friendOverlapCount: friendOverlap.size
  });

  return {
    recommendations,
    confidence: resolveConfidence({
      candidateCount: recommendations.length,
      signalCount: playSessions.length + libraryEntries.length
    }),
    generatedAt: now.toISOString(),
    dataFreshness: {
      candidatePoolSize: libraryEntries.length,
      freshestLibraryUpdateAt: freshestLibraryUpdateAt ? freshestLibraryUpdateAt.toISOString() : null,
      playlogSampleSize: playSessions.length,
      stale: playSessions.length === 0 && freshestLibraryUpdateAt === null
    },
    emptyReason: recommendations.length === 0 ? 'no_candidate_matched_constraints' : null,
    ownedOnly: true,
    requestHash: hashCompassRequest(request)
  };
}

/// Friend overlap only uses *accepted* friendships in both directions, so a
/// non-friend id supplied by the client contributes nothing.
async function loadFriendOwnedOverlap({ userId, friendUserIds, catalogGameIds }) {
  const friendships = await prisma.friendship.findMany({
    where: { userId, friendUserId: { in: friendUserIds } },
    select: { friendUserId: true }
  });

  const acceptedFriendIds = friendships.map((friendship) => friendship.friendUserId);

  if (acceptedFriendIds.length === 0) {
    return new Set();
  }

  const overlap = await prisma.userGameLibrary.findMany({
    where: {
      userId: { in: acceptedFriendIds },
      catalogGameId: { in: catalogGameIds }
    },
    select: { catalogGameId: true },
    distinct: ['catalogGameId']
  });

  return new Set(overlap.map((entry) => entry.catalogGameId));
}

/// Records one allowlisted feedback action. The action enum is enforced by the
/// database column type, and only structured fields are stored.
async function recordCompassEvent({ userId, catalogGameId, action, reasonCodes = [], requestHash = null, occurredAt = new Date() }) {
  const game = await prisma.catalogGame.findFirst({
    where: { id: catalogGameId, mergedIntoCatalogGameId: null },
    select: { id: true }
  });

  if (!game) {
    throw new AppError(400, 'CATALOG_GAME_NOT_FOUND', 'The referenced catalog game could not be found');
  }

  const created = await prisma.playCompassEvent.create({
    data: {
      userId,
      catalogGameId,
      action,
      reasonCodes,
      requestHash,
      occurredAt
    },
    select: { id: true, action: true, occurredAt: true }
  });

  logger.info('play-compass-event-recorded', {
    action: created.action,
    reasonCodeCount: reasonCodes.length,
    hasRequestHash: Boolean(requestHash)
  });

  return {
    eventRecordId: created.id,
    action: created.action,
    occurredAt: created.occurredAt.toISOString()
  };
}

module.exports = {
  RECENT_PLAY_WINDOW_DAYS,
  SNOOZE_WINDOW_DAYS,
  buildOwnershipEvidence,
  estimateSessionMinutes,
  hashCompassRequest,
  recommend,
  recordCompassEvent,
  scoreCandidate
};
