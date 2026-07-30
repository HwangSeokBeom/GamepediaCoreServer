const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CATALOG_GAME_A,
  CATALOG_GAME_B,
  USER_A,
  captureLogs,
  stubPrisma
} = require('./helpers/test-env');

const gameDnaService = require('../../src/modules/play/game-dna.service');
const playCompassService = require('../../src/modules/play/play-compass.service');
const monthlyReplayService = require('../../src/modules/play/monthly-replay.service');
const playTimeUtil = require('../../src/modules/play/play-time.util');
const { PLAY_COMPASS_MAX_RESULTS, PLAY_COMPASS_REASON_CODES, GAME_DNA_REASON_CODES } = require('../../src/modules/play/play.constants');

const NOW = new Date('2026-07-30T12:00:00.000Z');
const CATALOG_GAME_C = '00000000-0000-4000-8000-0000000000c3';
const CATALOG_GAME_D = '00000000-0000-4000-8000-0000000000c4';

function emptySignals() {
  return {
    reviews: [],
    libraryEntries: [],
    playSessions: [],
    catalogGames: [],
    catalogGameById: new Map(),
    recentCutoff: new Date(NOW.getTime() - 30 * 86_400_000)
  };
}

// ---------------------------------------------------------------------------
// Game DNA
// ---------------------------------------------------------------------------

test('Game DNA over no signals reports LOW confidence and names every missing signal', () => {
  const dna = gameDnaService.computeGameDnaFromSignals({ signals: emptySignals(), now: NOW });

  assert.equal(dna.signalCount, 0);
  assert.equal(dna.confidence, 'LOW');
  assert.equal(dna.computation.deterministic, true);
  assert.equal(dna.computation.aiNarrationIncluded, false);

  for (const missing of ['ratings', 'library_status', 'completion_outcomes', 'playtime_minutes', 'genres', 'steam_tags', 'recent_play', 'playlog_outcomes']) {
    assert.ok(dna.missingSignals.includes(missing), `${missing} must be reported as missing`);
  }

  assert.deepEqual(dna.missingSignals, [...dna.missingSignals].sort(), 'missing signals must be deterministically ordered');
  assert.deepEqual(dna.reasonCodes, [...dna.reasonCodes].sort());
  assert.equal(dna.dataFreshness.stale, true);
});

test('Game DNA confidence rises with the number of distinct signals', () => {
  assert.equal(gameDnaService.resolveConfidence(0), 'LOW');
  assert.equal(gameDnaService.resolveConfidence(7), 'LOW');
  assert.equal(gameDnaService.resolveConfidence(8), 'MEDIUM');
  assert.equal(gameDnaService.resolveConfidence(24), 'MEDIUM');
  assert.equal(gameDnaService.resolveConfidence(25), 'HIGH');
  assert.equal(gameDnaService.resolveConfidence(500), 'HIGH');
});

