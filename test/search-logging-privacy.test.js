const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeRequestPath } = require('../src/middlewares/error.middleware');
const { buildSearchLogRecord } = require('../src/services/search-log.service');
const { sanitizeLogMeta } = require('../src/utils/logger');

test('sanitizeRequestPath removes the complete query string from logged request paths', () => {
  const sanitized = sanitizeRequestPath('/games/search?q=the%20legend%20of%20zelda&limit=5');

  assert.equal(sanitized, '/games/search');
});

test('sanitizeRequestPath still redacts token parameters', () => {
  const sanitized = sanitizeRequestPath('/auth/callback?access_token=secret-value&state=ok');

  assert.equal(sanitized, '/auth/callback');
});

test('search log records contain no raw query, user identifiers, or provider secrets', () => {
  const record = buildSearchLogRecord({
    endpoint: 'search',
    originalQuery: 'the legend of zelda',
    normalizedQuery: 'the legend of zelda',
    compactQuery: 'thelegendofzelda',
    sourceLanguage: 'en',
    aliasHits: [{ source: 'zelda', target: 'the legend of zelda' }],
    generatedCandidates: ['the legend of zelda', 'zelda*'],
    candidateQueriesActuallyUsed: ['the legend of zelda'],
    igdbRawCount: 12,
    finalResultCount: 8,
    topResultTitles: ['The Legend of Zelda'],
    elapsedMs: 42,
    cached: false
  });

  const serialized = JSON.stringify(record);

  assert.ok(!serialized.includes('zelda'), 'raw or derived query text must not be persisted');
  assert.ok(!serialized.toLowerCase().includes('legend'), 'result titles must not be persisted');
  assert.match(record.queryHash, /^[0-9a-f]{64}$/);
  assert.equal(record.queryLength, 'the legend of zelda'.length);
  assert.equal(record.finalResultCount, 8);
  assert.equal(record.topResultCount, 1);
  assert.ok(!('userId' in record));
  assert.ok(!('ip' in record));
});

test('winston meta sanitizer redacts query-like keys used on the search path', () => {
  const sanitized = sanitizeLogMeta({
    query: 'the legend of zelda',
    normalizedQuery: 'the legend of zelda',
    candidateQueries: ['zelda*'],
    queryLength: 19,
    resultCount: 8
  });

  assert.equal(sanitized.query, '<redacted>');
  assert.equal(sanitized.normalizedQuery, '<redacted>');
  assert.equal(sanitized.candidateQueries, '<redacted>');
  assert.equal(sanitized.queryLength, 19);
  assert.equal(sanitized.resultCount, 8);
});
