const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contractPath = path.resolve(process.cwd(), 'openapi/cross-platform.openapi.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const routeSources = [
  'src/routes/auth.routes.js',
  'src/modules/user/user.routes.js',
  'src/modules/library/library.routes.js'
].map((file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')).join('\n');

function resolveSchema(schema) {
  if (!schema?.$ref) return schema ?? {};
  const segments = schema.$ref.replace(/^#\//, '').split('/');
  return segments.reduce((value, segment) => value[segment], contract);
}

function assertSchema(value, inputSchema, location = 'fixture') {
  const schema = resolveSchema(inputSchema);
  if (schema.allOf) {
    for (const part of schema.allOf) assertSchema(value, part, location);
  }
  if (Object.hasOwn(schema, 'const')) assert.equal(value, schema.const, `${location} const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location} enum`);
  const allowedTypes = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (value === null) {
    assert.ok(allowedTypes.includes('null'), `${location} nullability`);
    return;
  }
  if (allowedTypes.includes('object')) assert.equal(typeof value, 'object', `${location} object`);
  if (allowedTypes.includes('array')) assert.ok(Array.isArray(value), `${location} array`);
  if (allowedTypes.includes('string')) assert.equal(typeof value, 'string', `${location} string`);
  if (allowedTypes.includes('integer')) assert.ok(Number.isInteger(value), `${location} integer`);
  if (allowedTypes.includes('boolean')) assert.equal(typeof value, 'boolean', `${location} boolean`);
  if (schema.required) {
    for (const key of schema.required) assert.ok(Object.hasOwn(value, key), `${location}.${key} required`);
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.additionalProperties === false) {
      const unexpectedKeys = Object.keys(value).filter((key) => !Object.hasOwn(schema.properties, key));
      assert.deepEqual(unexpectedKeys, [], `${location} contains undeclared properties`);
    }

    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) assertSchema(value[key], propertySchema, `${location}.${key}`);
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => assertSchema(item, schema.items, `${location}[${index}]`));
  }
}

function responseSchema(name) {
  return contract.components.responses[name].content['application/json'].schema;
}

const requiredOperations = [
  ['get', '/health'],
  ['post', '/auth/refresh'],
  ['get', '/users/me'],
  ['get', '/users/me/privacy'],
  ['patch', '/users/me/privacy'],
  ['get', '/users/me/privacy-settings'],
  ['patch', '/users/me/privacy-settings'],
  ['get', '/users/me/recently-played'],
  ['get', '/users/me/recent-plays'],
  ['get', '/users/me/steam'],
  ['post', '/users/me/friends/steam/import'],
  ['get', '/users/me/recommendations/friends'],
  ['get', '/users/{userId}/friend-recommendations'],
  ['put', '/users/me/push-token'],
  ['post', '/users/me/push-token'],
  ['delete', '/users/me/push-token']
];

test('cross-platform OpenAPI subset declares every gate operation', () => {
  assert.equal(contract.openapi, '3.1.0');
  for (const [method, route] of requiredOperations) {
    assert.ok(contract.paths[route]?.[method], `${method.toUpperCase()} ${route} missing from contract`);
  }
  assert.match(contract.info.description, /not the complete backend API/i);
});

test('authenticated cross-platform operations declare 401 responses', () => {
  for (const [method, route] of requiredOperations) {
    if (route === '/health' || route === '/auth/refresh') continue;
    assert.ok(contract.paths[route][method].responses['401'], `${method.toUpperCase()} ${route} must declare 401`);
  }
});

