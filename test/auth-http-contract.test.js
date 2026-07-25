'use strict';

// HTTP-level contract tests for the auth endpoints: shared envelope, stable
// error codes, and parity with openapi/cross-platform.openapi.json. Prisma is
// stubbed (no database); rotation ATOMICITY is proven separately by
// test/auth-refresh-postgres.integration.test.js against real PostgreSQL.

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { Prisma } = require('@prisma/client');
const { env } = require('../src/config/env');
const { prisma } = require('../src/config/prisma');
const { app } = require('../src/app');
const tokenService = require('../src/services/token.service');
const passwordService = require('../src/services/password.service');
const openApiSpec = require('../openapi/cross-platform.openapi.json');

const realFetch = global.fetch;

let server;
let baseUrl;
let passwordHash;

const USER_ID = crypto.randomUUID();
const OTHER_USER_ID = crypto.randomUUID();
const USER_ROW = () => ({
  id: USER_ID,
  email: 'contract-user@example.test',
  passwordHash,
  passwordAuthEnabled: true,
  nickname: 'contract_user',
  profileImageUrl: null,
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z')
});

const stubbed = [];

function stub(object, method, implementation) {
  stubbed.push({ object, method, original: object[method] });
  object[method] = implementation;
}

function restoreStubs() {
  while (stubbed.length > 0) {
    const { object, method, original } = stubbed.pop();
    object[method] = original;
  }
}

function fakeTx({ claimCount = 1 } = {}) {
  return {
    refreshToken: {
      create: async ({ data }) => ({ id: crypto.randomUUID(), ...data }),
      updateMany: async () => ({ count: claimCount }),
      deleteMany: async () => ({ count: 0 })
    },
    user: {
      create: async ({ data }) => ({ ...USER_ROW(), ...data }),
      update: async ({ data }) => ({ ...USER_ROW(), ...data }),
      findUnique: async () => USER_ROW(),
      delete: async () => USER_ROW()
    },
    passwordResetToken: {
      updateMany: async () => ({ count: 1 }),
      create: async ({ data }) => ({ id: crypto.randomUUID(), ...data })
    }
  };
}

function signRefreshJwt(subject = USER_ID) {
  return jwt.sign({ sub: subject, type: 'refresh' }, env.jwtRefreshSecret, {
    expiresIn: '30d',
    jwtid: crypto.randomUUID()
  });
}

function signAccessJwt(subject = USER_ID) {
  return jwt.sign({ sub: subject, email: 'contract-user@example.test', type: 'access' }, env.jwtAccessSecret, {
    expiresIn: '10m'
  });
}

function refreshTokenRow(rawToken, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    userId: USER_ID,
    tokenHash: tokenService.hashToken(rawToken),
    deviceName: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    createdAt: new Date(),
    user: USER_ROW(),
    ...overrides
  };
}

async function post(path, body) {
  const response = await realFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function get(path, headers = {}) {
  const response = await realFetch(`${baseUrl}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

function resolveRef(schema) {
  if (schema && schema.$ref) {
    const parts = schema.$ref.replace(/^#\//, '').split('/');
    return resolveRef(parts.reduce((node, part) => node[part], openApiSpec));
  }
  return schema;
}

function assertMatchesSchema(value, schema, contextPath) {
  const resolved = resolveRef(schema);

  if (!resolved || typeof resolved !== 'object') {
    return;
  }

  if (resolved.const !== undefined) {
    assert.equal(value, resolved.const, `${contextPath} must equal declared const`);
  }

  if (resolved.type === 'object' || (Array.isArray(resolved.required) && resolved.properties)) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${contextPath} must be an object`);

    for (const requiredKey of resolved.required ?? []) {
      assert.ok(requiredKey in value, `${contextPath}.${requiredKey} is required by the OpenAPI contract`);
    }

    for (const [key, childSchema] of Object.entries(resolved.properties ?? {})) {
      if (key in value && value[key] !== null) {
        assertMatchesSchema(value[key], childSchema, `${contextPath}.${key}`);
      }
    }
  }
}

function specResponseSchema(pathKey, method, status) {
  const operation = openApiSpec.paths[pathKey]?.[method];
  assert.ok(operation, `OpenAPI spec must define ${method.toUpperCase()} ${pathKey}`);
  const response = operation.responses?.[String(status)];
  assert.ok(response, `OpenAPI spec must define status ${status} for ${method.toUpperCase()} ${pathKey}`);
  return response.content['application/json'].schema;
}