test('Game DNA is deterministic and derives every axis from structured signals', () => {
  const catalogGameById = new Map([
    [CATALOG_GAME_A, {
      id: CATALOG_GAME_A,
      genres: ['RPG', 'Open World'],
      steamTags: ['story rich'],
      supportsSinglePlayer: true,
      supportsMultiplayer: false,
      typicalSessionMinutes: 150
    }],
    [CATALOG_GAME_B, {
      id: CATALOG_GAME_B,
      genres: ['Puzzle'],
      steamTags: ['casual'],
      supportsSinglePlayer: true,
      supportsMultiplayer: false,
      typicalSessionMinutes: 20
    }]
  ]);
  const signals = {
    reviews: [{ rating: 4.5, catalogGameId: CATALOG_GAME_A, gameId: '1' }, { rating: 4, catalogGameId: CATALOG_GAME_B, gameId: '2' }, { rating: 5, catalogGameId: CATALOG_GAME_A, gameId: '1' }],
    libraryEntries: [
      { status: 'COMPLETED', playtimeMinutes: 3000, lastPlayedAt: new Date('2026-07-25T00:00:00.000Z'), catalogGameId: CATALOG_GAME_A, gameSource: 'STEAM', externalGameId: '1' },
      { status: 'COMPLETED', playtimeMinutes: 400, lastPlayedAt: new Date('2026-07-20T00:00:00.000Z'), catalogGameId: CATALOG_GAME_B, gameSource: 'IGDB', externalGameId: '2' },
      { status: 'DROPPED', playtimeMinutes: 60, lastPlayedAt: null, catalogGameId: CATALOG_GAME_B, gameSource: 'IGDB', externalGameId: '3' }
    ],
    playSessions: [
      { catalogGameId: CATALOG_GAME_A, playedAt: new Date('2026-07-28T00:00:00.000Z'), durationMinutes: 180, progressPercent: 80, outcome: 'CONTINUE' },
      { catalogGameId: CATALOG_GAME_A, playedAt: new Date('2026-07-27T00:00:00.000Z'), durationMinutes: 150, progressPercent: 60, outcome: 'COMPLETED' },
      { catalogGameId: CATALOG_GAME_A, playedAt: new Date('2026-07-26T00:00:00.000Z'), durationMinutes: 200, progressPercent: 40, outcome: 'CONTINUE' }
    ],
    catalogGames: [...catalogGameById.values()],
    catalogGameById,
    recentCutoff: new Date(NOW.getTime() - 30 * 86_400_000)
  };

  const first = gameDnaService.computeGameDnaFromSignals({ signals, now: NOW });
  const second = gameDnaService.computeGameDnaFromSignals({ signals, now: NOW });

  assert.deepEqual(first, second, 'the same signals must always produce the same DNA');
  assert.equal(first.ratingProfile.averageRating, 4.5);
  assert.equal(first.ratingProfile.ratingCount, 3);
  assert.ok(first.reasonCodes.includes('rating_sample_sufficient'));
  // 3 completed (2 library + 1 playlog) out of 4 finished outcomes.
  assert.equal(first.completionProfile.completedCount, 3);
  assert.equal(first.completionProfile.droppedCount, 1);
  assert.equal(first.completionProfile.completionRate, 0.75);
  assert.ok(first.reasonCodes.includes('completion_rate_high'));
  assert.equal(first.sessionLengthProfile.label, 'LONG');
  assert.equal(first.sessionLengthProfile.medianSessionMinutes, 180);
  assert.equal(first.socialProfile.label, 'SINGLEPLAYER');
  assert.equal(first.missingSignals.includes('genres'), false);
  assert.equal(first.dataFreshness.stale, false);
  assert.ok(first.genreProfile.topGenres.length > 0);

  for (const code of first.reasonCodes) {
    assert.ok(GAME_DNA_REASON_CODES.includes(code), `${code} must be an allowlisted DNA reason code`);
  }
});

