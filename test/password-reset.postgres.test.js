const assert = require('node:assert/strict');
const { test } = require('node:test');

// PostgreSQL integration test for the password-reset flow. Requires a
// disposable database whose name contains "test" or "audit"; skips otherwise
// so the default `npm test` run stays green without a database.
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

function captureConsole() {
  const lines = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };

  for (const level of Object.keys(originals)) {
    console[level] = (...args) => {
      lines.push(args.map((value) => String(value)).join(' '));
    };
  }

  return {
    lines,
    restore() {
      for (const [level, fn] of Object.entries(originals)) {
        console[level] = fn;
      }
    }
  };
}

test('password-reset flow: hashing, expiry, single-use, enumeration resistance, HTTP contract', {
  skip: !testDatabaseName || !hasRequiredEnv
    ? 'requires DATABASE_URL pointing at a dedicated test/audit database plus JWT env vars'
    : false
}, async () => {
  const { prisma } = require('../src/config/prisma');
  const { env } = require('../src/config/env');
  const authService = require('../src/services/auth.service');
  const tokenService = require('../src/services/token.service');
  const emailService = require('../src/services/email.service');
  const userService = require('../src/modules/user/user.service');
  const { app } = require('../src/app');

  const [{ db }] = await prisma.$queryRawUnsafe('SELECT current_database() AS db');
  assert.strictEqual(db, testDatabaseName, 'connected database must match DATABASE_URL test database');

  const uniqueSuffix = `${Date.now()}-${process.pid}`;
  const email = `pw-reset-${uniqueSuffix}@postgres.test`;
  const originalPassword = 'original-pass-phrase-1';
  const newPassword = 'rotated-pass-phrase-2';

  const originalMailMode = env.mailMode;
  env.mailMode = 'log';

  const capturedMail = [];
  emailService.setMailSinkForTesting((message) => capturedMail.push(message));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const session = await authService.signUp({
    email,
    password: originalPassword,
    nickname: `pwr_${Date.now().toString(36)}`,
    deviceName: 'postgres-test-device'
  });
  const userId = session.user.id;

  try {
    // --- forgot-password over HTTP, console captured ---
    const forgotCapture = captureConsole();
    let forgotResponse;
    let unknownResponse;

    try {
      forgotResponse = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      unknownResponse = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `nobody-${uniqueSuffix}@postgres.test` })
      });
    } finally {
      forgotCapture.restore();
    }

    assert.equal(forgotResponse.status, 200);
    const forgotBody = await forgotResponse.json();
    assert.equal(forgotBody.success, true);
    assert.equal(typeof forgotBody.data.message, 'string');

    // Account-enumeration resistance: unknown email is indistinguishable.
    assert.equal(unknownResponse.status, 200);
    const unknownBody = await unknownResponse.json();
    assert.deepEqual(unknownBody, forgotBody);

    // The generated mail is inspectable via the sink, not via console.
    assert.equal(capturedMail.length, 1, 'exactly one reset mail must be generated');
    const urlMatch = capturedMail[0].text.match(/https?:\/\/\S+/);
    assert.ok(urlMatch, 'the mail body must contain the reset URL');
    const resetToken = new URL(urlMatch[0]).searchParams.get('token');
    assert.ok(resetToken && resetToken.length >= 32, 'the reset URL must carry a token');

    const forgotOutput = forgotCapture.lines.join('\n');
    assert.ok(!forgotOutput.includes(resetToken), 'console must not contain the reset token');
    assert.ok(!forgotOutput.includes(encodeURIComponent(resetToken)), 'console must not contain the encoded token');
    assert.ok(!forgotOutput.includes('reset-password'), 'console must not contain the reset URL path');
    assert.ok(!forgotOutput.includes(email), 'console must not contain the known email');
    assert.ok(!forgotOutput.includes(`nobody-${uniqueSuffix}`), 'console must not contain the unknown email');

    // --- token storage: hashed, never plaintext, expiry per TTL ---
    const storedToken = await prisma.passwordResetToken.findFirst({
      where: { userId, usedAt: null }
    });
    assert.ok(storedToken, 'an active reset token row must exist');
    assert.equal(storedToken.tokenHash, tokenService.hashToken(resetToken), 'token must be stored as sha256 hash');
    assert.notEqual(storedToken.tokenHash, resetToken, 'raw token must not be stored');

    const expectedExpiryMs = Date.now() + env.passwordResetTokenTtlMinutes * 60 * 1000;
    const expiryDriftMs = Math.abs(storedToken.expiresAt.getTime() - expectedExpiryMs);
    assert.ok(expiryDriftMs < 5 * 60 * 1000, `token expiry must honor the configured TTL (drift ${expiryDriftMs}ms)`);

    // --- reset-password over HTTP, console captured ---
    const resetCapture = captureConsole();
    let resetResponse;
    let replayResponse;

    try {
      resetResponse = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword })
      });
      replayResponse = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword })
      });
    } finally {
      resetCapture.restore();
    }

    assert.equal(resetResponse.status, 200);
    const resetBody = await resetResponse.json();
    assert.deepEqual(resetBody, { success: true, data: { passwordReset: true } });

    // Single-use: replaying the same token must fail.
    assert.equal(replayResponse.status, 400);
    const replayBody = await replayResponse.json();
    assert.equal(replayBody.success, false);
    assert.equal(replayBody.error.code, 'PASSWORD_RESET_TOKEN_USED');

    const resetOutput = resetCapture.lines.join('\n');
    assert.ok(!resetOutput.includes(resetToken), 'console must not contain the reset token');
    assert.ok(!resetOutput.includes(newPassword), 'console must not contain the new password');
    assert.ok(!resetOutput.includes(email), 'console must not contain the email');

    // --- completion behavior: new password works, old one does not ---
    const rotatedSession = await authService.login({
      email,
      password: newPassword,
      deviceName: 'postgres-test-device'
    });
    assert.equal(rotatedSession.user.id, userId);

    await assert.rejects(
      authService.login({ email, password: originalPassword, deviceName: 'postgres-test-device' }),
      (error) => error.statusCode === 401 || error.statusCode === 400,
      'the old password must be rejected after reset'
    );

    // --- profile-image upload success log no longer contains the URL ---
    const uploadCapture = captureConsole();
    const uploadedFileName = `pw-reset-scan-${uniqueSuffix}.webp`;

    try {
      await userService.updateCurrentUserProfileImage({ userId, fileName: uploadedFileName });
    } finally {
      uploadCapture.restore();
    }

    const uploadOutput = uploadCapture.lines.join('\n');
    assert.ok(
      uploadOutput.includes(`[profile-image] uploaded userId=${userId}`),
      'the sanitized upload event must be logged'
    );
    assert.ok(!uploadOutput.includes(uploadedFileName), 'console must not contain the image file name/URL');
  } finally {
    emailService.setMailSinkForTesting(null);
    env.mailMode = originalMailMode;

    await prisma.passwordResetToken.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.refreshToken.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});

    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect().catch(() => {});
  }
});
