const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeLogMeta } = require('../src/utils/logger');
const { maskPushToken } = require('../src/modules/push/push-token.utils');
const { sanitizeRequestPath } = require('../src/middlewares/error.middleware');

test('push token metadata never retains raw token fragments', () => {
  const token = 'SENTINEL-PUSH-TOKEN-1234567890';
  const metadata = maskPushToken(token);
  assert.deepEqual(metadata, { exists: true, length: token.length });
  assert.doesNotMatch(JSON.stringify(metadata), /SENTINEL|1234567890/);
});

test('central logger removes provider bodies, URLs and personal identifiers', () => {
  const sentinel = 'SENTINEL-PRIVATE-VALUE';
  const sanitized = sanitizeLogMeta({
    userId: sentinel,
    steamId64: sentinel,
    endpointUrl: `https://example.test?key=${sentinel}`,
    body: sentinel,
    query: sentinel,
    email: `${sentinel}@example.test`,
    message: `provider echoed ${sentinel}`,
    error: new Error(sentinel),
    resultCount: 2
  });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, new RegExp(sentinel));
  assert.equal(sanitized.resultCount, 2);
  assert.match(sanitized.userId, /^sha256:/);
});

test('request logging removes all query text from paths', () => {
  const sentinel = 'SENTINEL-PRIVATE-SEARCH';
  assert.equal(
    sanitizeRequestPath(`/games/search?query=${sentinel}&token=secret`),
    '/games/search'
  );
  assert.doesNotMatch(sanitizeRequestPath(`/ai/search?prompt=${sentinel}`), new RegExp(sentinel));
});
