const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';

test('PostgreSQL permits exactly one concurrent refresh-token successor', { skip: !enabled }, async () => {
  const crypto = require('node:crypto');
  const { prisma } = require('../src/config/prisma');
  const authService = require('../src/services/auth.service');
  const tokenService = require('../src/services/token.service');

  const nonce = crypto.randomUUID();
  const user = await prisma.user.create({
    data: {
      email: `refresh-concurrency-${nonce}@example.invalid`,
      nickname: `refresh-${nonce}`.slice(0, 50),
      passwordHash: 'integration-test-not-a-real-password-hash'
    }
  });

  try {
    const original = tokenService.createTokenPair(user);
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: original.refreshTokenHash,
        expiresAt: original.refreshTokenExpiresAt,
        deviceName: 'postgres-concurrency-test'
      }
    });

    const attempts = await Promise.allSettled([
      authService.refresh({ refreshToken: original.refreshToken }),
      authService.refresh({ refreshToken: original.refreshToken })
    ]);
    const successes = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const failures = attempts.filter((attempt) => attempt.status === 'rejected');

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason.statusCode, 401);
    assert.equal(failures[0].reason.code, 'TOKEN_REVOKED');

    await assert.rejects(
      authService.refresh({ refreshToken: original.refreshToken }),
      (error) => error?.statusCode === 401 && error?.code === 'TOKEN_REVOKED'
    );

    const activeTokens = await prisma.refreshToken.findMany({
      where: { userId: user.id, revokedAt: null }
    });
    assert.equal(activeTokens.length, 1);
    assert.equal(activeTokens[0].tokenHash, tokenService.hashToken(successes[0].value.tokens.refreshToken));
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  }
});

test('refresh implementation uses a database compare-and-swap before issuing a successor', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/services/auth.service.js'), 'utf8');
  assert.match(source, /refreshToken\.updateMany/);
  assert.match(source, /revokedAt:\s*null/);
  assert.match(source, /revocation\.count !== 1/);
});