function assertErrorEnvelope(body, expectedCode) {
  assert.equal(body.success, false);
  assert.ok(body.error && typeof body.error === 'object');
  assert.equal(typeof body.error.code, 'string');
  assert.equal(typeof body.error.message, 'string');
  if (expectedCode) {
    assert.equal(body.error.code, expectedCode);
  }
  assertMatchesSchema(body, { $ref: '#/components/schemas/ErrorResponse' }, 'errorEnvelope');
}

test.before(async () => {
  passwordHash = await passwordService.hashPassword('contract-password-1');
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  global.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

test.afterEach(() => {
  restoreStubs();
});

test('OpenAPI contract declares every auth endpoint exposed by the server', () => {
  const expected = [
    ['/auth/signup', 'post'],
    ['/auth/login', 'post'],
    ['/auth/apple', 'post'],
    ['/auth/google', 'post'],
    ['/auth/refresh', 'post'],
    ['/auth/logout', 'post'],
    ['/auth/forgot-password', 'post'],
    ['/auth/reset-password', 'post'],
    ['/auth/me', 'get'],
    ['/auth/me', 'delete']
  ];

  for (const [pathKey, method] of expected) {
    assert.ok(openApiSpec.paths[pathKey]?.[method], `spec missing ${method.toUpperCase()} ${pathKey}`);
  }

  const refreshDescription = JSON.stringify(openApiSpec.paths['/auth/refresh'].post.responses['401']);
  assert.match(refreshDescription, /TOKEN_REVOKED/, 'replay contract must stay documented as TOKEN_REVOKED');
});

test('POST /auth/login success returns the shared envelope with user and token pair', async () => {
  stub(prisma.user, 'findUnique', async () => USER_ROW());
  stub(prisma, '$transaction', async (callback) => callback(fakeTx()));

  const { status, body } = await post('/auth/login', {
    email: 'contract-user@example.test',
    password: 'contract-password-1',
    deviceName: 'contract-device'
  });

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.data).sort(), ['tokens', 'user']);
  assert.deepEqual(
    Object.keys(body.data.user).sort(),
    ['createdAt', 'email', 'id', 'nickname', 'profileImageUrl', 'status', 'updatedAt']
  );
  assert.equal(typeof body.data.tokens.accessToken, 'string');
  assert.equal(typeof body.data.tokens.refreshToken, 'string');
  assert.match(body.data.user.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/, 'dates must serialize as ISO-8601 UTC');
  assertMatchesSchema(body, specResponseSchema('/auth/login', 'post', 200), 'login.200');
});

test('POST /auth/login rejects bad credentials without revealing account existence', async () => {
  stub(prisma.user, 'findUnique', async () => null);

  const unknownAccount = await post('/auth/login', {
    email: 'nobody@example.test',
    password: 'contract-password-1'
  });

  assert.equal(unknownAccount.status, 401);
  assertErrorEnvelope(unknownAccount.body, 'INVALID_CREDENTIALS');

  restoreStubs();
  stub(prisma.user, 'findUnique', async () => USER_ROW());

  const wrongPassword = await post('/auth/login', {
    email: 'contract-user@example.test',
    password: 'wrong-password-99'
  });

  assert.equal(wrongPassword.status, 401);
  assertErrorEnvelope(wrongPassword.body, 'INVALID_CREDENTIALS');
  assert.deepEqual(unknownAccount.body.error, wrongPassword.body.error, 'unknown email and wrong password must be indistinguishable');
});

test('POST /auth/signup maps only email P2002 targets to EMAIL_ALREADY_IN_USE', async () => {
  const targets = [
    ['email'],
    'email',
    'User_email_key'
  ];

  for (const target of targets) {
    restoreStubs();
    stub(prisma.user, 'findUnique', async () => null);
    stub(prisma.user, 'findFirst', async () => null);
    stub(prisma, '$transaction', async () => {
      throw new Prisma.PrismaClientKnownRequestError('fixture email uniqueness race', {
        code: 'P2002',
        clientVersion: 'fixture',
        meta: { target }
      });
    });

    const result = await post('/auth/signup', {
      email: 'concurrent-signup@example.test',
      password: 'contract-password-1',
      nickname: 'concurrent-signup'
    });

    assert.equal(result.status, 409);
    assertErrorEnvelope(result.body, 'EMAIL_ALREADY_IN_USE');
    assert.doesNotMatch(JSON.stringify(result.body), /P2002|Prisma|Unique constraint/i);
  }

  restoreStubs();
  stub(prisma.user, 'findUnique', async () => null);
  stub(prisma.user, 'findFirst', async () => null);
  stub(prisma, '$transaction', async () => {
    throw new Prisma.PrismaClientKnownRequestError('fixture unrelated uniqueness race', {
      code: 'P2002',
      clientVersion: 'fixture',
      meta: { target: 'User_externalId_key' }
    });
  });

  const unrelated = await post('/auth/signup', {
    email: 'unrelated-constraint@example.test',
    password: 'contract-password-1',
    nickname: 'unrelated-constraint'
  });

  assert.equal(unrelated.status, 409);
  assertErrorEnvelope(unrelated.body, 'CONFLICT');

  restoreStubs();
  stub(prisma.user, 'findUnique', async () => null);
  stub(prisma.user, 'findFirst', async () => null);
  stub(prisma, '$transaction', async () => {
    throw new Prisma.PrismaClientKnownRequestError('fixture nickname uniqueness race', {
      code: 'P2002',
      clientVersion: 'fixture',
      meta: { target: 'User_nickname_key' }
    });
  });

  const nicknameConflict = await post('/auth/signup', {
    email: 'nickname-constraint@example.test',
    password: 'contract-password-1',
    nickname: 'nickname-constraint'
  });

  assert.equal(nicknameConflict.status, 409);
  assertErrorEnvelope(nicknameConflict.body, 'NICKNAME_ALREADY_EXISTS');
});