test('Game DNA never reads a Playlog note body', async () => {
  let capturedSelect = null;
  const restore = stubPrisma({
    review: { findMany: async () => [] },
    userGameLibrary: { findMany: async () => [] },
    playSession: {
      findMany: async (args) => {
        capturedSelect = args.select;
        return [];
      }
    }
  });

  try {
    await gameDnaService.loadSignals({ userId: USER_A, now: NOW });

    assert.equal(capturedSelect.note, undefined, 'the DNA query must not select note');
    assert.equal(capturedSelect.mood, undefined, 'DNA does not use mood as an input signal');
    assert.equal(capturedSelect.outcome, true, 'DNA does use the structured outcome state');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Play Compass
// ---------------------------------------------------------------------------

function libraryEntry(overrides = {}) {
  return {
    catalogGameId: CATALOG_GAME_A,
    status: 'PLAYING',
    gameSource: 'STEAM',
    externalGameId: '367520',
    playtimeMinutes: 600,
    lastPlayedAt: new Date('2026-07-28T00:00:00.000Z'),
    updatedAt: new Date('2026-07-29T00:00:00.000Z'),
    ...overrides
  };
}

function catalogGame(id, overrides = {}) {
  return {
    id,
    originalTitle: `Game ${id.slice(-2)}`,
    genres: ['RPG'],
    steamTags: ['story rich'],
    platforms: ['STEAM'],
    supportsSinglePlayer: true,
    supportsMultiplayer: false,
    typicalSessionMinutes: 60,
    ...overrides
  };
}

function compassRequest(overrides = {}) {
  return {
    availableMinutes: 60,
    mood: null,
    energy: 'MEDIUM',
    soloOrParty: 'EITHER',
    continueOrStart: 'EITHER',
    availablePlatforms: [],
    friendUserIds: [],
    ...overrides
  };
}

function stubCompass({ entries, games, sessions = [], events = [] }) {
  return stubPrisma({
    userGameLibrary: { findMany: async () => entries },
    catalogGame: { findMany: async () => games },
    playSession: { findMany: async () => sessions },
    playCompassEvent: { findMany: async () => events }
  });
}

test('Play Compass returns at most three picks even with many candidates', async () => {
  const ids = [CATALOG_GAME_A, CATALOG_GAME_B, CATALOG_GAME_C, CATALOG_GAME_D, '00000000-0000-4000-8000-0000000000c5'];
  const restore = stubCompass({
    entries: ids.map((id, index) => libraryEntry({ catalogGameId: id, externalGameId: String(1000 + index) })),
    games: ids.map((id) => catalogGame(id))
  });

  try {
    const result = await playCompassService.recommend({ userId: USER_A, request: compassRequest(), now: NOW });

    assert.equal(result.recommendations.length, PLAY_COMPASS_MAX_RESULTS);
    assert.deepEqual(result.recommendations.map((item) => item.rank), [1, 2, 3]);
    assert.equal(result.ownedOnly, true);

    for (const recommendation of result.recommendations) {
      for (const code of recommendation.reasonCodes) {
        assert.ok(PLAY_COMPASS_REASON_CODES.includes(code), `${code} must be an allowlisted compass reason code`);
      }

      assert.ok(recommendation.ownershipEvidence.source);
      assert.ok(recommendation.ownershipEvidence.provenance);
      assert.equal(recommendation.ownershipEvidence.installEvidence.known, false);
    }
  } finally {
    restore();
  }
});

test('Play Compass only queries owned PLAYING and BACKLOG library entries', async () => {
  let capturedWhere = null;
  const restore = stubPrisma({
    userGameLibrary: {
      findMany: async (args) => {
        capturedWhere = args.where;
        return [];
      }
    }
  });

  try {
    const result = await playCompassService.recommend({ userId: USER_A, request: compassRequest(), now: NOW });

    assert.equal(capturedWhere.userId, USER_A);
    assert.deepEqual(capturedWhere.status, { in: ['PLAYING', 'BACKLOG'] });
    assert.deepEqual(capturedWhere.catalogGameId, { not: null });
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.emptyReason, 'no_owned_playing_or_backlog_games');
    assert.equal(result.ownedOnly, true);
  } finally {
    restore();
  }
});

test('Play Compass ranking is a deterministic total order', async () => {
  const ids = [CATALOG_GAME_B, CATALOG_GAME_A, CATALOG_GAME_C];
  const entries = ids.map((id, index) => libraryEntry({ catalogGameId: id, externalGameId: String(2000 + index) }));
  const games = ids.map((id) => catalogGame(id, { originalTitle: 'Identical Title', typicalSessionMinutes: 60 }));

  const restoreForward = stubCompass({ entries, games });
  let forward;

  try {
    forward = await playCompassService.recommend({ userId: USER_A, request: compassRequest(), now: NOW });
  } finally {
    restoreForward();
  }

  const restoreReversed = stubCompass({ entries: [...entries].reverse(), games: [...games].reverse() });

  try {
    const reversed = await playCompassService.recommend({ userId: USER_A, request: compassRequest(), now: NOW });

    assert.deepEqual(
      reversed.recommendations.map((item) => item.catalogGameId),
      forward.recommendations.map((item) => item.catalogGameId),
      'identical scores and titles must break the tie on id, not on input order'
    );
  } finally {
    restoreReversed();
  }
});

test('CONTINUE only proposes in-progress games and START only proposes untouched ones', async () => {
  const entries = [
    libraryEntry({ catalogGameId: CATALOG_GAME_A, status: 'PLAYING', externalGameId: '1' }),
    libraryEntry({ catalogGameId: CATALOG_GAME_B, status: 'BACKLOG', externalGameId: '2', lastPlayedAt: null })
  ];
  const games = [catalogGame(CATALOG_GAME_A), catalogGame(CATALOG_GAME_B)];

  const restoreContinue = stubCompass({ entries, games });

  try {
    const result = await playCompassService.recommend({
      userId: USER_A,
      request: compassRequest({ continueOrStart: 'CONTINUE' }),
      now: NOW
    });

    assert.deepEqual(result.recommendations.map((item) => item.catalogGameId), [CATALOG_GAME_A]);
    assert.ok(result.recommendations[0].reasonCodes.includes('already_in_progress'));
  } finally {
    restoreContinue();
  }

  const restoreStart = stubCompass({ entries, games });

  try {
    const result = await playCompassService.recommend({
      userId: USER_A,
      request: compassRequest({ continueOrStart: 'START' }),
      now: NOW
    });

    assert.deepEqual(result.recommendations.map((item) => item.catalogGameId), [CATALOG_GAME_B]);
    assert.ok(result.recommendations[0].reasonCodes.includes('fresh_start_available'));
  } finally {
    restoreStart();
  }
});

test('an unavailable platform and an explicit exclusion both remove a candidate', async () => {
  const restore = stubCompass({
    entries: [
      libraryEntry({ catalogGameId: CATALOG_GAME_A, externalGameId: '1', gameSource: 'IGDB' }),
      libraryEntry({ catalogGameId: CATALOG_GAME_B, externalGameId: '2', gameSource: 'IGDB' })
    ],
    games: [
      catalogGame(CATALOG_GAME_A, { platforms: ['SWITCH'] }),
      catalogGame(CATALOG_GAME_B, { platforms: ['PC'] })
    ],
    events: [{ catalogGameId: CATALOG_GAME_B, action: 'EXCLUDED', occurredAt: new Date('2026-07-01T00:00:00.000Z') }]
  });

  try {
    const result = await playCompassService.recommend({
      userId: USER_A,
      request: compassRequest({ availablePlatforms: ['PC'] }),
      now: NOW
    });

    // A: wrong platform. B: explicitly excluded. Nothing survives.
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.emptyReason, 'no_candidate_matched_constraints');
  } finally {
    restore();
  }
});

test('a recent snooze deprioritizes a pick without removing it', async () => {
  const restore = stubCompass({
    entries: [
      libraryEntry({ catalogGameId: CATALOG_GAME_A, externalGameId: '1' }),
      libraryEntry({ catalogGameId: CATALOG_GAME_B, externalGameId: '2' })
    ],
    games: [catalogGame(CATALOG_GAME_A, { originalTitle: 'AAA' }), catalogGame(CATALOG_GAME_B, { originalTitle: 'BBB' })],
    events: [{ catalogGameId: CATALOG_GAME_A, action: 'SNOOZED', occurredAt: new Date('2026-07-29T00:00:00.000Z') }]
  });

  try {
    const result = await playCompassService.recommend({ userId: USER_A, request: compassRequest(), now: NOW });

    assert.equal(result.recommendations.length, 2, 'a snooze must not remove the candidate');
    assert.equal(result.recommendations[0].catalogGameId, CATALOG_GAME_B, 'the snoozed pick must rank lower');
    const snoozed = result.recommendations.find((item) => item.catalogGameId === CATALOG_GAME_A);
    assert.ok(snoozed.reasonCodes.includes('snoozed_recently_deprioritized'));
  } finally {
    restore();
  }
});

test('the compass request hash covers only structured fields', () => {
  const hash = playCompassService.hashCompassRequest(compassRequest({ availableMinutes: 45 }));

  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, playCompassService.hashCompassRequest(compassRequest({ availableMinutes: 45 })));
  assert.notEqual(hash, playCompassService.hashCompassRequest(compassRequest({ availableMinutes: 90 })));
  // Platform order must not change the hash.
  assert.equal(
    playCompassService.hashCompassRequest(compassRequest({ availablePlatforms: ['PC', 'STEAM'] })),
    playCompassService.hashCompassRequest(compassRequest({ availablePlatforms: ['STEAM', 'PC'] }))
  );
});

