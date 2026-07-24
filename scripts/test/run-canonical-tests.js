const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_ROOT = path.resolve(process.cwd(), 'test');
const DUPLICATE_SUFFIX = / [23]\.js$/;

function discoverCanonicalTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory() ? discoverCanonicalTests(absolutePath) : [absolutePath];
    })
    .filter((filePath) => filePath.endsWith('.test.js'))
    .filter((filePath) => !DUPLICATE_SUFFIX.test(filePath))
    .sort();
}

if (require.main === module) {
  const tests = discoverCanonicalTests(TEST_ROOT);

  if (tests.length === 0) {
    process.stderr.write('No canonical tests discovered.\n');
    process.exit(1);
  }

  process.stdout.write(`Canonical tests (${tests.length}):\n${tests.map((file) => `- ${path.relative(process.cwd(), file)}`).join('\n')}\n`);

  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  });

  process.exit(result.status ?? 1);
}

module.exports = { discoverCanonicalTests };
