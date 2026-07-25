'use strict';

// Redaction coverage for the authentication logging surface. Runtime behavior
// (real auth flows emitting no raw credentials) is additionally asserted in
// test/auth-refresh-postgres.integration.test.js; this file pins the sanitizer
// contract and keeps console-bypass regressions out of the auth paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeLogMeta } = require('../src/utils/logger');
const { sanitizeRequestPath } = require('../src/middlewares/error.middleware');

test('sanitizer redacts every credential-bearing key used on auth paths', () => {
  const sanitized = sanitizeLogMeta({
    email: 'person@example.test',
    password: 'hunter2-hunter2',
    newPassword: 'hunter2-hunter2',
    accessToken: 'raw-access-token',
    refreshToken: 'raw-refresh-token',
    identityToken: 'raw-apple-identity-token',
    idToken: 'raw-google-id-token',
    token: 'raw-generic-token',
    stateToken: 'raw-steam-state-token',
    authorization: 'Bearer raw-bearer-value',
    authorizationCode: 'raw-apple-authorization-code',
    clientSecret: 'raw-client-secret'
  });

  for (const [key, value] of Object.entries(sanitized)) {
    assert.equal(value, '<redacted>', `key "${key}" must be redacted, got: ${value}`);
  }
});

test('sanitizer hashes identifiers and keeps operational fields readable', () => {
  const sanitized = sanitizeLogMeta({
    userId: '5f0c9a1e-0000-0000-0000-000000000000',
    subject: 'apple-subject-value',
    action: 'token_issued',
    reason: 'account_not_found',
    statusCode: 401,
    hasIdentityToken: true,
    expiresAt: '2026-07-18T00:00:00.000Z'
  });

  assert.match(sanitized.userId, /^sha256:[0-9a-f]{64}$/);
  assert.match(sanitized.subject, /^sha256:[0-9a-f]{64}$/);
  assert.equal(sanitized.action, 'token_issued');
  assert.equal(sanitized.reason, 'account_not_found');
  assert.equal(sanitized.statusCode, 401);
  assert.equal(sanitized.hasIdentityToken, true, 'boolean flags stay readable even when their name ends in "token"');
  assert.equal(sanitized.expiresAt, '2026-07-18T00:00:00.000Z');
});

test('sanitizer redacts nested provider identity payloads', () => {
  const sanitized = sanitizeLogMeta({
    context: 'apple-login',
    details: {
      email: 'person@example.test',
      identityToken: 'raw-token-value',
      code: 'APPLE_EMAIL_NOT_VERIFIED'
    }
  });

  assert.equal(sanitized.details.email, '<redacted>');
  assert.equal(sanitized.details.identityToken, '<redacted>');
  assert.equal(sanitized.details.code, 'APPLE_EMAIL_NOT_VERIFIED');
});

test('request paths with token material stay redacted in error logs', () => {
  const sanitized = sanitizeRequestPath('/auth/refresh?refresh_token=raw-secret-token&keep=1');

  assert.equal(sanitized, '/auth/refresh');
});

test('auth request and validation paths never use raw console or request URL logging', () => {
  const authSurface = [
    'src/app.js',
    'src/services/auth.service.js',
    'src/services/token.service.js',
    'src/services/apple-auth.service.js',
    'src/services/google-auth.service.js',
    'src/services/password.service.js',
    'src/routes/auth.routes.js',
    'src/controllers/auth.controller.js',
    'src/middlewares/auth.middleware.js',
    'src/middlewares/error.middleware.js',
    'src/validators/auth.validator.js'
  ];

  for (const relativePath of authSurface) {
    const source = fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
    assert.ok(
      !/console\.(log|info|warn|error|debug)/.test(source),
      `${relativePath} must not log via console (bypasses redaction)`
    );
    assert.ok(
      !/(?:(?:logger|console)\.(?:log|info|warn|error)|logSafely)\s*\([\s\S]{0,300}?(?:originalUrl|req\.url)/.test(source),
      `${relativePath} must not send a raw request URL to a logging sink`
    );
  }
});