test('session length estimation prefers real Playlog data over genre heuristics', () => {
  assert.deepEqual(
    playCompassService.estimateSessionMinutes({
      game: catalogGame(CATALOG_GAME_A, { typicalSessionMinutes: 999 }),
      playSessions: [{ durationMinutes: 30 }, { durationMinutes: 40 }, { durationMinutes: 50 }]
    }),
    { minutes: 40, basis: 'playlog_median' }
  );
  assert.deepEqual(
    playCompassService.estimateSessionMinutes({
      game: catalogGame(CATALOG_GAME_A, { typicalSessionMinutes: 75 }),
      playSessions: []
    }),
    { minutes: 75, basis: 'catalog_typical_session' }
  );
  assert.deepEqual(
    playCompassService.estimateSessionMinutes({
      game: { genres: ['Puzzle'], steamTags: [] },
      playSessions: []
    }),
    { minutes: 30, basis: 'genre_short_session' }
  );
  assert.deepEqual(
    playCompassService.estimateSessionMinutes({ game: null, playSessions: [] }),
    { minutes: 60, basis: 'default_estimate' }
  );
});

test('Play Compass never reads Playlog notes or moods', async () => {
  let capturedSelect = null;
  const restore = stubPrisma({
    userGameLibrary: { findMany: async () => [libraryEntry()] },
    catalogGame: { findMany: async () => [catalogGame(CATALOG_GAME_A)] },
    playSession: {
      findMany: async (args) => {
        capturedSelect = args.select;
        return [];
      }
    },
    playCompassEvent: { findMany: async () => [] }
  });

  try {
    await playCompassService.recommend({ userId: USER_A, request: compassRequest(), now: NOW });

    assert.equal(capturedSelect.note, undefined);
    assert.equal(capturedSelect.mood, undefined);
  } finally {
    restore();
  }
});

