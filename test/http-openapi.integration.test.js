const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const winston = require('winston');

const contract = require('../openapi/cross-platform.openapi.json');
const authMiddleware = require('../src/middlewares/auth.middleware');
const authService = require('../src/services/auth.service');
const userService = require('../src/modules/user/user.service');
const libraryService = require('../src/modules/library/library.service');
const pushTokenService = require('../src/modules/push/push-token.service');
const { buildLogFormatter, logger } = require('../src/utils/logger');
const { AppError } = require('../src/utils/error-response');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const FORBIDDEN_APPLE_LOG_KEY = /"(?:identityToken|authorizationCode|token|email|code|name)"/i;
const user = {
  id: USER_ID,
  email: 'contract@example.invalid',
  nickname: 'contract-user',
  profileImageUrl: null,
  status: 'ACTIVE',
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z'
};
const privacy = {
  showFriendsList: true,
  showRecentlyPlayed: true,
  showLikedGames: false,
  showReviews: true,
  isFriendsListPublic: true,
  isRecentPlayPublic: true,
  isLikedGamesPublic: false,
  isReviewsPublic: true
};
const recent = {
  games: [],
  recentGames: [],
  recentlyPlayed: [],
  recentPlayedPreview: [],
  hasMoreRecentPlayed: false
};
let capturedRecentLimit = null;
let capturedPushTokenDelete = null;

