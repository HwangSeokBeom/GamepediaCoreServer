const assert = require('node:assert');
const { test } = require('node:test');

// PostgreSQL integration tests for the atomic library-status mutation.
// Requires a disposable database whose name contains "test" or "audit"; skips
// otherwise so the default `npm test` run stays green without a database.
function resolveTestDatabaseName() {
  const rawUrl = process.env.DATABASE_URL;

  if (!rawUrl) {
    return null;
  }

  try {
    const databaseName = new URL(rawUrl).pathname.replace(/^\//, '');
    return /test|audit/i.test(databaseName) ? databaseName : null;
  } catch (error) {
    return null;
  }
}

const REQUIRED_ENV = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ACCESS_TOKEN_EXPIRES_IN',
  'REFRESH_TOKEN_EXPIRES_IN'
];

const testDatabaseName = resolveTestDatabaseName();
const hasRequiredEnv = REQUIRED_ENV.every((name) => typeof process.env[name] === 'string' && process.env[name].trim());
const skipReason = !testDatabaseName || !hasRequiredEnv
  ? 'requires DATABASE_URL pointing at a dedicated test/audit database plus JWT env vars'
  : false;

function requireHarness() {
  const { GameSource, GameLibraryStatus } = require('@prisma/client');
  const { prisma } = require('../src/config/prisma');
  const authService = require('../src/services/auth.service');
  const libraryService = require('../src/modules/library/library.service');
  const { runWithLibraryRequestContext } = require('../src/modules/library/library-request-context');

  return { GameSource, GameLibraryStatus, prisma, authService, libraryService, runWithLibraryRequestContext };
}

async function signUpUser(authService, label) {
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const session = await authService.signUp({
    email: `${label}-${marker}@library.postgres.test`,
    password: 'library-test-password',
    nickname: `${label.slice(0, 6)}_${marker.slice(-9)}`,
    deviceName: 'postgres-test-device'
  });

  return session.user;
}

function writeStatus(harness, { userId, externalGameId, status }) {
  return harness.runWithLibraryRequestContext(() => harness.libraryService.updateLibraryStatus({
    userId,
    source: 'igdb',
    externalGameId,
    title: `Concurrency Game ${externalGameId}`,
    coverUrl: null,
    status
  }));
}

test('two concurrent identical first writes both succeed with a single row', { skip: skipReason }, async () => {
  const harness = requireHarness();
  const { GameSource, GameLibraryStatus, prisma, authService } = harness;
  const user = await signUpUser(authService, 'race');

  try {
    // Repeat the race several times: the pre-fix code intermittently returned
    // a spurious 409 whenever both writers observed the missing row.
    for (let round = 0; round < 6; round += 1) {
      const externalGameId = `9000${round}`;
      const results = await Promise.allSettled([
        writeStatus(harness, { userId: user.id, externalGameId, status: 'playing' }),
        writeStatus(harness, { userId: user.id, externalGameId, status: 'playing' })
      ]);

      const rejected = results.filter((result) => result.status === 'rejected');
      assert.strictEqual(rejected.length, 0, `no spurious conflict may surface (round ${round}): ${rejected.map((r) => r.reason?.message).join(', ')}`);

      for (const result of results) {
        assert.strictEqual(result.value.libraryEntry.status, 'playing');
      }

      const rows = await prisma.userGameLibrary.findMany({
        where: { userId: user.id, gameSource: GameSource.IGDB, externalGameId }
      });

      assert.strictEqual(rows.length, 1, 'exactly one row may exist after the race');
      assert.strictEqual(rows[0].status, GameLibraryStatus.PLAYING);
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('two concurrent different first writes resolve by commit order without failures', { skip: skipReason }, async () => {
  const harness = requireHarness();
  const { GameSource, GameLibraryStatus, prisma, authService } = harness;
  const user = await signUpUser(authService, 'diverge');
  const externalGameId = '91001';

  try {
    const results = await Promise.allSettled([
      writeStatus(harness, { userId: user.id, externalGameId, status: 'playing' }),
      writeStatus(harness, { userId: user.id, externalGameId, status: 'completed' })
    ]);

    assert.strictEqual(results.filter((result) => result.status === 'rejected').length, 0, 'divergent concurrent writes must not fail');

    for (const result of results) {
      assert.ok(['playing', 'completed'].includes(result.value.libraryEntry.status), 'every response must reflect a committed state');
    }

    const rows = await prisma.userGameLibrary.findMany({
      where: { userId: user.id, gameSource: GameSource.IGDB, externalGameId }
    });

    assert.strictEqual(rows.length, 1);
    assert.ok([GameLibraryStatus.PLAYING, GameLibraryStatus.COMPLETED].includes(rows[0].status), 'the committed row must hold one of the requested states');

    // A later retry converges to the requested absolute state.
    const converged = await writeStatus(harness, { userId: user.id, externalGameId, status: 'completed' });
    assert.strictEqual(converged.libraryEntry.status, 'completed');

    const convergedRow = await prisma.userGameLibrary.findFirst({
      where: { userId: user.id, gameSource: GameSource.IGDB, externalGameId }
    });
    assert.strictEqual(convergedRow.status, GameLibraryStatus.COMPLETED);
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('retrying after a success (or lost response) is idempotent and updates existing rows', { skip: skipReason }, async () => {
  const harness = requireHarness();
  const { GameSource, prisma, authService } = harness;
  const user = await signUpUser(authService, 'retry');
  const externalGameId = '92001';

  try {
    const first = await writeStatus(harness, { userId: user.id, externalGameId, status: 'playing' });
    // A client that lost the response replays the same absolute state.
    const replay = await writeStatus(harness, { userId: user.id, externalGameId, status: 'playing' });

    assert.strictEqual(first.libraryEntry.status, 'playing');
    assert.strictEqual(replay.libraryEntry.status, 'playing');

    // A genuine follow-up mutation updates the existing row in place.
    const updated = await writeStatus(harness, { userId: user.id, externalGameId, status: 'completed' });
    assert.strictEqual(updated.libraryEntry.status, 'completed');

    const rows = await prisma.userGameLibrary.findMany({
      where: { userId: user.id, gameSource: GameSource.IGDB, externalGameId }
    });

    assert.strictEqual(rows.length, 1, 'replays and updates must never duplicate the row');
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('accounts stay isolated: the same game for two users produces independent rows', { skip: skipReason }, async () => {
  const harness = requireHarness();
  const { GameSource, GameLibraryStatus, prisma, authService } = harness;
  const userA = await signUpUser(authService, 'isolate-a');
  const userB = await signUpUser(authService, 'isolate-b');
  const externalGameId = '93001';

  try {
    const [resultA, resultB] = await Promise.all([
      writeStatus(harness, { userId: userA.id, externalGameId, status: 'playing' }),
      writeStatus(harness, { userId: userB.id, externalGameId, status: 'dropped' })
    ]);

    assert.strictEqual(resultA.libraryEntry.status, 'playing');
    assert.strictEqual(resultB.libraryEntry.status, 'dropped');

    const rowA = await prisma.userGameLibrary.findUnique({
      where: {
        userId_gameSource_externalGameId: {
          userId: userA.id,
          gameSource: GameSource.IGDB,
          externalGameId
        }
      }
    });
    const rowB = await prisma.userGameLibrary.findUnique({
      where: {
        userId_gameSource_externalGameId: {
          userId: userB.id,
          gameSource: GameSource.IGDB,
          externalGameId
        }
      }
    });

    assert.strictEqual(rowA.status, GameLibraryStatus.PLAYING);
    assert.strictEqual(rowB.status, GameLibraryStatus.DROPPED);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  }
});
