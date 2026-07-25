const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { env } = require('../src/config/env');
const { prisma } = require('../src/config/prisma');
const { app } = require('../src/app');

const realFetch = global.fetch;
const originalTwitchClientId = env.twitchClientId;
const originalTwitchClientSecret = env.twitchClientSecret;
const originalSearchQueryCreate = prisma.searchQuery?.create;

let server;
let baseUrl;

function mockUpstream({ games = [], igdbStatus = 200 } = {}) {
  global.fetch = async (url) => {
    if (String(url).includes('id.twitch.tv')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'contract-test-token', expires_in: 3600 })
      };
    }

    if (igdbStatus !== 200) {
      return {
        ok: false,
        status: igdbStatus,
        text: async () => 'upstream failure body'
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => games
    };
  };
}

async function request(pathWithQuery, headers = {}) {
  const response = await realFetch(`${baseUrl}${pathWithQuery}`, { headers });
  const body = await response.json();

  return { status: response.status, body };
}

function buildRawGame(overrides = {}) {
  return {
    id: 1001,
    name: 'Contract Quest',
    summary: 'A game used only by contract tests.',
    cover: { url: '//images.igdb.com/igdb/image/upload/t_thumb/co1abc.jpg' },
    genres: [{ name: 'Adventure' }],
    platforms: [{ name: 'PC (Microsoft Windows)' }],
    total_rating: 88.5,
    first_release_date: 1700000000,
    ...overrides
  };
}

const GAME_LIST_ITEM_KEYS = [
  'id',
  'name',
  'summary',
  'coverUrl',
  'genres',
  'platforms',
  'rating',
  'aggregatedRating',
  'totalRating',
  'releaseDate'
];
const SUGGESTION_ITEM_KEYS = ['id', 'name', 'coverUrl', 'rating'];
const META_KEYS = ['originalQuery', 'normalizedQuery', 'effectiveQuery', 'resultCount'];

test.before(async () => {
  env.twitchClientId = 'contract-test-client-id';
  env.twitchClientSecret = 'contract-test-client-secret';

  if (prisma.searchQuery) {
    prisma.searchQuery.create = async () => ({ id: 0 });
  }

  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  global.fetch = realFetch;
  env.twitchClientId = originalTwitchClientId;
  env.twitchClientSecret = originalTwitchClientSecret;

  if (prisma.searchQuery && originalSearchQueryCreate) {
    prisma.searchQuery.create = originalSearchQueryCreate;
  }

  await new Promise((resolve) => server.close(resolve));
});

test('GET /games/search returns the contract response shape without authentication', async () => {
  mockUpstream({
    games: [
      buildRawGame(),
      buildRawGame({ id: 1002, name: 'Contract Quest II', total_rating: 80 })
    ]
  });

  const { status, body } = await request('/games/search?q=contract%20quest');

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.query, 'contract quest');
  assert.deepEqual(Object.keys(body.data).sort(), ['games', 'meta', 'query', 'results', 'suggestions']);
  assert.ok(Array.isArray(body.data.games));
  assert.equal(body.data.games.length, 2);
  assert.deepEqual(body.data.results, body.data.games);
  assert.ok(Array.isArray(body.data.suggestions));
  assert.ok(body.data.suggestions.length <= 8);

  for (const game of body.data.games) {
    assert.deepEqual(Object.keys(game).sort(), [...GAME_LIST_ITEM_KEYS].sort());
    assert.equal(typeof game.id, 'number');
    assert.ok(game.genres.every((genre) => typeof genre === 'string'));
    assert.ok(game.platforms.every((platform) => typeof platform === 'string'));
  }

  const topGame = body.data.games.find((game) => game.id === 1001);
  assert.equal(topGame.name, 'Contract Quest');
  assert.equal(topGame.rating, 88.5);
  assert.equal(topGame.releaseDate, 1700000000);
  assert.match(topGame.coverUrl, /^https:\/\//);

  assert.deepEqual(Object.keys(body.data.meta).sort(), [...META_KEYS].sort());
  assert.equal(body.data.meta.originalQuery, 'contract quest');
  assert.equal(body.data.meta.resultCount, body.data.games.length);
});

test('GET /games/search honors limit and reports the limited resultCount', async () => {
  mockUpstream({
    games: [
      buildRawGame({ id: 2001, name: 'Limit Case Alpha' }),
      buildRawGame({ id: 2002, name: 'Limit Case Beta' }),
      buildRawGame({ id: 2003, name: 'Limit Case Gamma' })
    ]
  });

  const { status, body } = await request('/games/search?q=limit%20case&limit=1');

  assert.equal(status, 200);
  assert.equal(body.data.games.length, 1);
  assert.equal(body.data.meta.resultCount, 1);
  assert.deepEqual(body.data.results, body.data.games);
});