test('only allowlisted compass actions can be recorded', async () => {
  const recorded = [];
  const logs = captureLogs();
  const restore = stubPrisma({
    catalogGame: { findFirst: async () => ({ id: CATALOG_GAME_A }) },
    playCompassEvent: {
      create: async ({ data }) => {
        recorded.push(data);
        return { id: 'event-1', action: data.action, occurredAt: data.occurredAt };
      }
    }
  });

  try {
    await playCompassService.recordCompassEvent({
      userId: USER_A,
      catalogGameId: CATALOG_GAME_A,
      action: 'SNOOZED',
      reasonCodes: ['fits_available_time'],
      requestHash: 'a'.repeat(64),
      occurredAt: NOW
    });

    assert.equal(recorded[0].action, 'SNOOZED');
    assert.deepEqual(recorded[0].reasonCodes, ['fits_available_time']);
    // Only codes and flags are logged.
    assert.match(logs.serialize(), /"reasonCodeCount":1/);
  } finally {
    logs.restore();
    restore();
  }
});

// ---------------------------------------------------------------------------
// Monthly Replay: timezone and DST
// ---------------------------------------------------------------------------

test('month windows are resolved in the caller timezone', () => {
  assert.equal(
    playTimeUtil.resolveMonthWindow({ month: '2026-02', timeZone: 'Asia/Seoul' }).startUtc.toISOString(),
    '2026-01-31T15:00:00.000Z'
  );
  assert.equal(
    playTimeUtil.resolveMonthWindow({ month: '2026-02', timeZone: 'UTC' }).startUtc.toISOString(),
    '2026-02-01T00:00:00.000Z'
  );
  assert.equal(
    playTimeUtil.resolveMonthWindow({ month: '2026-02', timeZone: 'America/Los_Angeles' }).startUtc.toISOString(),
    '2026-02-01T08:00:00.000Z'
  );
});

