'use strict';

process.env.NODE_ENV ??= 'test';
process.env.APP_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:1/gamepedia_contract_unreachable';
process.env.JWT_ACCESS_SECRET ??= 'recent-play-contract-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'recent-play-contract-refresh-secret';
process.env.ACCESS_TOKEN_EXPIRES_IN ??= '15m';
process.env.REFRESH_TOKEN_EXPIRES_IN ??= '30d';
process.env.MAIL_MODE ??= 'log';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recentlyPlayedQuerySchema } = require('../src/modules/user/user.validator');
const userService = require('../src/modules/user/user.service');

test('recent-play query accepts only omitted or canonical integer strings from 1 through 50', () => {
  assert.deepEqual(recentlyPlayedQuerySchema.parse({}), {});
  assert.deepEqual(recentlyPlayedQuerySchema.parse({ limit: '1' }), { limit: 1 });
  assert.deepEqual(recentlyPlayedQuerySchema.parse({ limit: '50' }), { limit: 50 });

  for (const limit of ['0', '51', '1.5', '7junk', '', ['1', '2'], { value: '7' }, null]) {
    assert.throws(() => recentlyPlayedQuerySchema.parse({ limit }), `limit ${JSON.stringify(limit)} must be rejected`);
  }
});

test('recent-play service rejects malformed limits before any database access', async () => {
  for (const limit of [0, 51, 1.5, '7', '7junk', '', ['1', '2'], { value: 7 }, null]) {
    await assert.rejects(
      userService.getMyRecentlyPlayedProfileGames({
        userId: '00000000-0000-4000-8000-000000000001',
        limit
      }),
      (error) => error?.statusCode === 400 && error?.code === 'INVALID_RECENT_PLAY_LIMIT'
    );
  }
});
