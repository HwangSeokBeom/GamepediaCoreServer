const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const { listMonthDateKeys, resolveMonthWindow, toZonedDateKey } = require('./play-time.util');

// Monthly Replay. Month boundaries and day buckets are always resolved in the
// caller's timezone through play-time.util, so a DST transition inside the month
// cannot shift a session into the wrong day or drop an hour of playtime.
//
// Playlog note bodies are never read. `mood` is a fixed enum and is reported as a
// distribution of codes only.

/// Deterministic tie-break for "most played": minutes desc, then session count
/// desc, then title asc, then id asc.
function compareMostPlayed(left, right) {
  if (right.totalMinutes !== left.totalMinutes) {
    return right.totalMinutes - left.totalMinutes;
  }

  if (right.sessionCount !== left.sessionCount) {
    return right.sessionCount - left.sessionCount;
  }

  const leftTitle = left.title ?? '';
  const rightTitle = right.title ?? '';

  if (leftTitle !== rightTitle) {
    return leftTitle < rightTitle ? -1 : 1;
  }

  return left.catalogGameId < right.catalogGameId ? -1 : 1;
}

function toDistribution(counts) {
  return Object.fromEntries([...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }

    return left[0] < right[0] ? -1 : 1;
  }));
}

async function getMonthlyReplay({ userId, month, timezone, now = new Date() }) {
  const window = resolveMonthWindow({ month, timeZone: timezone });

  const sessions = await prisma.playSession.findMany({
    where: {
      userId,
      playedAt: { gte: window.startUtc, lt: window.endUtc }
    },
    // `note` is intentionally not selected.
    select: {
      id: true,
      catalogGameId: true,
      playedAt: true,
      durationMinutes: true,
      progressPercent: true,
      mood: true,
      outcome: true,
      provenance: true
    },
    orderBy: [{ playedAt: 'asc' }, { id: 'asc' }]
  });

  const catalogGameIds = [...new Set(sessions.map((session) => session.catalogGameId))];
  const catalogGames = catalogGameIds.length > 0
    ? await prisma.catalogGame.findMany({
      where: { id: { in: catalogGameIds } },
      select: { id: true, originalTitle: true, genres: true, steamTags: true }
    })
    : [];
  const gameById = new Map(catalogGames.map((game) => [game.id, game]));

  // Anything played before this month tells us whether a game is genuinely new.
  const priorSessions = catalogGameIds.length > 0
    ? await prisma.playSession.findMany({
      where: {
        userId,
        catalogGameId: { in: catalogGameIds },
        playedAt: { lt: window.startUtc }
      },
      select: { catalogGameId: true },
      distinct: ['catalogGameId']
    })
    : [];
  const playedBefore = new Set(priorSessions.map((session) => session.catalogGameId));

  const playedDateKeys = new Set();
  const perGame = new Map();
  const genreCounts = new Map();
  const moodCounts = new Map();
  const startedGameIds = new Set();
  const completedGameIds = new Set();
  const droppedGameIds = new Set();
  let totalMinutes = 0;
  let sessionsWithoutDuration = 0;
  let sessionsWithoutMood = 0;
  const provenanceCounts = new Map();

  for (const session of sessions) {
    const dateKey = toZonedDateKey(session.playedAt, timezone);
    playedDateKeys.add(dateKey);

    const game = gameById.get(session.catalogGameId);
    const bucket = perGame.get(session.catalogGameId) ?? {
      catalogGameId: session.catalogGameId,
      title: game?.originalTitle ?? null,
      sessionCount: 0,
      totalMinutes: 0,
      minutesKnown: true,
      outcomes: {},
      firstPlayedAt: session.playedAt,
      lastPlayedAt: session.playedAt
    };

    bucket.sessionCount += 1;
    bucket.outcomes[session.outcome] = (bucket.outcomes[session.outcome] ?? 0) + 1;
    bucket.lastPlayedAt = session.playedAt;

    if (Number.isInteger(session.durationMinutes)) {
      bucket.totalMinutes += session.durationMinutes;
      totalMinutes += session.durationMinutes;
    } else {
      bucket.minutesKnown = false;
      sessionsWithoutDuration += 1;
    }

    perGame.set(session.catalogGameId, bucket);

    if (!playedBefore.has(session.catalogGameId)) {
      startedGameIds.add(session.catalogGameId);
    }

    if (session.outcome === 'COMPLETED') {
      completedGameIds.add(session.catalogGameId);
    }

    if (session.outcome === 'DROPPED') {
      droppedGameIds.add(session.catalogGameId);
    }

    for (const genre of game?.genres ?? []) {
      const key = String(genre).toLowerCase();
      genreCounts.set(key, (genreCounts.get(key) ?? 0) + 1);
    }

    if (session.mood) {
      moodCounts.set(session.mood, (moodCounts.get(session.mood) ?? 0) + 1);
    } else {
      sessionsWithoutMood += 1;
    }

    provenanceCounts.set(session.provenance, (provenanceCounts.get(session.provenance) ?? 0) + 1);
  }

  const gameSummaries = [...perGame.values()].sort(compareMostPlayed);
  const mostPlayed = gameSummaries[0] ?? null;

  // "Surprise game": played this month for the first time, meaningfully engaged
  // with, and not the headline pick. Deterministic and evidence based.
  const surpriseCandidates = gameSummaries
    .filter((summary) => startedGameIds.has(summary.catalogGameId))
    .filter((summary) => summary.catalogGameId !== mostPlayed?.catalogGameId)
    .filter((summary) => summary.sessionCount >= 2 || summary.totalMinutes >= 60);
  const surpriseGame = surpriseCandidates[0] ?? null;

  const missingDataNotes = [];

  if (sessionsWithoutDuration > 0) {
    missingDataNotes.push({
      code: 'sessions_without_duration',
      affectedSessionCount: sessionsWithoutDuration,
      effect: 'total_and_per_game_minutes_understated'
    });
  }

  if (sessionsWithoutMood > 0) {
    missingDataNotes.push({
      code: 'sessions_without_mood',
      affectedSessionCount: sessionsWithoutMood,
      effect: 'mood_distribution_incomplete'
    });
  }

  const gamesMissingMetadata = catalogGameIds.filter((catalogGameId) => {
    const game = gameById.get(catalogGameId);

    return !game || (game.genres ?? []).length === 0;
  });

  if (gamesMissingMetadata.length > 0) {
    missingDataNotes.push({
      code: 'games_without_genre_metadata',
      affectedGameCount: gamesMissingMetadata.length,
      effect: 'genre_distribution_incomplete'
    });
  }

  const allDateKeys = listMonthDateKeys({ month, timeZone: timezone });

  logger.info('monthly-replay-computed', {
    monthKey: window.monthKey,
    sessionCount: sessions.length,
    playedDayCount: playedDateKeys.size,
    distinctGameCount: catalogGameIds.length,
    missingDataNoteCount: missingDataNotes.length,
    isEmpty: sessions.length === 0
  });

  return {
    monthKey: window.monthKey,
    timezone,
    window: {
      startUtc: window.startUtc.toISOString(),
      endUtc: window.endUtc.toISOString(),
      localDayCount: allDateKeys.length
    },
    generatedAt: now.toISOString(),
    isEmpty: sessions.length === 0,
    emptyReason: sessions.length === 0 ? 'no_play_sessions_recorded_in_month' : null,
    playedDates: [...playedDateKeys].sort(),
    totals: {
      sessionCount: sessions.length,
      playedDayCount: playedDateKeys.size,
      totalMinutes,
      minutesKnownForAllSessions: sessionsWithoutDuration === 0,
      distinctGameCount: catalogGameIds.length
    },
    startedGames: gameSummaries.filter((summary) => startedGameIds.has(summary.catalogGameId))
      .map((summary) => ({ catalogGameId: summary.catalogGameId, title: summary.title })),
    completedGames: gameSummaries.filter((summary) => completedGameIds.has(summary.catalogGameId))
      .map((summary) => ({ catalogGameId: summary.catalogGameId, title: summary.title })),
    droppedGames: gameSummaries.filter((summary) => droppedGameIds.has(summary.catalogGameId))
      .map((summary) => ({ catalogGameId: summary.catalogGameId, title: summary.title })),
    mostPlayedGame: mostPlayed
      ? {
        catalogGameId: mostPlayed.catalogGameId,
        title: mostPlayed.title,
        totalMinutes: mostPlayed.totalMinutes,
        sessionCount: mostPlayed.sessionCount,
        minutesKnown: mostPlayed.minutesKnown
      }
      : null,
    surpriseGame: surpriseGame
      ? {
        catalogGameId: surpriseGame.catalogGameId,
        title: surpriseGame.title,
        totalMinutes: surpriseGame.totalMinutes,
        sessionCount: surpriseGame.sessionCount,
        reasonCode: 'first_played_this_month'
      }
      : null,
    genreDistribution: toDistribution(genreCounts),
    moodDistribution: toDistribution(moodCounts),
    perGame: gameSummaries.map((summary) => ({
      catalogGameId: summary.catalogGameId,
      title: summary.title,
      sessionCount: summary.sessionCount,
      totalMinutes: summary.totalMinutes,
      minutesKnown: summary.minutesKnown,
      outcomes: summary.outcomes,
      firstPlayedAt: summary.firstPlayedAt.toISOString(),
      lastPlayedAt: summary.lastPlayedAt.toISOString()
    })),
    provenance: {
      // Every figure here comes from the account's own confirmed Playlog entries.
      basis: 'user_playlog',
      sessionProvenanceCounts: toDistribution(provenanceCounts),
      deterministic: true
    },
    missingData: missingDataNotes
  };
}

module.exports = {
  compareMostPlayed,
  getMonthlyReplay
};