test('POST /auth/refresh success returns user plus rotated pair and matches the spec', async () => {
  const rawToken = signRefreshJwt();
  stub(prisma.refreshToken, 'findUnique', async () => refreshTokenRow(rawToken));
  stub(prisma, '$transaction', async (callback) => callback(fakeTx()));

  const { status, body } = await post('/auth/refresh', { refreshToken: rawToken });

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.user, 'refresh success must include the user');
  assert.ok(body.data.tokens.accessToken && body.data.tokens.refreshToken, 'refresh success must include the rotated pair');
  assert.notEqual(body.data.tokens.refreshToken, rawToken);
  assertMatchesSchema(body, specResponseSchema('/auth/refresh', 'post', 200), 'refresh.200');
});

test('POST /auth/refresh returns TOKEN_REVOKED when the compare-and-swap claim loses', async () => {
  const rawToken = signRefreshJwt();
  stub(prisma.refreshToken, 'findUnique', async () => refreshTokenRow(rawToken));
  stub(prisma, '$transaction', async (callback) => callback(fakeTx({ claimCount: 0 })));

  const { status, body } = await post('/auth/refresh', { refreshToken: rawToken });

  assert.equal(status, 401);
  assertErrorEnvelope(body, 'TOKEN_REVOKED');
});

test('POST /auth/refresh returns TOKEN_REVOKED for an already-revoked token', async () => {
  const rawToken = signRefreshJwt();
  stub(prisma.refreshToken, 'findUnique', async () => refreshTokenRow(rawToken, { revokedAt: new Date() }));

  const { status, body } = await post('/auth/refresh', { refreshToken: rawToken });

  assert.equal(status, 401);
  assertErrorEnvelope(body, 'TOKEN_REVOKED');
});

test('POST /auth/refresh maps token failures to stable codes', async () => {
  const garbage = await post('/auth/refresh', { refreshToken: 'not-a-jwt' });
  assert.equal(garbage.status, 401);
  assertErrorEnvelope(garbage.body, 'UNAUTHORIZED');

  const expired = await post('/auth/refresh', {
    refreshToken: jwt.sign({ sub: USER_ID, type: 'refresh' }, env.jwtRefreshSecret, { expiresIn: '-1s' })
  });
  assert.equal(expired.status, 401);
  assertErrorEnvelope(expired.body, 'TOKEN_EXPIRED');

  const wrongType = await post('/auth/refresh', {
    refreshToken: jwt.sign({ sub: USER_ID, type: 'access' }, env.jwtRefreshSecret, { expiresIn: '10m' })
  });
  assert.equal(wrongType.status, 401);
  assertErrorEnvelope(wrongType.body, 'UNAUTHORIZED');

  const subjectMismatch = signRefreshJwt(OTHER_USER_ID);
  stub(prisma.refreshToken, 'findUnique', async () => refreshTokenRow(subjectMismatch, { userId: USER_ID }));
  const mismatch = await post('/auth/refresh', { refreshToken: subjectMismatch });
  assert.equal(mismatch.status, 401);
  assertErrorEnvelope(mismatch.body, 'UNAUTHORIZED');

  const missingBody = await post('/auth/refresh', {});
  assert.equal(missingBody.status, 400);
  assertErrorEnvelope(missingBody.body, 'VALIDATION_ERROR');
});

