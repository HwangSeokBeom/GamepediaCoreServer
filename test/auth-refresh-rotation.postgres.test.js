const assert = require('node:assert');
const { test } = require('node:test');

// PostgreSQL integration test for refresh-token rotation. Requires a disposable
// database whose name contains "test" or "audit"; skips otherwise so the default
// `npm test` run stays green without a database.
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

test('refresh rotation creates exactly one successor under concurrent requests', {
  skip: !testDatabaseName || !hasRequiredEnv
    ? 'requires DATABASE_URL pointing at a dedicated test/audit database plus JWT env vars'
    : false
}, async () => {
  const { prisma } = require('../src/config/prisma');
  const authService = require('../src/services/auth.service');

  const [{ db }] = await prisma.$queryRawUnsafe('SELECT current_database() AS db');
  assert.strictEqual(db, testDatabaseName, 'connected database must match DATABASE_URL test database');

  const session = await authService.signUp({
    email: `rotation-race-${Date.now()}@postgres.test`,
    password: 'rotation-race-password',
    nickname: `rot_${Date.now().toString(36)}`,
    deviceName: 'postgres-test-device'
  });
  const userId = session.user.id;

  try {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => authService.refresh({ refreshToken: session.tokens.refreshToken }))
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejectedCodes = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason?.code);

    assert.strictEqual(fulfilled.length, 1, 'exactly one concurrent refresh may succeed');
    assert.deepStrictEqual([...new Set(rejectedCodes)], ['TOKEN_REVOKED'], 'losers must fail with TOKEN_REVOKED');

    const activeTokens = await prisma.refreshToken.count({
      where: { userId, revokedAt: null }
    });
    assert.strictEqual(activeTokens, 1, 'exactly one active successor may exist after the race');

    const rotatedSession = fulfilled[0].value;
    assert.strictEqual(rotatedSession.user.id, userId);
    assert.ok(rotatedSession.tokens.accessToken);
    assert.ok(rotatedSession.tokens.refreshToken);

    await assert.rejects(
      authService.refresh({ refreshToken: session.tokens.refreshToken }),
      (error) => error.code === 'TOKEN_REVOKED',
      'replaying the original token must be rejected'
    );

    const secondRotation = await authService.refresh({ refreshToken: rotatedSession.tokens.refreshToken });
    assert.strictEqual(secondRotation.user.id, userId, 'successor must rotate exactly once');

    await assert.rejects(
      authService.refresh({ refreshToken: rotatedSession.tokens.refreshToken }),
      (error) => error.code === 'TOKEN_REVOKED',
      'replaying the successor must be rejected after its rotation'
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
});
