const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Repository-wide scan: logging statements must never interpolate bearer
// credentials or personal data. Only lines that invoke a logger are checked,
// so token-bearing mail bodies (which legitimately embed the reset URL) do
// not trip the scan.
const SRC_DIR = path.resolve(__dirname, '..', 'src');

const LOG_CALL_PATTERN = /\b(console|logger)\.(log|info|warn|error|debug)\s*\(/;

const FORBIDDEN_LOG_PATTERNS = [
  { name: 'reset URL reference', pattern: /resetUrl/ },
  { name: 'reset URL path', pattern: /reset-password/ },
  { name: 'token interpolation', pattern: /token\s*=\s*\$\{/i },
  { name: 'recipient interpolation', pattern: /\bto\s*=\s*\$\{/ },
  { name: 'email interpolation', pattern: /email\s*=\s*\$\{/i },
  { name: 'password interpolation', pattern: /password\s*=\s*\$\{/i },
  { name: 'profile image URL interpolation', pattern: /profileImageUrl\s*=\s*\$\{/ },
  { name: 'authorization header', pattern: /authorization/i },
  { name: 'bearer credential', pattern: /bearer/i }
];

function listJsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listJsFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

function scanLine(line) {
  if (!LOG_CALL_PATTERN.test(line)) {
    return [];
  }

  return FORBIDDEN_LOG_PATTERNS.filter(({ pattern }) => pattern.test(line)).map(({ name }) => name);
}

test('scanner detects reset-token URL logging patterns', () => {
  const syntheticLeaks = [
    'console.info(`[password-reset:email] mode=log to=${email} resetUrl=${resetUrl}`);',
    'logger.info(`reset link: https://x.test/reset-password?token=${token}`);',
    'console.error(`failed token=${rawToken}`);',
    'console.info(`[profile-image] uploaded profileImageUrl=${profileImageUrl}`);'
  ];

  for (const leak of syntheticLeaks) {
    assert.ok(scanLine(leak).length > 0, `scanner must flag: ${leak}`);
  }

  assert.deepEqual(
    scanLine("console.info('[password-reset:email] event=dispatched mode=log');"),
    [],
    'sanitized metadata logging must pass the scan'
  );
});

test('src contains no logging statements with sensitive interpolations', () => {
  const violations = [];

  for (const filePath of listJsFiles(SRC_DIR)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');

    lines.forEach((line, index) => {
      for (const patternName of scanLine(line)) {
        violations.push(`${path.relative(SRC_DIR, filePath)}:${index + 1} [${patternName}] ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, [], `sensitive logging statements found:\n${violations.join('\n')}`);
});