authMiddleware.authenticateAccessToken = (req, res, next) => {
  req.auth = { userId: USER_ID, email: user.email, status: user.status };
  next();
};
authService.refresh = async () => ({ user, tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' } });
authService.appleLogin = async () => ({ user, tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' } });
userService.getCurrentUserProfile = async () => ({ user, friendCount: 0, likeCount: 0, reviewCount: 0, recentlyPlayed: [], hasMoreRecentPlayed: false });
userService.getMyPrivacySettings = async () => privacy;
userService.updateMyPrivacySettings = async () => privacy;
userService.getMyRecentlyPlayedProfileGames = async ({ limit }) => {
  capturedRecentLimit = limit ?? null;
  return { games: recent.games, hasMoreRecentPlayed: false };
};
userService.getMySteamFriends = async () => ({ friends: [], steamFriendsAvailable: false, steamFriendsLimitedByPrivacy: false, syncWarningCode: 'STEAM_NOT_CONNECTED' });
userService.getMyFriendRecommendations = async () => ({ recommendations: [] });
userService.getFriendRecommendations = async () => ({ recommendations: [] });
libraryService.getMySteamLinkStatus = async () => ({
  isLinked: false,
  steamId: null,
  steamId64: null,
  displayName: null,
  personaName: null,
  avatarUrl: null,
  profileUrl: null,
  linkedAt: null,
  canSync: false,
  canDisconnect: false,
  lastSteamSyncAt: null
});
pushTokenService.registerPushToken = async () => ({ registered: true, tokenId: 'fixture-token-id' });
pushTokenService.deletePushToken = async (input) => {
  capturedPushTokenDelete = input;
  return { deactivated: true, updatedCount: 1 };
};

const { app } = require('../src/app');

function resolvePointer(pointer) {
  return pointer.replace(/^#\//, '').split('/').reduce((value, segment) => value[segment], contract);
}

function resolveSchema(schema) {
  return schema?.$ref ? resolveSchema(resolvePointer(schema.$ref)) : (schema ?? {});
}

function assertSchema(value, inputSchema, location = 'response') {
  const schema = resolveSchema(inputSchema);
  if (schema.allOf) schema.allOf.forEach((part) => assertSchema(value, part, location));
  if (schema.anyOf) {
    const matches = schema.anyOf.some((part) => {
      try {
        assertSchema(value, part, location);
        return true;
      } catch (error) {
        return false;
      }
    });
    assert.ok(matches, `${location} anyOf`);
  }
  if (Object.hasOwn(schema, 'const')) assert.equal(value, schema.const, `${location} const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location} enum`);
  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (value === null) {
    assert.ok(types.includes('null'), `${location} nullability`);
    return;
  }
  if (types.length > 0) {
    const matchesType = types.some((type) => {
      if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value);
      if (type === 'array') return Array.isArray(value);
      if (type === 'string') return typeof value === 'string';
      if (type === 'integer') return Number.isInteger(value);
      if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
      if (type === 'boolean') return typeof value === 'boolean';
      return false;
    });
    assert.ok(matchesType, `${location} type`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${location} minLength`);
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, `${location} maxLength`);
    if (schema.format === 'uuid') assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, `${location} uuid`);
    if (schema.format === 'email') assert.match(value, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, `${location} email`);
    if (schema.format === 'uri') assert.doesNotThrow(() => new URL(value), `${location} uri`);
    if (schema.format === 'date-time') assert.ok(!Number.isNaN(Date.parse(value)) && /T/.test(value), `${location} date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${location} minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${location} maximum`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.minProperties !== undefined) {
    assert.ok(Object.keys(value).length >= schema.minProperties, `${location} minProperties`);
  }
  if (schema.required) schema.required.forEach((key) => assert.ok(Object.hasOwn(value, key), `${location}.${key} required`));
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.additionalProperties === false) {
      const unexpectedKeys = Object.keys(value).filter((key) => !Object.hasOwn(schema.properties, key));
      assert.deepEqual(unexpectedKeys, [], `${location} contains undeclared properties`);
    }

    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) assertSchema(value[key], propertySchema, `${location}.${key}`);
    }
  }
  if (schema.items && Array.isArray(value)) value.forEach((item, index) => assertSchema(item, schema.items, `${location}[${index}]`));
}

function responseSchema(method, path, status) {
  const response = contract.paths[path][method].responses[String(status)];
  const resolvedResponse = response.$ref ? resolvePointer(response.$ref) : response;
  return resolvedResponse.content['application/json'].schema;
}

test('OpenAPI response checker rejects format, range and length violations', () => {
  assert.doesNotThrow(() => assertSchema([], { type: ['array', 'object', 'null'] }));
  assert.doesNotThrow(() => assertSchema({}, { type: ['array', 'object', 'null'] }));
  assert.doesNotThrow(() => assertSchema(null, { type: ['array', 'object', 'null'] }));
  assert.throws(() => assertSchema('not-a-uuid', { type: 'string', format: 'uuid' }));
  assert.throws(() => assertSchema(-1, { type: 'integer', minimum: 0 }));
  assert.throws(() => assertSchema('x', { type: 'string', minLength: 2 }));
  assert.throws(() => assertSchema({}, { type: 'object', minProperties: 1 }));
  assert.throws(() => assertSchema(
    { declared: true, unexpected: true },
    {
      type: 'object',
      additionalProperties: false,
      properties: { declared: { type: 'boolean' } }
    }
  ));
  assert.throws(() => assertSchema('other', { anyOf: [{ const: 'one' }, { const: 'two' }] }));
  assert.match('{"bodyKeys":["identityToken"]}', FORBIDDEN_APPLE_LOG_KEY);
  assert.doesNotMatch('{"credentialPresent":true}', FORBIDDEN_APPLE_LOG_KEY);
});

async function listen() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

async function request(baseUrl, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: method.toUpperCase(),
    headers: {
      authorization: 'Bearer fixture',
      connection: 'close',
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

test('actual HTTP responses satisfy the cross-platform OpenAPI schemas', async (context) => {
  const server = await listen();
  context.after(() => closeServer(server));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const health = await request(baseUrl, 'get', '/health');
  assert.equal(health.status, 200);
  assertSchema(health.payload, responseSchema('get', '/health', health.status), 'GET /health');

  const cases = [
    ['post', '/auth/refresh', { refreshToken: 'fixture-refresh' }],
    ['get', '/users/me'],
    ['get', '/users/me/privacy'],
    ['patch', '/users/me/privacy', { isFriendsListPublic: true }],
    ['get', '/users/me/privacy-settings'],
    ['patch', '/users/me/privacy-settings', { isRecentPlayPublic: false }],
    ['get', '/users/me/recently-played'],
    ['get', '/users/me/recent-plays?limit=7', undefined, '/users/me/recent-plays'],
    ['get', '/users/me/steam'],
    ['post', '/users/me/friends/steam/import'],
    ['get', '/users/me/recommendations/friends'],
    ['get', `/users/${USER_ID}/friend-recommendations`, undefined, '/users/{userId}/friend-recommendations'],
    ['put', '/users/me/push-token', { token: 'x'.repeat(4096), platform: 'ios', deviceId: 'fixture-device' }],
    ['delete', '/users/me/push-token', { deviceId: 'fixture-device' }],
    ['delete', '/users/me/push-token?deviceId=query-device', undefined, '/users/me/push-token']
  ];

  for (const [method, path, body, contractPath = path] of cases) {
    const result = await request(baseUrl, method, path, body);
    assert.equal(result.status, 200, `${method.toUpperCase()} ${path}`);
    assertSchema(result.payload, responseSchema(method, contractPath, result.status), `${method.toUpperCase()} ${path}`);
  }

  assert.equal(capturedRecentLimit, 7);
  assert.equal(capturedPushTokenDelete.deviceId, 'query-device');
  assert.equal(capturedPushTokenDelete.token, undefined);

  const conflictingDelete = await request(
    baseUrl,
    'delete',
    '/users/me/push-token?deviceId=query-device',
    { deviceId: 'body-device' }
  );
  assert.equal(conflictingDelete.status, 400);
  assert.equal(conflictingDelete.payload.error.code, 'PUSH_TOKEN_INVALID');

  const oversized = await request(baseUrl, 'put', '/users/me/push-token', { token: 'x'.repeat(4097), platform: 'ios' });
  assert.equal(oversized.status, 400);
  assertSchema(oversized.payload, responseSchema('put', '/users/me/push-token', oversized.status), 'PUT /users/me/push-token 4097');

  for (const invalidLimit of ['0', '51', '1.5', '7junk', '', '1&limit=2']) {
    const invalidRecent = await request(baseUrl, 'get', `/users/me/recent-plays?limit=${invalidLimit}`);
    assert.equal(invalidRecent.status, 400, `limit=${invalidLimit}`);
    assert.equal(invalidRecent.payload.error.code, 'INVALID_RECENT_PLAY_LIMIT');
    assertSchema(
      invalidRecent.payload,
      responseSchema('get', '/users/me/recent-plays', invalidRecent.status),
      `GET /users/me/recent-plays?limit=${invalidLimit}`
    );
  }
});

test('actual 404, error and Apple requests redact sensitive values and raw body keys at the formatted sink', async (context) => {
  const stream = new PassThrough();
  let output = '';
  stream.on('data', (chunk) => { output += chunk.toString('utf8'); });
  const transport = new winston.transports.Stream({ stream, format: buildLogFormatter() });
  logger.add(transport);
  context.after(() => {
    logger.remove(transport);
    transport.destroy();
    stream.destroy();
  });
  const server = await listen();
  context.after(() => closeServer(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sentinel = 'SENTINEL_PRIVATE_7f93';

  const missing = await request(baseUrl, 'get', `/missing?query=${sentinel}&token=${sentinel}&email=${sentinel}`);
  assert.equal(missing.status, 404);
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(output, new RegExp(sentinel, 'i'));
  assert.match(output, /path.*\/missing/);
  assert.doesNotMatch(output, /\?query=/);

  output = '';
  const originalGetCurrentUserProfile = userService.getCurrentUserProfile;
  userService.getCurrentUserProfile = async () => {
    throw new AppError(503, 'FIXTURE_FAILURE', 'Fixture failure', {
      query: sentinel,
      email: `${sentinel}@example.invalid`,
      steamId64: sentinel
    });
  };
  const failed = await request(baseUrl, 'get', '/users/me');
  userService.getCurrentUserProfile = originalGetCurrentUserProfile;
  assert.equal(failed.status, 503);
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(output, new RegExp(sentinel, 'i'));
  assert.match(output, /FIXTURE_FAILURE/);

  output = '';
  userService.getCurrentUserProfile = async () => {
    throw new AppError(400, 'FIXTURE_BAD_REQUEST', 'Fixture bad request', { prompt: sentinel, token: sentinel });
  };
  const badRequest = await request(baseUrl, 'get', '/users/me');
  userService.getCurrentUserProfile = originalGetCurrentUserProfile;
  assert.equal(badRequest.status, 400);
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(output, new RegExp(sentinel, 'i'));
  assert.match(output, /FIXTURE_BAD_REQUEST/);

  const appleOutputStart = output.length;
  const apple = await request(baseUrl, 'post', `/auth/apple?authorizationCode=${sentinel}`, {
    identityToken: sentinel,
    authorizationCode: sentinel,
    token: sentinel,
    email: `${sentinel}@example.invalid`,
    code: sentinel,
    name: sentinel
  });
  assert.equal(apple.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  const appleOutput = output.slice(appleOutputStart);

  assert.doesNotMatch(appleOutput, new RegExp(sentinel, 'i'));
  assert.doesNotMatch(appleOutput, FORBIDDEN_APPLE_LOG_KEY);
  assert.doesNotMatch(appleOutput, /\?authorizationCode=/);
  assert.match(appleOutput, /"credentialPresent":true/);
  assert.match(appleOutput, /"exchangeCredentialPresent":true/);
  assert.match(appleOutput, /"accountHintPresent":false/);
});
