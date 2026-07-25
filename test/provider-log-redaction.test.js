const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const winston = require('winston');

const { env } = require('../src/config/env');
const igdbService = require('../src/modules/igdb/igdb.service');
const steamService = require('../src/services/steam.service');
const { buildLogFormatter, logger } = require('../src/utils/logger');

async function captureLogs(action) {
  const stream = new PassThrough();
  let output = '';
  stream.on('data', (chunk) => { output += chunk.toString('utf8'); });
  const transport = new winston.transports.Stream({ stream, format: buildLogFormatter() });
  logger.add(transport);

  try {
    await action();
    await new Promise((resolve) => setImmediate(resolve));
    return output;
  } finally {
    logger.remove(transport);
    transport.destroy();
    stream.destroy();
  }
}

test('Steam upstream failure emits useful sanitized metadata without URL credentials or response body', async () => {
  const originalFetch = global.fetch;
  const originalApiKey = env.steamApiKey;
  const sentinel = 'SENTINEL_STEAM_PRIVATE_7F93';
  const steamId64 = '76561198000000000';

  env.steamApiKey = `${sentinel}-api-key`;
  global.fetch = async () => ({
    ok: false,
    status: 502,
    text: async () => `provider body ${sentinel}`
  });

  try {
    const output = await captureLogs(async () => {
      await assert.rejects(
        steamService.fetchOwnedGames({ steamId64 }),
        (error) => error?.code === 'STEAM_UPSTREAM_ERROR'
      );
    });

    assert.match(output, /Steam Web API returned a non-OK response/);
    assert.match(output, /"operation":"owned-games"/);
    assert.match(output, /"status":502/);
    assert.doesNotMatch(output, new RegExp(sentinel));
    assert.doesNotMatch(output, new RegExp(steamId64));
    assert.doesNotMatch(output, /endpointUrl|provider body|authorization/i);
  } finally {
    global.fetch = originalFetch;
    env.steamApiKey = originalApiKey;
  }
});

test('IGDB authentication failure logs status while omitting credentials, query text, and provider body', async () => {
  const originalFetch = global.fetch;
  const originalClientId = env.twitchClientId;
  const originalClientSecret = env.twitchClientSecret;
  const sentinel = 'SENTINEL_IGDB_PRIVATE_7F93';

  env.twitchClientId = `${sentinel}-client`;
  env.twitchClientSecret = `${sentinel}-secret`;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => `provider body ${sentinel}`
  });

  try {
    const output = await captureLogs(async () => {
      await assert.rejects(
        igdbService.searchGames({ query: `private query ${sentinel}`, limit: 5 }),
        (error) => error?.code === 'TWITCH_AUTH_UNAVAILABLE'
      );
    });

    assert.match(output, /igdb-search-request/);
    assert.match(output, /Twitch token endpoint returned a non-OK response/);
    assert.match(output, /"status":401/);
    assert.doesNotMatch(output, new RegExp(sentinel));
    assert.doesNotMatch(output, /client_secret|provider body|private query|authorization/i);
  } finally {
    global.fetch = originalFetch;
    env.twitchClientId = originalClientId;
    env.twitchClientSecret = originalClientSecret;
  }
});