test('a spring-forward month window spans the DST change correctly', () => {
  // America/New_York moves from UTC-5 to UTC-4 on 2026-03-08.
  const window = playTimeUtil.resolveMonthWindow({ month: '2026-03', timeZone: 'America/New_York' });

  assert.equal(window.startUtc.toISOString(), '2026-03-01T05:00:00.000Z', 'the month starts at EST midnight');
  assert.equal(window.endUtc.toISOString(), '2026-04-01T04:00:00.000Z', 'the month ends at EDT midnight');
  // A naive fixed-offset calculation would produce a 31*24h span; the real local
  // month is one hour shorter.
  const spanHours = (window.endUtc.getTime() - window.startUtc.getTime()) / 3_600_000;
  assert.equal(spanHours, 31 * 24 - 1);
});

test('a fall-back month window spans the DST change correctly', () => {
  // Europe/Berlin moves from UTC+2 to UTC+1 on 2026-10-25.
  const window = playTimeUtil.resolveMonthWindow({ month: '2026-10', timeZone: 'Europe/Berlin' });

  assert.equal(window.startUtc.toISOString(), '2026-09-30T22:00:00.000Z');
  assert.equal(window.endUtc.toISOString(), '2026-10-31T23:00:00.000Z');
  const spanHours = (window.endUtc.getTime() - window.startUtc.getTime()) / 3_600_000;
  assert.equal(spanHours, 31 * 24 + 1, 'a fall-back month is one hour longer');
});

test('local day keys are correct on both sides of a DST boundary', () => {
  // 23:59 EST on 2026-03-07 -> still 2026-03-07.
  assert.equal(playTimeUtil.toZonedDateKey(new Date('2026-03-08T04:59:00.000Z'), 'America/New_York'), '2026-03-07');
  // 01:30 EST on the transition day.
  assert.equal(playTimeUtil.toZonedDateKey(new Date('2026-03-08T06:30:00.000Z'), 'America/New_York'), '2026-03-08');
  // 03:30 EDT, after the clocks jumped.
  assert.equal(playTimeUtil.toZonedDateKey(new Date('2026-03-08T07:30:00.000Z'), 'America/New_York'), '2026-03-08');
  // 23:59 EDT on 2026-03-08 -> still 2026-03-08, not 2026-03-09.
  assert.equal(playTimeUtil.toZonedDateKey(new Date('2026-03-09T03:59:00.000Z'), 'America/New_York'), '2026-03-08');
  assert.equal(playTimeUtil.toZonedDateKey(new Date('2026-03-09T04:01:00.000Z'), 'America/New_York'), '2026-03-09');
});

