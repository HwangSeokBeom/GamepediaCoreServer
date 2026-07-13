const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { discoverCanonicalTests } = require('../scripts/test/run-canonical-tests');

test('canonical test discovery excludes duplicate-suffixed user files', () => {
  const tests = discoverCanonicalTests(path.resolve(process.cwd(), 'test'));
  assert.ok(tests.length >= 9);
  assert.ok(tests.every((file) => file.endsWith('.test.js')));
  assert.ok(tests.every((file) => !/ [23]\.js$/.test(file)));
  assert.ok(tests.some((file) => file.endsWith('canonical-test-discovery.test.js')));
});
