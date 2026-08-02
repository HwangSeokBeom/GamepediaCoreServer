const test = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const {
  CATALOG_GAME_A,
  CATALOG_GAME_B,
  USER_A,
  USER_B,
  captureLogs,
  stubPrisma,
  stubQueryRaw,
  stubTransaction
} = require('./helpers/test-env');

const playlogService = require('../../src/modules/play/playlog.service');

const SESSION_ID = '00000000-0000-4000-8000-0000000000e1';
const CLIENT_MUTATION_ID = 'client-mutation-0001';
const SECRET_NOTE = 'the final boss lore twist ruined my evening';

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['user_id', 'client_mutation_id'] }
  });
}

function sessionRow(overrides = {}) {
  return {
    id: SESSION_ID,
    catalogGameId: CATALOG_GAME_A,
    regionalReleaseId: null,
    playedAt: new Date('2026-07-15T10:00:00.000Z'),
    durationMinutes: 90,
    progressPercent: 40,
    mood: 'FOCUSED',
    note: SECRET_NOTE,
    outcome: 'CONTINUE',
    visibility: 'PRIVATE',
    provenance: 'USER_CONFIRMED',
    clientMutationId: CLIENT_MUTATION_ID,
    createdAt: new Date('2026-07-15T10:05:00.000Z'),
    updatedAt: new Date('2026-07-15T10:05:00.000Z'),
    ...overrides
  };
}

function stubUsableCatalogGame() {
  return {
    catalogGame: {
      findUnique: async ({ where }) => ({ id: where.id, mergedIntoCatalogGameId: null }),
      findFirst: async () => ({ id: CATALOG_GAME_A })
    }
  };
}

test('a retried clientMutationId returns the original session instead of a duplicate', async () => {
  let createCalls = 0;
  const restore = stubPrisma({
    ...stubUsableCatalogGame(),
    playSession: {
      create: async () => {
        createCalls += 1;
        throw uniqueViolation();
      },
      findUnique: async ({ where }) => {
        assert.deepEqual(where.userId_clientMutationId, {
          userId: USER_A,
          clientMutationId: CLIENT_MUTATION_ID
        });
        return sessionRow();
      }
    }
  });

  try {
    const result = await playlogService.createPlaySession({
      userId: USER_A,
      input: {
        catalogGameId: CATALOG_GAME_A,
        playedAt: new Date('2026-07-15T10:00:00.000Z'),
        outcome: 'CONTINUE',
        clientMutationId: CLIENT_MUTATION_ID
      }
    });

    assert.equal(result.idempotentReplay, true);
    assert.equal(result.session.id, SESSION_ID);
    assert.equal(createCalls, 1, 'exactly one insert attempt, then the existing row is returned');
  } finally {
    restore();
  }
});

test('a first write with a fresh clientMutationId creates the session', async () => {
  const restore = stubPrisma({
    ...stubUsableCatalogGame(),
    playSession: {
      create: async ({ data }) => {
        assert.equal(data.userId, USER_A);
        assert.equal(data.visibility, 'PRIVATE', 'visibility defaults to PRIVATE');
        return sessionRow();
      }
    }
  });

  try {
    const result = await playlogService.createPlaySession({
      userId: USER_A,
      input: {
        catalogGameId: CATALOG_GAME_A,
        playedAt: new Date('2026-07-15T10:00:00.000Z'),
        outcome: 'CONTINUE',
        clientMutationId: CLIENT_MUTATION_ID
      }
    });

    assert.equal(result.idempotentReplay, false);
  } finally {
    restore();
  }
});

test('creating a session never logs the note or the mood value', async () => {
  const logs = captureLogs();
  const restore = stubPrisma({
    ...stubUsableCatalogGame(),
    playSession: { create: async () => sessionRow() }
  });

  try {
    await playlogService.createPlaySession({
      userId: USER_A,
      input: {
        catalogGameId: CATALOG_GAME_A,
        playedAt: new Date('2026-07-15T10:00:00.000Z'),
        outcome: 'CONTINUE',
        note: SECRET_NOTE,
        mood: 'FOCUSED',
        clientMutationId: CLIENT_MUTATION_ID
      }
    });

    const serialized = logs.serialize();

    assert.equal(serialized.includes(SECRET_NOTE), false, 'the note body must never be logged');
    assert.equal(serialized.includes('final boss'), false);
    // Only presence flags are logged, never the content.
    assert.match(serialized, /"hasNote":true/);
    assert.match(serialized, /"hasMood":true/);
  } finally {
    logs.restore();
    restore();
  }
});