test('month day counts handle leap years and short months', () => {
  assert.equal(playTimeUtil.listMonthDateKeys({ month: '2026-02', timeZone: 'UTC' }).length, 28);
  assert.equal(playTimeUtil.listMonthDateKeys({ month: '2024-02', timeZone: 'UTC' }).length, 29);
  assert.equal(playTimeUtil.listMonthDateKeys({ month: '2026-04', timeZone: 'UTC' }).length, 30);
  assert.equal(playTimeUtil.listMonthDateKeys({ month: '2026-12', timeZone: 'UTC' }).length, 31);
  assert.deepEqual(playTimeUtil.listMonthDateKeys({ month: '2026-12', timeZone: 'UTC' }).slice(-1), ['2026-12-31']);
});

test('an invalid month or timezone is rejected with a precise code', () => {
  for (const month of ['2026-13', '26-01', '2026-1', 'not-a-month', '']) {
    assert.throws(
      () => playTimeUtil.resolveMonthWindow({ month, timeZone: 'UTC' }),
      (error) => error.code === 'INVALID_MONTH',
      `must reject ${month}`
    );
  }

  assert.throws(
    () => playTimeUtil.assertSupportedTimeZone('Not/AZone'),
    (error) => error.code === 'INVALID_TIMEZONE'
  );
});

test('Monthly Replay buckets sessions in local time and never selects note bodies', async () => {
  let capturedSelect = null;
  const restore = stubPrisma({
    playSession: {
      findMany: async (args) => {
        if (args.distinct) {
          return [];
        }

        capturedSelect = args.select;

        return [
          // 2026-03-08T04:30Z is 2026-03-07 23:30 EST — the previous local day.
          { id: 's-1', catalogGameId: CATALOG_GAME_A, playedAt: new Date('2026-03-08T04:30:00.000Z'), durationMinutes: 60, progressPercent: 10, mood: 'RELAXED', outcome: 'CONTINUE', provenance: 'USER_CONFIRMED' },
          // 2026-03-08T07:30Z is 2026-03-08 03:30 EDT — after the jump.
          { id: 's-2', catalogGameId: CATALOG_GAME_A, playedAt: new Date('2026-03-08T07:30:00.000Z'), durationMinutes: 30, progressPercent: 20, mood: 'RELAXED', outcome: 'COMPLETED', provenance: 'USER_CONFIRMED' },
          { id: 's-3', catalogGameId: CATALOG_GAME_B, playedAt: new Date('2026-03-20T18:00:00.000Z'), durationMinutes: null, progressPercent: null, mood: null, outcome: 'DROPPED', provenance: 'USER_CONFIRMED' }
        ];
      }
    },
    catalogGame: {
      findMany: async () => [
        { id: CATALOG_GAME_A, originalTitle: 'Alpha', genres: ['RPG'], steamTags: [] },
        { id: CATALOG_GAME_B, originalTitle: 'Beta', genres: [], steamTags: [] }
      ]
    }
  });

  try {
    const replay = await monthlyReplayService.getMonthlyReplay({
      userId: USER_A,
      month: '2026-03',
      timezone: 'America/New_York',
      now: NOW
    });

    assert.equal(capturedSelect.note, undefined, 'the replay query must not select note');
    assert.deepEqual(replay.playedDates, ['2026-03-07', '2026-03-08', '2026-03-20']);
    assert.equal(replay.totals.playedDayCount, 3);
    assert.equal(replay.totals.totalMinutes, 90);
    assert.equal(replay.totals.minutesKnownForAllSessions, false);
    assert.equal(replay.window.localDayCount, 31);
    assert.equal(replay.mostPlayedGame.catalogGameId, CATALOG_GAME_A);
    assert.equal(replay.mostPlayedGame.totalMinutes, 90);
    assert.deepEqual(replay.completedGames.map((game) => game.catalogGameId), [CATALOG_GAME_A]);
    assert.deepEqual(replay.droppedGames.map((game) => game.catalogGameId), [CATALOG_GAME_B]);
    assert.deepEqual(replay.moodDistribution, { RELAXED: 2 });
    assert.deepEqual(replay.genreDistribution, { rpg: 2 });
    assert.equal(replay.provenance.deterministic, true);
    assert.equal(replay.provenance.basis, 'user_playlog');

    const missingCodes = replay.missingData.map((note) => note.code);
    assert.ok(missingCodes.includes('sessions_without_duration'));
    assert.ok(missingCodes.includes('sessions_without_mood'));
    assert.ok(missingCodes.includes('games_without_genre_metadata'));
  } finally {
    restore();
  }
});

