const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('../src/config/env');
const { prisma } = require('../src/config/prisma');
const igdbService = require('../src/modules/igdb/igdb.service');

test('IGDB game detail falls back to DB data when upstream returns 429', async () => {
  const originalFetch = global.fetch;
  const originalTwitchClientId = env.twitchClientId;
  const originalTwitchClientSecret = env.twitchClientSecret;
  const originalFindFirst = prisma.userGameLibrary.findFirst;
  const originalAggregate = prisma.review.aggregate;

  env.twitchClientId = 'test-client-id';
  env.twitchClientSecret = 'test-client-secret';
  prisma.userGameLibrary.findFirst = async () => ({
    externalGameId: '328386',
    gameName: 'Cached DB Title',
    coverUrl: 'https://cdn.example.com/cover.jpg',
    updatedAt: new Date('2026-04-30T00:00:00.000Z')
  });
  prisma.review.aggregate = async () => ({
    _count: { id: 2 },
    _avg: { rating: 4.5 }
  });
  global.fetch = async (url) => {
    if (String(url).includes('id.twitch.tv')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'test-token',
          expires_in: 3600
        })
      };
    }

    return {
      ok: false,
      status: 429,
      text: async () => 'rate limited'
    };
  };

  try {
    const response = await igdbService.getGameDetail({ gameId: '328386' });

    assert.equal(response.game.id, 328386);
    assert.equal(response.game.name, 'Cached DB Title');
    assert.equal(response.game.coverUrl, 'https://cdn.example.com/cover.jpg');
    assert.equal(response.meta.isPartial, true);
    assert.equal(response.meta.fallbackSource, 'db');
    assert.equal(response.meta.liveFetchSkippedReason, 'rate_limited');
    assert.equal(response.meta.localReviewSummary.averageRating, 4.5);
  } finally {
    global.fetch = originalFetch;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
    prisma.userGameLibrary.findFirst = originalFindFirst;
    prisma.review.aggregate = originalAggregate;
  }
});