test('GET /games/search returns an empty successful result when the provider has no matches', async () => {
  mockUpstream({ games: [] });

  const { status, body } = await request('/games/search?q=empty%20result%20case');

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data.games, []);
  assert.deepEqual(body.data.results, []);
  assert.deepEqual(body.data.suggestions, []);
  assert.equal(body.data.meta.resultCount, 0);
});

test('GET /games/search ignores Authorization headers (public endpoint)', async () => {
  mockUpstream({ games: [buildRawGame({ id: 3001, name: 'Auth Case' })] });

  const withInvalidToken = await request('/games/search?q=auth%20case', {
    Authorization: 'Bearer definitely-not-a-valid-token'
  });

  assert.equal(withInvalidToken.status, 200);
  assert.equal(withInvalidToken.body.success, true);
});

test('GET /games/search rejects a missing or invalid q with INVALID_SEARCH_QUERY', async () => {
  mockUpstream({ games: [] });

  const missing = await request('/games/search');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.error.code, 'INVALID_SEARCH_QUERY');
  assert.ok(Array.isArray(missing.body.error.details));
  assert.ok(missing.body.error.details.some((detail) => detail.field === 'q'));

  const tooLong = await request(`/games/search?q=${'a'.repeat(101)}`);
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, 'INVALID_SEARCH_QUERY');

  const blank = await request('/games/search?q=%20%20');
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error.code, 'INVALID_SEARCH_QUERY');
});

test('GET /games/search rejects out-of-range or non-numeric limit with INVALID_GAMES_LIMIT', async () => {
  mockUpstream({ games: [] });

  for (const badLimit of ['0', '31', 'abc', '1.5']) {
    const { status, body } = await request(`/games/search?q=limit%20validation&limit=${badLimit}`);

    assert.equal(status, 400, `limit=${badLimit} should be rejected`);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INVALID_GAMES_LIMIT');
    assert.ok(Array.isArray(body.error.details));
    assert.ok(body.error.details.some((detail) => detail.field === 'limit'));
  }
});

test('GET /games/suggestions returns the contract response shape without authentication', async () => {
  mockUpstream({
    games: [
      buildRawGame({ id: 4001, name: 'Suggestion Case' }),
      buildRawGame({ id: 4002, name: 'Suggestion Case Deluxe', total_rating: 70 })
    ]
  });

  const { status, body } = await request('/games/suggestions?q=suggestion%20case');

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.data).sort(), ['meta', 'suggestions']);
  assert.ok(Array.isArray(body.data.suggestions));
  assert.ok(body.data.suggestions.length <= 8);

  for (const suggestion of body.data.suggestions) {
    assert.deepEqual(Object.keys(suggestion).sort(), [...SUGGESTION_ITEM_KEYS].sort());
    assert.equal(typeof suggestion.id, 'number');
  }

  assert.deepEqual(Object.keys(body.data.meta).sort(), [...META_KEYS].sort());
  assert.equal(body.data.meta.resultCount, body.data.suggestions.length);
});

test('GET /games/suggestions rejects limit above 8 with INVALID_GAMES_LIMIT', async () => {
  mockUpstream({ games: [] });

  const { status, body } = await request('/games/suggestions?q=suggestion%20limit&limit=9');

  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INVALID_GAMES_LIMIT');
});

test('GET /games/suggestions rejects a missing q with INVALID_SEARCH_QUERY', async () => {
  mockUpstream({ games: [] });

  const { status, body } = await request('/games/suggestions');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_SEARCH_QUERY');
});

test('GET /games/search maps an IGDB non-OK response to 502 IGDB_UPSTREAM_ERROR', async () => {
  mockUpstream({ igdbStatus: 500 });

  const { status, body } = await request('/games/search?q=upstream%20failure%20case');

  assert.equal(status, 502);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'IGDB_UPSTREAM_ERROR');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(!body.error.message.includes('upstream failure body'), 'provider payload must not leak to clients');
});

test('GET /games/suggestions maps an IGDB network failure to 502 IGDB_UPSTREAM_ERROR', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('id.twitch.tv')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'contract-test-token', expires_in: 3600 })
      };
    }

    throw Object.assign(new Error('socket hang up'), { name: 'FetchError' });
  };

  const { status, body } = await request('/games/suggestions?q=network%20failure%20case');

  assert.equal(status, 502);
  assert.equal(body.error.code, 'IGDB_UPSTREAM_ERROR');
});

// Keep this test last: an upstream 429 puts the IGDB client into a
// process-wide rate-limit cooldown that affects later live requests.
test('GET /games/search maps an IGDB 429 to 429 IGDB_RATE_LIMITED', async () => {
  mockUpstream({ igdbStatus: 429 });

  const { status, body } = await request('/games/search?q=rate%20limited%20case');

  assert.equal(status, 429);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'IGDB_RATE_LIMITED');
});