test('Monthly Replay reports an empty month explicitly', async () => {
  const restore = stubPrisma({
    playSession: { findMany: async () => [] },
    catalogGame: { findMany: async () => [] }
  });

  try {
    const replay = await monthlyReplayService.getMonthlyReplay({
      userId: USER_A,
      month: '2026-01',
      timezone: 'Asia/Seoul',
      now: NOW
    });

    assert.equal(replay.isEmpty, true);
    assert.equal(replay.emptyReason, 'no_play_sessions_recorded_in_month');
    assert.deepEqual(replay.playedDates, []);
    assert.equal(replay.mostPlayedGame, null);
    assert.equal(replay.surpriseGame, null);
    assert.deepEqual(replay.missingData, []);
  } finally {
    restore();
  }
});

test('the surprise game is a first-time-this-month pick that is not the headline', async () => {
  const restore = stubPrisma({
    playSession: {
      findMany: async (args) => {
        if (args.distinct) {
          // Alpha was played before this month; Beta was not.
          return [{ catalogGameId: CATALOG_GAME_A }];
        }

        return [
          { id: 's-1', catalogGameId: CATALOG_GAME_A, playedAt: new Date('2026-07-05T10:00:00.000Z'), durationMinutes: 600, progressPercent: null, mood: null, outcome: 'CONTINUE', provenance: 'USER_CONFIRMED' },
          { id: 's-2', catalogGameId: CATALOG_GAME_B, playedAt: new Date('2026-07-06T10:00:00.000Z'), durationMinutes: 45, progressPercent: null, mood: null, outcome: 'CONTINUE', provenance: 'USER_CONFIRMED' },
          { id: 's-3', catalogGameId: CATALOG_GAME_B, playedAt: new Date('2026-07-07T10:00:00.000Z'), durationMinutes: 40, progressPercent: null, mood: null, outcome: 'CONTINUE', provenance: 'USER_CONFIRMED' }
        ];
      }
    },
    catalogGame: {
      findMany: async () => [
        { id: CATALOG_GAME_A, originalTitle: 'Alpha', genres: ['RPG'], steamTags: [] },
        { id: CATALOG_GAME_B, originalTitle: 'Beta', genres: ['Puzzle'], steamTags: [] }
      ]
    }
  });

  try {
    const replay = await monthlyReplayService.getMonthlyReplay({
      userId: USER_A,
      month: '2026-07',
      timezone: 'UTC',
      now: NOW
    });

    assert.equal(replay.mostPlayedGame.catalogGameId, CATALOG_GAME_A);
    assert.deepEqual(replay.startedGames.map((game) => game.catalogGameId), [CATALOG_GAME_B]);
    assert.equal(replay.surpriseGame.catalogGameId, CATALOG_GAME_B);
    assert.equal(replay.surpriseGame.reasonCode, 'first_played_this_month');
  } finally {
    restore();
  }
});

test('most-played ties break deterministically', () => {
  const left = { catalogGameId: 'c-1', title: 'A', totalMinutes: 100, sessionCount: 2 };
  const right = { catalogGameId: 'c-2', title: 'B', totalMinutes: 100, sessionCount: 2 };

  assert.ok(monthlyReplayService.compareMostPlayed(left, right) < 0);
  assert.ok(monthlyReplayService.compareMostPlayed(right, left) > 0);
  assert.ok(monthlyReplayService.compareMostPlayed(
    { ...left, totalMinutes: 200 },
    right
  ) < 0);
});