test('updating another account session is rejected as not found', async () => {
  const queries = [];
  const restoreTransaction = stubTransaction();
  const restore = stubPrisma({
    playSession: {
      findFirst: async ({ where }) => {
        queries.push(where);
        // userId is part of the lookup, so another account's row is invisible.
        return where.userId === USER_B ? null : sessionRow();
      }
    }
  });

  try {
    await assert.rejects(
      playlogService.updatePlaySession({
        userId: USER_B,
        sessionId: SESSION_ID,
        patch: { outcome: 'COMPLETED' }
      }),
      (error) => error.statusCode === 404 && error.code === 'PLAY_SESSION_NOT_FOUND'
    );

    assert.equal(queries[0].userId, USER_B, 'ownership must be part of the lookup, not a later check');
  } finally {
    restore();
    restoreTransaction();
  }
});

test('deleting another account session removes nothing and reports not found', async () => {
  const deleteFilters = [];
  const restoreTransaction = stubTransaction();
  const restore = stubPrisma({
    playSession: {
      deleteMany: async ({ where }) => {
        deleteFilters.push(where);
        return { count: where.userId === USER_A ? 1 : 0 };
      }
    }
  });

  try {
    await assert.rejects(
      playlogService.deletePlaySession({ userId: USER_B, sessionId: SESSION_ID }),
      (error) => error.statusCode === 404 && error.code === 'PLAY_SESSION_NOT_FOUND'
    );

    assert.deepEqual(deleteFilters[0], { id: SESSION_ID, userId: USER_B });

    const owned = await playlogService.deletePlaySession({ userId: USER_A, sessionId: SESSION_ID });
    assert.equal(owned.deleted, true);
  } finally {
    restore();
    restoreTransaction();
  }
});

test('a replayed delete clientMutationId does not delete twice', async () => {
  let deleteCalls = 0;
  let claimAttempts = 0;
  const restoreTransaction = stubTransaction();
  // First claim wins (one row), second conflicts (no rows).
  const restoreQueryRaw = stubQueryRaw(() => {
    claimAttempts += 1;
    return claimAttempts === 1 ? [{ id: 'receipt-1' }] : [];
  });
  const restore = stubPrisma({
    clientMutationReceipt: {
      findUnique: async () => ({ resourceId: SESSION_ID })
    },
    playSession: {
      deleteMany: async () => {
        deleteCalls += 1;
        return { count: 1 };
      }
    }
  });

  try {
    const first = await playlogService.deletePlaySession({
      userId: USER_A,
      sessionId: SESSION_ID,
      clientMutationId: CLIENT_MUTATION_ID
    });
    const second = await playlogService.deletePlaySession({
      userId: USER_A,
      sessionId: SESSION_ID,
      clientMutationId: CLIENT_MUTATION_ID
    });

    assert.equal(first.deleted, true);
    assert.equal(first.idempotentReplay, false);
    assert.equal(second.idempotentReplay, true);
    assert.equal(deleteCalls, 1, 'the second call must not reach the delete');
  } finally {
    restore();
    restoreQueryRaw();
    restoreTransaction();
  }
});

test('listing sessions always scopes to the caller and paginates on a unique total order', async () => {
  let capturedArgs = null;
  const restore = stubPrisma({
    playSession: {
      findMany: async (args) => {
        capturedArgs = args;
        return [
          sessionRow({ id: 's-1', playedAt: new Date('2026-07-15T10:00:00.000Z') }),
          sessionRow({ id: 's-2', playedAt: new Date('2026-07-14T10:00:00.000Z') }),
          sessionRow({ id: 's-3', playedAt: new Date('2026-07-13T10:00:00.000Z') })
        ];
      }
    }
  });

  try {
    const result = await playlogService.listPlaySessions({ userId: USER_A, limit: 2 });

    assert.equal(capturedArgs.where.userId, USER_A);
    assert.deepEqual(capturedArgs.orderBy, [{ playedAt: 'desc' }, { id: 'desc' }]);
    assert.equal(capturedArgs.take, 3, 'one extra row is fetched to detect a further page');
    assert.equal(result.sessions.length, 2);
    assert.ok(result.meta.nextCursor, 'a further page must expose a cursor');

    const decoded = playlogService.decodeCursor(result.meta.nextCursor);
    assert.equal(decoded.id, 's-2');
  } finally {
    restore();
  }
});

