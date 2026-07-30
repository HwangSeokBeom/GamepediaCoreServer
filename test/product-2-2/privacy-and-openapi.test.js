const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers/test-env');

const { sanitizeLogMeta } = require('../../src/utils/logger');

// Two guarantees for the Product 2.2 modules:
//   1. no code path can put raw user data (a query, a Playlog note, a URL query
//      string, a provider body, a prompt) into a log line or an event property,
//   2. the OpenAPI document matches the routers that are actually registered.

const PRODUCT_MODULE_DIRS = [
  'src/modules/catalog',
  'src/modules/play',
  'src/modules/feed',
  'src/modules/product'
];

function listJsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listJsFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.js') && !/ [23]\.js$/.test(entry.name) ? [entryPath] : [];
  });
}

function productModuleFiles() {
  return PRODUCT_MODULE_DIRS.flatMap((directory) => listJsFiles(path.resolve(process.cwd(), directory)));
}

/// Extracts each complete logger call across balanced parentheses. Comments are
/// blanked first so a comment naming a sensitive field cannot trip the scan.
function extractLoggerCalls(source) {
  const commentFree = source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
  const calls = [];
  const pattern = /\b(?:logger|console)\.(?:log|info|warn|error|debug)\s*\(/g;
  let match;

  while ((match = pattern.exec(commentFree)) !== null) {
    let depth = 0;
    let end = match.index + match[0].length - 1;

    for (let index = end; index < commentFree.length; index += 1) {
      if (commentFree[index] === '(') {
        depth += 1;
      } else if (commentFree[index] === ')') {
        depth -= 1;

        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }

    calls.push({ text: commentFree.slice(match.index, end), index: match.index });
    pattern.lastIndex = end;
  }

  return calls;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

// Metadata keys that would carry raw user content into a log line.
const FORBIDDEN_LOG_KEYS = [
  { name: 'raw note', pattern: /[{,]\s*note\s*[:,}]/ },
  { name: 'raw query', pattern: /[{,]\s*(?:query|rawQuery|searchQuery|normalizedQuery)\s*[:,}]/i },
  { name: 'raw input', pattern: /[{,]\s*(?:input|userInput|rawInput)\s*[:,}]/i },
  { name: 'prompt', pattern: /[{,]\s*(?:prompt|systemPrompt|userPrompt)\s*[:,}]/i },
  { name: 'provider body', pattern: /[{,]\s*(?:body|responseBody|providerBody|payload)\s*[:,}]/i },
  { name: 'url or query string', pattern: /[{,]\s*(?:url|sourceUrl|redirectUri|requestUrl)\s*[:,}]/i },
  { name: 'title or name', pattern: /[{,]\s*(?:title|originalTitle|gameName|headline|nickname)\s*[:,}]/i },
  { name: 'credential', pattern: /[{,]\s*(?:token|apiKey|password|secret|authorization)\s*[:,}]/i },
  { name: 'bearer credential', pattern: /bearer/i },
  { name: 'template interpolation of user text', pattern: /\$\{\s*(?:input|query|note|prompt|title)\b/i }
];

test('no Product 2.2 module logs raw user data', () => {
  const violations = [];

  for (const filePath of productModuleFiles()) {
    const source = fs.readFileSync(filePath, 'utf8');

    for (const call of extractLoggerCalls(source)) {
      for (const { name, pattern } of FORBIDDEN_LOG_KEYS) {
        if (pattern.test(call.text)) {
          // Report location and rule only, never the matched text.
          violations.push(`${path.relative(process.cwd(), filePath)}:${lineNumberAt(source, call.index)} [${name}]`);
        }
      }
    }
  }

  assert.deepEqual(violations, [], `Product 2.2 logging violations:\n${violations.join('\n')}`);
});

test('the leak scanner actually detects a planted leak', () => {
  const planted = [
    "logger.info('play-session-created', { note: session.note });",
    "logger.info('quick-add', { query: input });",
    "logger.warn('llm failed', { prompt: systemPrompt });",
    "logger.info('source fetched', { url: sourceUrl });",
    "logger.info('x', { title: game.originalTitle });",
    'logger.info(`quick add for ${input}`);'
  ];

  for (const source of planted) {
    const calls = extractLoggerCalls(source);
    const matched = calls.some((call) => FORBIDDEN_LOG_KEYS.some(({ pattern }) => pattern.test(call.text)));

    assert.ok(matched, `the scanner must flag: ${source}`);
  }

  // And that it does not flag the safe, code-only metadata the modules do log.
  const safe = [
    "logger.info('play-session-created', { outcome: created.outcome, hasNote: created.note !== null });",
    "logger.info('catalog-quick-add-preview', { candidateCount: 3, aiFallbackUsed: false });",
    "logger.info('editorial-source-fetched', { host: url.hostname, status: 200 });",
    "logger.warn('today-feed-section-failed', { sectionKey, errorCategory: 'unknown' });"
  ];

  for (const source of safe) {
    const calls = extractLoggerCalls(source);
    const matched = calls.some((call) => FORBIDDEN_LOG_KEYS.some(({ pattern }) => pattern.test(call.text)));

    assert.equal(matched, false, `the scanner must not flag: ${source}`);
  }
});

test('the shared log sanitizer redacts Product 2.2 sensitive keys', () => {
  const sanitized = sanitizeLogMeta({
    note: 'a private playlog note',
    query: 'a raw search query',
    prompt: 'a raw prompt',
    originalTitle: 'A Game Name',
    userId: '00000000-0000-4000-8000-0000000000a1',
    catalogGameId: '00000000-0000-4000-8000-0000000000c1',
    outcome: 'CONTINUE',
    candidateCount: 3,
    aiFallbackUsed: true
  });

  // Free-text keys are dropped entirely.
  assert.equal(sanitized.query, '<redacted>');
  assert.equal(sanitized.prompt, '<redacted>');
  assert.equal(sanitized.originalTitle, '<redacted>');
  // Identifiers are hashed rather than dropped, so they stay correlatable.
  assert.match(sanitized.userId, /^sha256:[0-9a-f]{64}$/);
  // Structured codes and counters pass through unchanged.
  assert.equal(sanitized.outcome, 'CONTINUE');
  assert.equal(sanitized.candidateCount, 3);
  assert.equal(sanitized.aiFallbackUsed, true);

  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('a raw search query'), false);
  assert.equal(serialized.includes('a raw prompt'), false);
  assert.equal(serialized.includes('A Game Name'), false);
});

test('no Product 2.2 module persists a raw natural-language input column', () => {
  const schema = fs.readFileSync(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const submissionModel = schema.slice(
    schema.indexOf('model GameSubmission {'),
    schema.indexOf('@@map("game_submissions")')
  );

  // A fingerprint, yes; the input itself, never.
  assert.match(submissionModel, /inputFingerprint\s+String\s+@map\("input_fingerprint"\) @db\.Char\(64\)/);
  assert.doesNotMatch(submissionModel, /^\s*input\s+String/m);
  assert.doesNotMatch(submissionModel, /rawInput/);

  const compassModel = schema.slice(
    schema.indexOf('model PlayCompassEvent {'),
    schema.indexOf('@@map("play_compass_events")')
  );

  assert.match(compassModel, /requestHash\s+String\?\s+@map\("request_hash"\) @db\.Char\(64\)/);
  assert.doesNotMatch(compassModel, /rawRequest/);
});

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

const CONTRACT_PATH = path.resolve(process.cwd(), 'openapi/product-2.2.openapi.json');

test('the Product 2.2 OpenAPI document parses as OpenAPI 3.1', () => {
  const raw = fs.readFileSync(CONTRACT_PATH, 'utf8');
  const contract = JSON.parse(raw);

  assert.equal(contract.openapi, '3.1.0');
  assert.equal(contract.info.version, '2.2.0');
  assert.match(contract.info.title, /Product 2\.2/);
  // It must state plainly that it is a subset, like the cross-platform document.
  assert.match(contract.info.description, /not the complete backend API/i);
  assert.ok(contract.components.securitySchemes.bearerAuth);
  assert.deepEqual(contract.security, [{ bearerAuth: [] }]);
});

test('every $ref in the OpenAPI document resolves', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const broken = [];

  (function walk(node, pointer) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (typeof node.$ref === 'string') {
      const segments = node.$ref.replace(/^#\//, '').split('/');
      let value = contract;

      for (const segment of segments) {
        value = value?.[segment];
      }

      if (value === undefined) {
        broken.push(`${pointer} -> ${node.$ref}`);
      }
    }

    for (const [key, child] of Object.entries(node)) {
      walk(child, `${pointer}/${key}`);
    }
  })(contract, '');

  assert.deepEqual(broken, [], `unresolved $refs: ${broken.join(', ')}`);
});

test('every declared operation is under /api/v1 and registered by a canonical router', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const routerSources = [
    'src/modules/catalog/catalog.routes.js',
    'src/modules/play/play.routes.js',
    'src/modules/feed/feed.routes.js'
  ].map((file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')).join('\n');
  const missing = [];

  for (const [route, item] of Object.entries(contract.paths)) {
    assert.ok(route.startsWith('/api/v1/'), `${route} must live under /api/v1`);

    // Routers are mounted at /api/v1, so their declared path omits the prefix.
    const routerPath = route
      .slice('/api/v1'.length)
      .replace('{catalogGameId}', ':catalogGameId')
      .replace('{submissionId}', ':submissionId')
      .replace('{slug}', ':slug')
      .replace('{id}', ':id');

    for (const method of Object.keys(item)) {
      if (!routerSources.includes(`router.${method}('${routerPath}'`)) {
        missing.push(`${method.toUpperCase()} ${route}`);
      }
    }
  }

  assert.deepEqual(missing, [], `declared but not registered: ${missing.join(', ')}`);
});

test('every authenticated operation declares 401, and every gated one declares 503', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  // These two are deliberately not behind a kill switch.
  const ungatedRoutes = new Set(['/api/v1/product-config', '/api/v1/product-events']);

  for (const [route, item] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      assert.ok(operation.responses['401'], `${method.toUpperCase()} ${route} must declare 401`);

      if (!ungatedRoutes.has(route)) {
        assert.ok(operation.responses['503'], `${method.toUpperCase()} ${route} must declare 503 FEATURE_DISABLED`);
      } else {
        assert.equal(operation.responses['503'], undefined, `${route} must not declare a kill switch response`);
      }

      assert.ok(operation.operationId, `${method.toUpperCase()} ${route} must declare an operationId`);
    }
  }
});

test('editor operations declare 403 and the quick add preview declares 429', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

  for (const route of [
    '/api/v1/editorial/articles',
    '/api/v1/editorial/articles/{slug}',
    '/api/v1/editorial/articles/{slug}/publish',
    '/api/v1/editorial/articles/{slug}/retract'
  ]) {
    for (const operation of Object.values(contract.paths[route])) {
      assert.ok(operation.responses['403'], `${route} must declare 403`);
    }
  }

  assert.ok(contract.paths['/api/v1/catalog/submissions/preview'].post.responses['429']);
});

test('the contract documents the Product 2.2 invariants a client depends on', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const schemas = contract.components.schemas;

  // Public visibility always requires review.
  assert.equal(schemas.SubmissionPreviewResponse.properties.publicReviewStatus.const, 'PENDING_REVIEW');
  // At most one clarifying question and at most three candidates.
  assert.equal(schemas.SubmissionPreviewResponse.properties.clarifyingQuestions.maxItems, 1);
  assert.equal(schemas.SubmissionPreviewResponse.properties.existingCandidates.maxItems, 3);
  // At most three owned recommendations.
  assert.equal(schemas.PlayCompassResponse.properties.recommendations.maxItems, 3);
  assert.equal(schemas.PlayCompassResponse.properties.ownedOnly.const, true);
  // Game DNA is always deterministic.
  assert.equal(schemas.GameDna.properties.computation.properties.deterministic.const, true);
  // Playlog visibility defaults to PRIVATE.
  assert.equal(schemas.PlaySession.properties.visibility.default, 'PRIVATE');
  // All eight kill switches are part of the config contract.
  assert.deepEqual(schemas.ProductConfig.properties.features.required.sort(), [
    'aiQuickAdd', 'gameDNA', 'magazine', 'monthlyReplay', 'openCatalog', 'playCompass', 'playlog', 'todayFeed'
  ]);
  // Article sources carry a hash, not a body.
  const sourceProperties = schemas.Article.properties.sources.items.properties;
  assert.ok(sourceProperties.contentHash);
  assert.equal(sourceProperties.body, undefined);
  assert.equal(sourceProperties.excerpt.maxLength, 400);
});

test('the cross-platform gate contract is unchanged and still declares its own scope', () => {
  // Product 2.2 must not have edited the deployed mobile gate subset.
  const crossPlatform = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'openapi/cross-platform.openapi.json'), 'utf8')
  );

  assert.equal(crossPlatform.openapi, '3.1.0');
  assert.match(crossPlatform.info.description, /not the complete backend API/i);

  for (const route of Object.keys(crossPlatform.paths)) {
    assert.equal(route.startsWith('/api/v1'), false, `${route} must stay unversioned in the gate subset`);
  }
});