test('POST /auth/refresh rejects inactive users with a stable code', async () => {
  const rawToken = signRefreshJwt();
  stub(prisma.refreshToken, 'findUnique', async () => refreshTokenRow(rawToken, {
    user: { ...USER_ROW(), status: 'INACTIVE' }
  }));

  const { status, body } = await post('/auth/refresh', { refreshToken: rawToken });

  assert.equal(status, 403);
  assertErrorEnvelope(body, 'ACCOUNT_INACTIVE');
});

test('POST /auth/logout is idempotent from the client perspective', async () => {
  const revocationQueries = [];
  const refreshToken = signRefreshJwt();
  stub(prisma.refreshToken, 'updateMany', async (query) => {
    revocationQueries.push(query);
    return { count: revocationQueries.length === 1 ? 1 : 0 };
  });

  const first = await post('/auth/logout', { refreshToken });
  const second = await post('/auth/logout', { refreshToken });
  const unknown = await post('/auth/logout', { refreshToken: 'completely-unknown-token' });

  for (const { status, body } of [first, second, unknown]) {
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, data: { loggedOut: true } });
    assertMatchesSchema(body, specResponseSchema('/auth/logout', 'post', 200), 'logout.200');
  }
  assert.equal(revocationQueries.length, 3);
  assert.equal(revocationQueries[0].where.tokenHash, tokenService.hashToken(refreshToken));
  assert.equal(revocationQueries[1].where.tokenHash, revocationQueries[0].where.tokenHash);
  assert.notEqual(revocationQueries[2].where.tokenHash, revocationQueries[0].where.tokenHash);
  assert.deepEqual(Object.keys(revocationQueries[0].where).sort(), ['revokedAt', 'tokenHash']);
});

test('GET /auth/me authenticates a bearer access token and returns the user envelope', async () => {
  stub(prisma.user, 'findUnique', async () => USER_ROW());

  const { status, body } = await get('/auth/me', { authorization: `Bearer ${signAccessJwt()}` });

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assertMatchesSchema(body, specResponseSchema('/auth/me', 'get', 200), 'me.200');

  const missingHeader = await get('/auth/me');
  assert.equal(missingHeader.status, 401);
  assertErrorEnvelope(missingHeader.body, 'UNAUTHORIZED');

  const refreshAsAccess = await get('/auth/me', { authorization: `Bearer ${signRefreshJwt()}` });
  assert.equal(refreshAsAccess.status, 401);
  assertErrorEnvelope(refreshAsAccess.body, 'UNAUTHORIZED');
});

test('GET /auth/me returns ACCOUNT_NOT_FOUND after the account is deleted', async () => {
  stub(prisma.user, 'findUnique', async () => null);

  const { status, body } = await get('/auth/me', { authorization: `Bearer ${signAccessJwt()}` });

  assert.equal(status, 404);
  assertErrorEnvelope(body, 'ACCOUNT_NOT_FOUND');
});

test('validation errors never leak internals and deviceName stays optional but bounded', async () => {
  stub(prisma.user, 'findUnique', async () => USER_ROW());
  stub(prisma, '$transaction', async (callback) => callback(fakeTx()));

  const oversizedDevice = await post('/auth/login', {
    email: 'contract-user@example.test',
    password: 'contract-password-1',
    deviceName: 'x'.repeat(101)
  });
  assert.equal(oversizedDevice.status, 400);
  assertErrorEnvelope(oversizedDevice.body, 'VALIDATION_ERROR');

  const withoutDevice = await post('/auth/login', {
    email: 'contract-user@example.test',
    password: 'contract-password-1'
  });
  assert.equal(withoutDevice.status, 200);

  const serialized = JSON.stringify(oversizedDevice.body);
  for (const forbidden of ['Prisma', 'SELECT ', 'node_modules', '/Users/', ' at ']) {
    assert.ok(!serialized.includes(forbidden), `error responses must not leak internals (${forbidden})`);
  }
});

test('unexpected internal failures return the sanitized shared envelope', async () => {
  stub(prisma.user, 'findUnique', async () => {
    const error = new Error('SELECT * FROM users WHERE secret; at /Users/nobody/app/service.js');
    error.stack = 'Error: boom\n    at /Users/nobody/app/service.js:1:1';
    throw error;
  });

  const { status, body } = await post('/auth/login', {
    email: 'contract-user@example.test',
    password: 'contract-password-1'
  });

  assert.equal(status, 500);
  assertErrorEnvelope(body, 'INTERNAL_SERVER_ERROR');
  const serialized = JSON.stringify(body);
  for (const forbidden of ['SELECT', '/Users/', 'stack', 'service.js']) {
    assert.ok(!serialized.includes(forbidden), `internal error responses must not leak ${forbidden}`);
  }
});