test('a malformed pagination cursor is rejected rather than silently ignored', () => {
  assert.equal(playlogService.decodeCursor(null), null);
  assert.equal(playlogService.decodeCursor(''), null);

  for (const cursor of ['not-base64!!', Buffer.from('{"v":2}', 'utf8').toString('base64url')]) {
    assert.throws(() => playlogService.decodeCursor(cursor), (error) => error.code === 'INVALID_CURSOR');
  }
});

test('a play session referencing an invisible catalog game is rejected', async () => {
  const restore = stubPrisma({
    catalogGame: {
      findUnique: async ({ where }) => ({ id: where.id, mergedIntoCatalogGameId: null }),
      // Another account's PRIVATE registration is not visible here.
      findFirst: async () => null
    }
  });

  try {
    await assert.rejects(
      playlogService.createPlaySession({
        userId: USER_A,
        input: {
          catalogGameId: CATALOG_GAME_A,
          playedAt: new Date(),
          outcome: 'CONTINUE',
          clientMutationId: CLIENT_MUTATION_ID
        }
      }),
      (error) => error.statusCode === 400 && error.code === 'CATALOG_GAME_NOT_FOUND'
    );
  } finally {
    restore();
  }
});

test('a regional release from a different game cannot be attached', async () => {
  const restore = stubPrisma({
    catalogGame: {
      findUnique: async ({ where }) => ({ id: where.id, mergedIntoCatalogGameId: null }),
      findFirst: async () => ({ id: CATALOG_GAME_A })
    },
    regionalRelease: { findFirst: async () => null }
  });

  try {
    await assert.rejects(
      playlogService.createPlaySession({
        userId: USER_A,
        input: {
          catalogGameId: CATALOG_GAME_A,
          regionalReleaseId: '00000000-0000-4000-8000-0000000000d9',
          playedAt: new Date(),
          outcome: 'CONTINUE',
          clientMutationId: CLIENT_MUTATION_ID
        }
      }),
      (error) => error.statusCode === 400 && error.code === 'REGIONAL_RELEASE_MISMATCH'
    );
  } finally {
    restore();
  }
});

test('the calendar buckets sessions into local days and never returns note bodies', async () => {
  let capturedSelect = null;
  const restore = stubPrisma({
    playSession: {
      findMany: async (args) => {
        capturedSelect = args.select;

        return [
          // 2026-07-15T22:30Z is 2026-07-16 07:30 in Asia/Seoul.
          { id: 's-1', catalogGameId: CATALOG_GAME_A, playedAt: new Date('2026-07-15T22:30:00.000Z'), durationMinutes: 60, outcome: 'CONTINUE', mood: 'FOCUSED' },
          { id: 's-2', catalogGameId: CATALOG_GAME_A, playedAt: new Date('2026-07-16T02:00:00.000Z'), durationMinutes: null, outcome: 'COMPLETED', mood: null }
        ];
      }
    }
  });

  try {
    const result = await playlogService.getPlayCalendar({
      userId: USER_A,
      month: '2026-07',
      timezone: 'Asia/Seoul'
    });

    assert.equal(capturedSelect.note, undefined, 'the calendar query must not select note');
    assert.equal(result.days.length, 31);

    const july16 = result.days.find((day) => day.date === '2026-07-16');
    assert.equal(july16.sessionCount, 2, 'both sessions land on the same local day');
    assert.equal(july16.totalMinutes, 60);
    assert.equal(july16.minutesKnown, false, 'a session without a duration is reported, not guessed');
    assert.deepEqual(july16.outcomes, { CONTINUE: 1, COMPLETED: 1 });

    const july15 = result.days.find((day) => day.date === '2026-07-15');
    assert.equal(july15.sessionCount, 0);
    assert.equal(result.summary.playedDayCount, 1);
    assert.equal(result.summary.sessionsWithoutDuration, 1);
    assert.equal(result.summary.isEmpty, false);
  } finally {
    restore();
  }
});

test('an empty month is reported explicitly rather than as an error', async () => {
  const restore = stubPrisma({ playSession: { findMany: async () => [] } });

  try {
    const result = await playlogService.getPlayCalendar({
      userId: USER_A,
      month: '2026-02',
      timezone: 'UTC'
    });

    assert.equal(result.summary.isEmpty, true);
    assert.equal(result.summary.sessionCount, 0);
    assert.equal(result.days.length, 28);
    assert.equal(result.days.every((day) => day.sessionCount === 0), true);
  } finally {
    restore();
  }
});
