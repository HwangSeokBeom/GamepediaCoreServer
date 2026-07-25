const test = require('node:test');
const assert = require('node:assert/strict');
const { privacySettingsSchema, pushTokenRegistrationSchema } = require('../src/modules/user/user.validator');
const { mapSteamLinkStatus } = require('../src/modules/library/library.mapper');
const {
  appleLoginSchema,
  googleLoginSchema,
  loginSchema,
  refreshSchema,
  signUpSchema
} = require('../src/validators/auth.validator');

test('privacy validator translates deployed iOS fields to canonical fields', () => {
  assert.deepEqual(privacySettingsSchema.parse({
    isFriendsListPublic: true,
    isRecentPlayPublic: false,
    isLikedGamesPublic: true,
    isReviewsPublic: false
  }), {
    showFriendsList: true,
    showRecentlyPlayed: false,
    showLikedGames: true,
    showReviews: false
  });
});

test('privacy validator rejects contradictory canonical and compatibility values', () => {
  assert.throws(() => privacySettingsSchema.parse({
    showFriendsList: false,
    isFriendsListPublic: true
  }));
});

test('Steam mapper supplies the deployed iOS status shape without a linked account', () => {
  assert.deepEqual(mapSteamLinkStatus(null), {
    isLinked: false,
    steamId: null,
    steamId64: null,
    displayName: null,
    personaName: null,
    avatarUrl: null,
    profileUrl: null,
    linkedAt: null,
    lastSteamSyncAt: null,
    canSync: false,
    canDisconnect: false
  });
});

test('Steam mapper supplies aliases and UTC-capable date values for a linked account', () => {
  const date = new Date('2026-07-13T00:00:00.000Z');
  const status = mapSteamLinkStatus({
    providerSubject: '76561198000000000',
    personaName: 'Player',
    avatarUrl: null,
    profileUrl: 'https://steamcommunity.com/example',
    linkedAt: date,
    lastSteamSyncAt: date
  });
  assert.equal(status.isLinked, true);
  assert.equal(status.steamId, status.steamId64);
  assert.equal(status.displayName, status.personaName);
  assert.equal(status.canDisconnect, true);
  assert.equal(status.lastSteamSyncAt.toISOString(), '2026-07-13T00:00:00.000Z');
});

test('push token contract accepts both mobile platforms', () => {
  for (const platform of ['ios', 'android']) {
    const parsed = pushTokenRegistrationSchema.parse({
      token: '12345678901234567890',
      platform
    });
    assert.equal(parsed.platform, platform);
  }
});

test('push token optional metadata follows the non-null iOS DTO contract', () => {
  for (const field of ['deviceId', 'appVersion', 'buildNumber', 'environment']) {
    assert.throws(() => pushTokenRegistrationSchema.parse({
      token: '12345678901234567890',
      platform: 'ios',
      [field]: null
    }));
  }
});

test('push token validator accepts 4096 characters and rejects 4097', () => {
  assert.equal(pushTokenRegistrationSchema.parse({
    token: 'x'.repeat(4096),
    platform: 'ios'
  }).token.length, 4096);
  assert.throws(() => pushTokenRegistrationSchema.parse({
    token: 'x'.repeat(4097),
    platform: 'ios'
  }));
  assert.equal(pushTokenRegistrationSchema.parse({
    token: '한'.repeat(4096),
    platform: 'ios'
  }).token.length, 4096);
});

test('refresh deviceName follows the string-or-omitted iOS contract', () => {
  assert.equal(refreshSchema.parse({ refreshToken: 'fixture' }).refreshToken, 'fixture');
  assert.throws(() => refreshSchema.parse({ refreshToken: 'fixture', deviceName: null }));
});

test('every session-issuing auth validator rejects null deviceName', () => {
  const cases = [
    [signUpSchema, {
      email: 'device-contract@example.invalid',
      password: 'contract-password-1',
      nickname: 'device-contract'
    }],
    [loginSchema, {
      email: 'device-contract@example.invalid',
      password: 'contract-password-1'
    }],
    [appleLoginSchema, { identityToken: 'fixture-identity-token' }],
    [googleLoginSchema, { idToken: 'fixture-google-token' }],
    [refreshSchema, { refreshToken: 'fixture-refresh-token' }]
  ];

  for (const [schema, payload] of cases) {
    assert.doesNotThrow(() => schema.parse(payload));
    assert.throws(() => schema.parse({ ...payload, deviceName: null }));
  }
});
