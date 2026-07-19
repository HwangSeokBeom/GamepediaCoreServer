const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Repository-wide scan: logging statements must never interpolate bearer
// credentials or personal data. The scanner extracts each complete logger
// call expression across balanced parentheses (string-, template-, and
// comment-aware), so multiline calls with sensitive values in trailing
// metadata objects are inspected too — not just the physical line that
// contains the call name. Token-bearing mail bodies (which legitimately embed
// the reset URL outside logger calls) do not trip the scan.
const SRC_DIR = path.resolve(__dirname, '..', 'src');

const LOG_CALL_PATTERN = /\b(?:console|logger)\.(?:log|info|warn|error|debug)\s*\(/g;

const FORBIDDEN_LOG_PATTERNS = [
  { name: 'reset URL reference', pattern: /resetUrl/ },
  { name: 'reset URL path', pattern: /reset-password/ },
  { name: 'token interpolation', pattern: /token\s*=\s*\$\{/i },
  { name: 'token metadata key', pattern: /[{,]\s*token\s*[:,}]/ },
  { name: 'recipient interpolation', pattern: /\bto\s*=\s*\$\{/ },
  { name: 'recipient metadata key', pattern: /[{,]\s*to\s*:/ },
  { name: 'email interpolation', pattern: /email\s*=\s*\$\{/i },
  { name: 'email metadata key', pattern: /[{,]\s*email\s*[:,}]/i },
  { name: 'password interpolation', pattern: /password\s*=\s*\$\{/i },
  { name: 'password metadata key', pattern: /[{,]\s*password\s*[:,}]/i },
  { name: 'profile image URL interpolation', pattern: /profileImageUrl\s*=\s*\$\{/ },
  { name: 'authorization header', pattern: /authorization/i },
  { name: 'bearer credential', pattern: /bearer/i }
];

// Replaces // and /* */ comments with spaces (newlines preserved so reported
// line numbers stay correct) while leaving string and template contents
// intact — leaks live inside template literals, comments must not flag.
function stripComments(source) {
  const out = source.split('');
  let state = 'code';
  const templateStack = [];

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === 'lineComment') {
      if (char === '\n') {
        state = 'code';
      } else {
        out[i] = ' ';
      }
      continue;
    }

    if (state === 'blockComment') {
      if (char === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        state = 'code';
      } else if (char !== '\n') {
        out[i] = ' ';
      }
      continue;
    }

    if (state === 'single' || state === 'double') {
      if (char === '\\') {
        i += 1;
      } else if ((state === 'single' && char === "'") || (state === 'double' && char === '"')) {
        state = 'code';
      }
      continue;
    }

    if (state === 'template') {
      if (char === '\\') {
        i += 1;
      } else if (char === '`') {
        // A closing backtick returns to code: either top-level code or the
        // surrounding `${}` expression tracked via templateStack.
        state = 'code';
      } else if (char === '$' && next === '{') {
        templateStack.push(0);
        state = 'code';
        i += 1;
      }
      continue;
    }

    // state === 'code'
    if (char === '/' && next === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 1;
      state = 'lineComment';
    } else if (char === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 1;
      state = 'blockComment';
    } else if (char === "'") {
      state = 'single';
    } else if (char === '"') {
      state = 'double';
    } else if (char === '`') {
      state = 'template';
    } else if (templateStack.length > 0 && char === '{') {
      templateStack[templateStack.length - 1] += 1;
    } else if (templateStack.length > 0 && char === '}') {
      if (templateStack[templateStack.length - 1] === 0) {
        templateStack.pop();
        state = 'template';
      } else {
        templateStack[templateStack.length - 1] -= 1;
      }
    }
  }

  return out.join('');
}

// Given the index of an opening parenthesis in comment-free source, returns
// the index just past its balanced closing parenthesis, ignoring parentheses
// inside strings and template literals (including nested `${}` expressions).
function findCallEnd(source, openParenIndex) {
  let depth = 0;
  let state = 'code';
  const templateStack = [];

  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === 'single' || state === 'double') {
      if (char === '\\') {
        i += 1;
      } else if ((state === 'single' && char === "'") || (state === 'double' && char === '"')) {
        state = 'code';
      }
      continue;
    }

    if (state === 'template') {
      if (char === '\\') {
        i += 1;
      } else if (char === '`') {
        state = 'code';
      } else if (char === '$' && next === '{') {
        templateStack.push(0);
        state = 'code';
        i += 1;
      }
      continue;
    }

    // state === 'code'
    if (char === "'") {
      state = 'single';
    } else if (char === '"') {
      state = 'double';
    } else if (char === '`') {
      state = 'template';
    } else if (templateStack.length > 0 && char === '{') {
      templateStack[templateStack.length - 1] += 1;
    } else if (templateStack.length > 0 && char === '}') {
      if (templateStack[templateStack.length - 1] === 0) {
        templateStack.pop();
        state = 'template';
      } else {
        templateStack[templateStack.length - 1] -= 1;
      }
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;

      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return source.length;
}

function lineNumberAt(source, index) {
  let line = 1;

  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1;
    }
  }

  return line;
}

// Scans one source text. Returns violations as { line, rule } only — matched
// text is intentionally never included so the scanner cannot itself leak a
// secret value into test output.
function scanSource(source) {
  const commentFree = stripComments(source);
  const violations = [];

  LOG_CALL_PATTERN.lastIndex = 0;
  let match;

  while ((match = LOG_CALL_PATTERN.exec(commentFree)) !== null) {
    const openParenIndex = match.index + match[0].length - 1;
    const callEnd = findCallEnd(commentFree, openParenIndex);
    const callExpression = commentFree.slice(match.index, callEnd);

    for (const { name, pattern } of FORBIDDEN_LOG_PATTERNS) {
      if (pattern.test(callExpression)) {
        violations.push({ line: lineNumberAt(commentFree, match.index), rule: name });
      }
    }

    LOG_CALL_PATTERN.lastIndex = callEnd;
  }

  return violations;
}

function rulesFound(source) {
  return scanSource(source).map(({ rule }) => rule);
}

function listJsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listJsFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

test('scanner detects single-line sensitive logging', () => {
  const syntheticLeaks = [
    'console.info(`[password-reset:email] mode=log to=${email} resetUrl=${resetUrl}`);',
    'logger.info(`reset link: https://x.test/reset-password?token=${token}`);',
    'console.error(`failed token=${rawToken}`);',
    'console.info(`[profile-image] uploaded profileImageUrl=${profileImageUrl}`);'
  ];

  for (const leak of syntheticLeaks) {
    assert.ok(rulesFound(leak).length > 0, 'scanner must flag a single-line leak');
  }
});

test('scanner detects multiline template interpolation leaks', () => {
  const leak = [
    'logger.info(',
    '  `password reset dispatched',
    '   token=${token}`',
    ');'
  ].join('\n');

  const rules = rulesFound(leak);
  assert.ok(rules.includes('token interpolation'), `multiline template leak must be flagged, got: ${rules}`);

  const multilineEmail = [
    'console.error(`delivery failed',
    '  email=${email}`);'
  ].join('\n');

  assert.ok(rulesFound(multilineEmail).includes('email interpolation'));
});

test('scanner detects multiline metadata object leaks', () => {
  const leak = [
    "logger.error('password reset failed', {",
    '  reason: error.code,',
    '  token,',
    '  email: user.email',
    '});'
  ].join('\n');

  const rules = rulesFound(leak);
  assert.ok(rules.includes('token metadata key'), `metadata token leak must be flagged, got: ${rules}`);
  assert.ok(rules.includes('email metadata key'), `metadata email leak must be flagged, got: ${rules}`);

  const resetUrlMetadata = [
    "logger.info('mail dispatched', {",
    '  resetUrl,',
    '  ttlMinutes',
    '});'
  ].join('\n');

  assert.ok(rulesFound(resetUrlMetadata).includes('reset URL reference'));

  const recipientMetadata = [
    "logger.info('mail dispatched',",
    '  { to: recipient.address });'
  ].join('\n');

  assert.ok(rulesFound(recipientMetadata).includes('recipient metadata key'));
});

test('scanner accepts safe reason-code metadata', () => {
  const safeCalls = [
    "console.info('[password-reset:email] event=dispatched mode=log');",
    "logger.error('mail delivery failed', { reason: 'smtp_auth_failure' });",
    [
      "logger.info('GamePedia auth server started', {",
      '  host: env.host,',
      '  port: env.port,',
      '  mailMode: mailReadiness.mode,',
      '  mailVerified: mailReadiness.verified',
      '});'
    ].join('\n'),
    "logger.info('request completed', { tokenCount: 3, emailsSent: 2 });"
  ];

  for (const safe of safeCalls) {
    assert.deepEqual(scanSource(safe), [], 'sanitized metadata logging must pass the scan');
  }
});

test('scanner detects credential header and password patterns', () => {
  assert.ok(rulesFound('console.warn(`rejected authorization=${req.headers.authorization}`);').includes('authorization header'));
  assert.ok(rulesFound("logger.debug('auth', { header: `Bearer ${accessToken}` });").includes('bearer credential'));
  assert.ok(rulesFound('console.info(`login password=${password}`);').includes('password interpolation'));
  assert.ok(
    rulesFound(["logger.warn('login failed', {", '  password: attempt.password', '});'].join('\n')).includes(
      'password metadata key'
    )
  );
});

test('comments and unrelated strings do not create false positives', () => {
  const safeSources = [
    // Comment mentioning sensitive names above a clean call.
    [
      '// the resetUrl and token are mail-body-only; never log them',
      "console.info('[password-reset:email] event=dispatched');"
    ].join('\n'),
    // Comment inside a multiline call expression.
    [
      "logger.info('mail dispatched', {",
      '  // token and resetUrl intentionally omitted from log metadata',
      '  ttlMinutes: env.passwordResetTokenTtlMinutes',
      '});'
    ].join('\n'),
    // Block comment spanning the call site.
    [
      '/* password=${password} would be a leak if it were code */',
      "console.info('event=ok');"
    ].join('\n'),
    // Sensitive words in strings that are not part of any logger call.
    "const message = `Reset your password: ${resetUrl}`;\nmailer.send({ to: email, text: message });",
    // Logger call whose string only carries a safe event name.
    "console.error('[email] event=mail_send_failed mode=smtp reason=econnection');"
  ];

  for (const source of safeSources) {
    assert.deepEqual(scanSource(source), [], 'comments and unrelated strings must not be flagged');
  }
});

test('scanner handles nested template expressions and parentheses in strings', () => {
  const nested = [
    'logger.info(',
    '  `outer ${format(`inner ${value} (paren) `)} done`,',
    "  { status: 'ok' }",
    ');',
    'const after = doSomething();'
  ].join('\n');

  assert.deepEqual(scanSource(nested), [], 'balanced extraction must survive nested templates');

  const nestedLeak = [
    'logger.info(',
    '  `outer ${format(`inner (paren) `)}`,',
    '  { token }',
    ');'
  ].join('\n');

  assert.ok(rulesFound(nestedLeak).includes('token metadata key'));
});

test('src contains no logging statements with sensitive content', () => {
  const violations = [];

  for (const filePath of listJsFiles(SRC_DIR)) {
    const source = fs.readFileSync(filePath, 'utf8');

    for (const { line, rule } of scanSource(source)) {
      // Report file, line, and rule only — never the matched source text.
      violations.push(`${path.relative(SRC_DIR, filePath)}:${line} [${rule}] logger call matches a forbidden pattern`);
    }
  }

  assert.deepEqual(violations, [], `sensitive logging statements found:\n${violations.join('\n')}`);
});