test('contract gate operations are registered by canonical Express routers', () => {
  for (const [method, route] of requiredOperations) {
    if (route === '/health') {
      assert.match(fs.readFileSync(path.resolve(process.cwd(), 'src/app.js'), 'utf8'), /app\.get\('\/health'/);
      continue;
    }
    const routerPath = route.replace('{userId}', ':userId').replace(/^\/auth/, '') || '/';
    assert.ok(
      routeSources.includes(`router.${method}('${routerPath}'`) || routeSources.includes(`router.${method}(\n  '${routerPath}'`),
      `${method.toUpperCase()} ${route} not found in canonical route source`
    );
  }
});

test('compatibility aliases are deprecated and representative fixtures match shared envelopes', () => {
  assert.equal(contract.paths['/users/me/recent-plays'].get.deprecated, true);
  assert.equal(contract.paths['/users/me/privacy-settings'].get.deprecated, true);
  const privacy = { success: true, data: { showFriendsList: true, showRecentlyPlayed: false, showLikedGames: true, showReviews: true, isFriendsListPublic: true, isRecentPlayPublic: false, isLikedGamesPublic: true, isReviewsPublic: true } };
  const recent = { success: true, data: { games: [], recentGames: [], recentlyPlayed: [], recentPlayedPreview: [], hasMoreRecentPlayed: false } };
  assertSchema(privacy, responseSchema('PrivacySuccess'), 'privacy');
  assertSchema(recent, responseSchema('RecentPlaySuccess'), 'recent');
  assert.equal(privacy.data.showRecentlyPlayed, privacy.data.isRecentPlayPublic);
  assert.deepEqual(recent.data.games, recent.data.recentGames);
});

test('representative auth, Steam, recommendation and push fixtures satisfy concrete response schemas', () => {
  const user = { id: '00000000-0000-4000-8000-000000000001', email: 'test@example.invalid', nickname: 'tester', profileImageUrl: null, status: 'ACTIVE', createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z' };
  assertSchema({ success: true, data: { user, tokens: { accessToken: 'access', refreshToken: 'refresh' } } }, responseSchema('RefreshSuccess'), 'refresh');
  assertSchema({ success: true, data: { user, friendCount: 0, likeCount: 0, reviewCount: 0, recentlyPlayed: [], hasMoreRecentPlayed: false } }, responseSchema('ProfileSuccess'), 'profile');
  assertSchema({ success: true, data: { friends: [], steamFriendsAvailable: false, steamFriendsLimitedByPrivacy: false, syncWarningCode: 'STEAM_NOT_CONNECTED' } }, responseSchema('SteamFriendImportSuccess'), 'steamImport');
  assertSchema({ success: true, data: { registered: true } }, responseSchema('PushRegistrationSuccess'), 'pushRegister');
  assertSchema({ success: true, data: { deactivated: true, updatedCount: 0 } }, responseSchema('PushDeleteSuccess'), 'pushDelete');
  assertSchema({ success: true, data: { recommendations: [{ game: {}, reason: null }] } }, responseSchema('RecommendationSuccess'), 'recommendation');
  assertSchema({ success: false, error: { code: 'TOKEN_REVOKED', message: 'Refresh token has already been revoked' } }, responseSchema('Error'), 'error');
});

test('push-token ownership migration blocks legacy writes through constraint installation', () => {
  const migration = fs.readFileSync(path.resolve(
    process.cwd(),
    'prisma/migrations/20260713090000_make_push_token_globally_unique/migration.sql'
  ), 'utf8');
  const lockIndex = migration.indexOf('LOCK TABLE "user_push_tokens" IN SHARE ROW EXCLUSIVE MODE');
  const deleteIndex = migration.indexOf('DELETE FROM "user_push_tokens"');
  const backfillIndex = migration.indexOf('SET "token_hash" = encode(sha256');
  const uniqueIndex = migration.indexOf('CREATE UNIQUE INDEX "user_push_tokens_token_hash_key"');

  assert.match(migration, /BEGIN;/);
  assert.ok(lockIndex >= 0 && lockIndex < backfillIndex);
  assert.ok(backfillIndex < deleteIndex);
  assert.ok(deleteIndex < uniqueIndex);
  assert.match(migration, /COUNT\(DISTINCT "token"\) > 1/);
  assert.match(migration, /ALTER COLUMN "token_hash" SET NOT NULL/);
  assert.doesNotMatch(migration, /CREATE EXTENSION/i);
  assert.match(migration, /COMMIT;/);
});

test('PostgreSQL verification command delegates to the isolated executable gate', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  const command = packageJson.scripts['test:postgres'];
  const gate = fs.readFileSync(path.resolve(process.cwd(), 'scripts/test/run-auth-postgres-gate.sh'), 'utf8');

  assert.equal(command, 'bash scripts/test/run-auth-postgres-gate.sh');
  assert.match(gate, /--publish "127\.0\.0\.1::5432"/);
  assert.match(gate, /prisma generate/);
  assert.match(gate, /prisma migrate deploy/);
  assert.match(gate, /SELECT current_database\(\)/);
  assert.match(
    gate,
    /active_database="\$\(docker exec[\s\S]*SELECT current_database\(\);[\s\S]*\|\| true\)"[\s\S]*if \[\[ "\$active_database" == "\$DATABASE_NAME" \]\]/
  );
  assert.doesNotMatch(gate, /pg_isready/);
  assert.match(gate, /trap cleanup EXIT INT TERM/);
  assert.match(gate, /test\/auth-refresh-postgres\.integration\.test\.js/);
  assert.match(gate, /test\/auth-signup-postgres\.integration\.test\.js/);
  assert.match(gate, /test\/push-token-postgres\.integration\.test\.js/);
});

test('push request nullability matches the non-optional iOS DTO fields', () => {
  const properties = contract.components.schemas.PushTokenRequest.properties;
  for (const field of ['deviceId', 'appVersion', 'buildNumber', 'environment']) {
    assert.equal(properties[field].type, 'string');
  }
  assert.equal(contract.components.schemas.RefreshRequest.properties.deviceName.type, 'string');
  assert.match(
    contract.paths['/auth/refresh'].post.requestBody.content['application/json'].schema.properties.deviceName.description,
    /null is rejected/
  );
  assert.equal(contract.components.schemas.SteamStatus.additionalProperties, false);
  assert.deepEqual(
    contract.components.schemas.SteamStatus.required,
    [
      'isLinked',
      'steamId',
      'steamId64',
      'displayName',
      'personaName',
      'avatarUrl',
      'profileUrl',
      'linkedAt',
      'canSync',
      'canDisconnect',
      'lastSteamSyncAt'
    ]
  );
});
