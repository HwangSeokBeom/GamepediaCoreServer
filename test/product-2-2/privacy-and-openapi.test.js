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

test('the public article contract promises nothing the server cannot deliver', () => {
  // Round-2 finding D. The single Article schema had a nullable bodyMarkdown and a
  // nullable revision while its description claimed both were non-null for a
  // published article, and the server could in fact publish an empty body. The
  // contract is now split by audience, and each half states what its caller
  // actually gets.
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const schemas = contract.components.schemas;

  const publicArticle = schemas.PublicArticle;

  assert.ok(publicArticle, 'PublicArticle must exist');
  // Not a union with null: the server refuses to publish without a body.
  assert.equal(publicArticle.properties.bodyMarkdown.type, 'string');
  assert.equal(publicArticle.properties.bodyMarkdown.minLength, 1);
  assert.equal(publicArticle.properties.revision.type, 'object');
  assert.ok(publicArticle.required.includes('bodyMarkdown'));
  assert.ok(publicArticle.required.includes('revision'));
  assert.ok(publicArticle.properties.revision.required.includes('revisionNumber'));
  assert.equal(publicArticle.properties.bodyFormat.const, 'commonmark-no-html');
  // Only publicly readable statuses can appear.
  assert.deepEqual(publicArticle.properties.status.enum, ['PUBLISHED', 'CORRECTED']);
  // A correction note is documented as non-empty, and the server enforces it.
  assert.equal(publicArticle.properties.revision.properties.changeNote.minLength, 1);
  assert.match(publicArticle.properties.revision.properties.changeNote.description, /CORRECTED/);
  // Internal workflow fields must not be part of the public shape.
  for (const internalField of ['id', 'authorUserId', 'scheduledFor', 'retractedAt', 'aiDraftUsed']) {
    assert.equal(publicArticle.properties[internalField], undefined,
      `${internalField} must not be in PublicArticle`);
  }

  // The editor shape keeps the nullable draft body, which is honest there.
  const editorArticle = schemas.EditorArticle;

  assert.ok(editorArticle);
  assert.deepEqual(editorArticle.properties.bodyMarkdown.type, ['string', 'null']);
  assert.ok(editorArticle.properties.authorUserId);
  assert.ok(editorArticle.properties.aiDraftUsed);
  assert.match(editorArticle.properties.revision.properties.revisionNumber.description,
    /expectedRevisionNumber/);

  // A Today card carries no body at all.
  const summary = schemas.ArticleSummary;

  assert.ok(summary);
  assert.equal(summary.properties.bodyMarkdown, undefined, 'a summary must not carry a body');
  assert.ok(summary.properties.sourceCount);
  for (const field of [
    'publishedAt',
    'correctedAt',
    'heroImage',
    'heroImageWithheldReason',
    'relatedGames',
    'sourceCount'
  ]) {
    assert.ok(summary.required.includes(field), `ArticleSummary must require runtime field ${field}`);
  }
  assert.equal(
    summary.properties.relatedGames.items.$ref,
    '#/components/schemas/ArticleRelatedGame'
  );
  assert.equal(
    summary.properties.heroImage.$ref,
    '#/components/schemas/ArticleHeroImage'
  );
  assert.deepEqual(schemas.ArticleHeroImage.type, ['object', 'null']);

  // The endpoints must reference the right shape for their audience.
  assert.equal(
    contract.paths['/api/v1/articles/{slug}'].get
      .responses['200'].content['application/json'].schema.allOf[1]
      .properties.data.properties.article.$ref,
    '#/components/schemas/PublicArticle'
  );
  assert.equal(
    contract.paths['/api/v1/editorial/articles'].get
      .responses['200'].content['application/json'].schema.allOf[1]
      .properties.data.properties.articles.items.$ref,
    '#/components/schemas/EditorArticle'
  );

  // The legacy alias stays resolvable for an already generated client.
  assert.equal(schemas.Article.deprecated, true);
});

test('the Today response reaches every key-specific data contract and ArticleSummary', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const responseSchema = contract.paths['/api/v1/users/me/today'].get
    .responses['200'].content['application/json'].schema;
  const reachableRefs = new Set();
  const visitedRefs = new Set();

  function resolveLocalRef(ref) {
    return ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((value, segment) => value?.[segment], contract);
  }

  function walkReachable(node) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (typeof node.$ref === 'string') {
      reachableRefs.add(node.$ref);

      if (visitedRefs.has(node.$ref)) {
        return;
      }

      visitedRefs.add(node.$ref);
      walkReachable(resolveLocalRef(node.$ref));
      return;
    }

    for (const child of Object.values(node)) {
      walkReachable(child);
    }
  }

  walkReachable(responseSchema);

  const sectionContracts = [
    [
      'playCompass',
      'TodayPlayCompassSection',
      'TodayPlayCompassData',
      ['recommendations', 'confidence', 'dataFreshness', 'emptyReason', 'ownedOnly']
    ],
    [
      'gameDNA',
      'TodayGameDnaSection',
      'TodayGameDnaData',
      [
        'signalCount',
        'confidence',
        'generatedAt',
        'topGenres',
        'sessionLengthLabel',
        'socialLabel',
        'toneLabel',
        'missingSignals',
        'reasonCodes'
      ]
    ],
    [
      'gameBriefing',
      'TodayGameBriefingSection',
      'TodayGameBriefingData',
      ['items', 'emptyReason', 'generatedAt']
    ],
    ['backlogRescue', 'TodayBacklogRescueSection', 'TodayBacklogRescueData', ['items', 'emptyReason']],
    [
      'spoilerFreeStartGuide',
      'TodaySpoilerFreeStartGuideSection',
      'TodaySpoilerFreeStartGuideData',
      ['items', 'emptyReason']
    ],
    [
      'editorialCuration',
      'TodayEditorialCurationSection',
      'TodayEditorialCurationData',
      ['articles', 'emptyReason']
    ],
    [
      'monthlyReplay',
      'TodayMonthlyReplaySection',
      'TodayMonthlyReplayData',
      [
        'monthKey',
        'timezone',
        'isEmpty',
        'playedDayCount',
        'totalMinutes',
        'mostPlayedGame',
        'surpriseGame',
        'missingData'
      ]
    ],
    ['friendActivity', 'TodayFriendActivitySection', 'TodayFriendActivityData', ['items', 'emptyReason']]
  ];

  for (const ref of [
    '#/components/schemas/TodayFeed',
    '#/components/schemas/TodaySection',
    ...sectionContracts.flatMap(([, sectionSchema, dataSchema]) => [
      `#/components/schemas/${sectionSchema}`,
      `#/components/schemas/${dataSchema}`
    ]),
    '#/components/schemas/ArticleSummary'
  ]) {
    assert.ok(reachableRefs.has(ref), `Today 200 response must reach ${ref}`);
  }

  const schemas = contract.components.schemas;

  assert.equal(schemas.TodayFeed.properties.sections.items.$ref, '#/components/schemas/TodaySection');
  assert.equal(
    schemas.TodayEditorialCurationData.properties.articles.items.$ref,
    '#/components/schemas/ArticleSummary'
  );
  assert.equal(schemas.TodayOtherSection, undefined, 'no Today key may fall back to an opaque object');
  assert.equal(schemas.TodaySection.oneOf.length, sectionContracts.length);

  for (const [key, sectionSchemaName, dataSchemaName, expectedDataKeys] of sectionContracts) {
    const sectionRef = `#/components/schemas/${sectionSchemaName}`;
    const dataRef = `#/components/schemas/${dataSchemaName}`;
    const sectionSchema = schemas[sectionSchemaName];
    const okBranch = sectionSchema.oneOf[0];
    const dataSchema = schemas[dataSchemaName];

    assert.equal(schemas.TodaySection.discriminator.mapping[key], sectionRef);
    assert.ok(
      schemas.TodaySection.oneOf.some((branch) => branch.$ref === sectionRef),
      `TodaySection must include ${sectionRef}`
    );
    assert.equal(okBranch.properties.key.const, key);
    assert.equal(okBranch.properties.status.const, 'ok');
    assert.equal(okBranch.properties.data.$ref, dataRef);
    assert.equal(dataSchema.type, 'object');
    assert.equal(dataSchema.additionalProperties, false);
    assert.deepEqual(
      [...dataSchema.required].sort(),
      [...expectedDataKeys].sort(),
      `${dataSchemaName} must require every runtime field`
    );
    assert.deepEqual(
      Object.keys(dataSchema.properties).sort(),
      [...expectedDataKeys].sort(),
      `${dataSchemaName} must neither omit runtime fields nor invent extras`
    );
  }

  assert.equal(schemas.TodayPlayCompassData.properties.recommendations.type, 'array');
  assert.equal(
    schemas.TodayPlayCompassData.properties.recommendations.items.$ref,
    '#/components/schemas/PlayCompassRecommendation'
  );
  assert.equal(
    schemas.PlayCompassResponse.properties.recommendations.items.$ref,
    '#/components/schemas/PlayCompassRecommendation'
  );
  assert.equal(
    schemas.TodayPlayCompassData.properties.dataFreshness.$ref,
    '#/components/schemas/PlayCompassDataFreshness'
  );
  assert.equal(
    schemas.PlayCompassResponse.properties.dataFreshness.$ref,
    '#/components/schemas/PlayCompassDataFreshness'
  );
  assert.deepEqual(
    schemas.PlayCompassDataFreshness.required,
    ['candidatePoolSize', 'freshestLibraryUpdateAt', 'playlogSampleSize', 'stale']
  );
  assert.deepEqual(
    schemas.PlayCompassResponse.properties.emptyReason.enum,
    ['no_owned_playing_or_backlog_games', 'no_candidate_matched_constraints', null]
  );
  assert.deepEqual(
    schemas.TodayPlayCompassData.properties.emptyReason.enum,
    schemas.PlayCompassResponse.properties.emptyReason.enum
  );
  assert.equal(schemas.PlayCompassRecommendation.additionalProperties, false);
  assert.equal(schemas.PlayCompassRecommendation.properties.scoreComponents.additionalProperties, false);
  assert.deepEqual(
    schemas.PlayCompassRecommendation.properties.scoreComponents.required,
    ['platform', 'timeFit', 'continuity', 'social', 'energy', 'mood', 'recency', 'snooze']
  );
  assert.equal(
    schemas.PlayCompassRecommendation.properties.ownershipEvidence.properties.installEvidence
      .properties.reason.const,
    'install_state_not_tracked'
  );
  assert.equal(schemas.TodayGameBriefingData.properties.items.items.type, 'object');
  assert.equal(schemas.TodayBacklogRescueData.properties.items.items.type, 'object');
  assert.equal(schemas.TodaySpoilerFreeStartGuideData.properties.items.items.type, 'object');
  assert.equal(schemas.TodayMonthlyReplayData.properties.missingData.items.type, 'object');
  assert.equal(schemas.TodayFriendActivityData.properties.items.items.type, 'object');
  assert.ok(schemas.TodayFeed.required.includes('timezone'));
  assert.ok(schemas.TodayFeed.required.includes('locale'));
  assert.ok(schemas.TodayFeed.properties.meta.required.includes('limit'));
});

test('the generated-client contract avoids unsupported null and nested-property references', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const unsupportedNullSchemas = [];
  const nestedPropertyRefs = [];

  (function walk(node, pointer) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (node.type === 'null') {
      unsupportedNullSchemas.push(pointer);
    }

    if (typeof node.$ref === 'string' && /\/properties\//.test(node.$ref)) {
      nestedPropertyRefs.push(`${pointer} -> ${node.$ref}`);
    }

    for (const [key, child] of Object.entries(node)) {
      walk(child, `${pointer}/${key}`);
    }
  })(contract, '');

  assert.deepEqual(unsupportedNullSchemas, []);
  assert.deepEqual(nestedPropertyRefs, []);
});

test('the Redocly exception is scoped only to the deprecated Article alias', () => {
  const ignorePath = path.resolve(process.cwd(), '.redocly.lint-ignore.yaml');
  const ignore = fs.readFileSync(ignorePath, 'utf8');
  const ignoredPointers = [...ignore.matchAll(/^\s+- '(#[^']+)'$/gm)].map((match) => match[1]);
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

  assert.deepEqual(ignoredPointers, ['#/components/schemas/Article']);
  assert.equal(contract.components.schemas.Article.deprecated, true);
  assert.equal(contract.components.responses.FeatureStateUnavailable, undefined);
});

test('the iOS generated-client gate is version-pinned and exercises decoding plus the Simulator SDK', () => {
  const fixtureRoot = path.resolve(process.cwd(), 'scripts/test/swift-openapi-client');
  const manifest = fs.readFileSync(path.join(fixtureRoot, 'Package.swift'), 'utf8');
  const resolved = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'Package.resolved'), 'utf8'));
  const generatorConfig = fs.readFileSync(
    path.join(fixtureRoot, 'Sources/ContractSmoke/openapi-generator-config.yaml'),
    'utf8'
  );
  const smoke = fs.readFileSync(
    path.join(fixtureRoot, 'Sources/ContractSmoke/main.swift'),
    'utf8'
  );
  const gate = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/test/run-ios-openapi-contract-gate.sh'),
    'utf8'
  );
  const pins = new Map(resolved.pins.map((pin) => [pin.identity, pin.state.version]));

  assert.match(manifest, /swift-openapi-generator",\s*exact: "1\.11\.1"/);
  assert.match(manifest, /swift-openapi-runtime",\s*exact: "1\.12\.0"/);
  assert.equal(pins.get('swift-openapi-generator'), '1.11.1');
  assert.equal(pins.get('swift-openapi-runtime'), '1.12.0');
  assert.equal(resolved.pins.every((pin) => typeof pin.state.revision === 'string'), true);
  assert.match(generatorConfig, /generate:\s*\n\s+- types\s*\n\s+- client/);
  assert.match(smoke, /JSONDecoder/);
  assert.match(smoke, /Components\.Schemas\.ArticleSummary/);
  assert.match(smoke, /Components\.Schemas\.TodayFeed/);
  // The iOS-blocking operations must be decoded by the generated types, not merely
  // declared in the document.
  for (const generated of [
    'SubmissionConfirmEnvelope',
    'SubmissionStateEnvelope',
    'CatalogSearchEnvelope',
    'PlaySessionListEnvelope'
  ]) {
    assert.match(smoke, new RegExp(`Components\\.Schemas\\.${generated}`),
      `${generated} must be exercised by the generated-client smoke`);
  }

  // And the reachability the client was blocked on must be asserted, not just decoded.
  assert.match(smoke, /precondition\(confirmCreated\.data\.catalogGameId ==/);
  assert.match(smoke, /precondition\(searchFirstPage\.data\.meta\.nextCursor ==/);
  assert.match(smoke, /precondition\(playSessionPage\.data\.meta\.nextCursor\?\.isEmpty == false\)/);
  assert.match(gate, /swift run ContractSmoke/);
  assert.match(gate, /generic\/platform=iOS Simulator/);
  assert.match(gate, /Swift OpenAPI Generator emitted a warning/);
});

test('the contract documents the concurrency check and every editorial conflict code', () => {
  // Round-2 finding C. A client cannot handle a lost update it was never told about.
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

  for (const [route, method] of [
    ['/api/v1/editorial/articles/{slug}', 'patch'],
    ['/api/v1/editorial/articles/{slug}/publish', 'post'],
    ['/api/v1/editorial/articles/{slug}/retract', 'post']
  ]) {
    const operation = contract.paths[route][method];
    const properties = operation.requestBody.content['application/json'].schema.properties;

    assert.ok(properties.expectedRevisionNumber,
      `${method.toUpperCase()} ${route} must document expectedRevisionNumber`);
    assert.match(properties.expectedRevisionNumber.description, /ARTICLE_CONCURRENT_MODIFICATION/);
    assert.ok(operation.responses['409'], `${method.toUpperCase()} ${route} must declare 409`);
  }

  // Publish must keep accepting a bodyless POST: that is the shipped contract.
  assert.equal(
    contract.paths['/api/v1/editorial/articles/{slug}/publish'].post.requestBody.required,
    false
  );

  const conflict = contract.components.responses.Conflict.description;

  for (const code of [
    'ARTICLE_CONCURRENT_MODIFICATION',
    'ARTICLE_CORRECTION_REQUIRED',
    'ARTICLE_CORRECTION_NOTE_REQUIRED',
    'ARTICLE_CORRECTION_EMPTY',
    'ARTICLE_BODY_REQUIRED_FOR_PUBLICATION',
    'ARTICLE_MARKDOWN_RESOURCE_NOT_ALLOWED',
    'ARTICLE_HERO_RIGHTS_UNRESOLVED',
    'IDENTITY_UNVERIFIED_OCCUPANT'
  ]) {
    assert.match(conflict, new RegExp(code), `the Conflict response must document ${code}`);
  }

  // And the write-time Markdown rejection is documented on the 400 as well.
  assert.match(contract.components.responses.ValidationError.description,
    /ARTICLE_MARKDOWN_RESOURCE_NOT_ALLOWED/);
  assert.match(contract.components.responses.ValidationError.description,
    /INVALID_UNICODE_TEXT/);
  // Whatever else it says, it must promise that the destination is not echoed back.
  assert.match(contract.components.responses.ValidationError.description,
    /reason codes only, never the offending destination/);
});

test('the iOS-blocking operations answer typed schemas instead of an opaque object', () => {
  // Four operations referenced the generic SuccessEnvelope, or declared meta as a
  // bare `{ type: object }`. A generated Swift client could therefore reach neither
  // the confirmed catalogGameId, nor the submission's status and resolution, nor
  // either pagination cursor. Each now has a dedicated typed envelope.
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

  function resolve(pointer) {
    return pointer.replace(/^#\//, '').split('/').reduce((node, segment) => node?.[segment], contract);
  }

  function deref(schema) {
    let current = schema;

    while (current && typeof current.$ref === 'string') {
      current = resolve(current.$ref);
    }

    return current;
  }

  /// The chain an operation's response body follows to a concrete `data` schema.
  /// Every hop must be a $ref, which is what makes the type reachable in a
  /// generated client rather than an inline anonymous shape.
  function dataSchemaOf(route, method, status) {
    const body = contract.paths[route][method].responses[status].content['application/json'].schema;

    assert.equal(typeof body.$ref, 'string', `${method} ${route} ${status} must $ref a named envelope`);
    assert.notEqual(body.$ref, '#/components/schemas/SuccessEnvelope',
      `${method} ${route} ${status} must not reuse the generic envelope`);

    const envelope = deref(body);

    assert.equal(typeof envelope.properties.data.$ref, 'string',
      `${method} ${route} ${status} must $ref a named data schema`);

    return deref(envelope.properties.data);
  }

  // 1. confirmCatalogSubmission — typed result, reachable catalogGameId.
  const confirmRoute = '/api/v1/catalog/submissions/{submissionId}/confirm';

  for (const status of ['200', '201']) {
    const result = dataSchemaOf(confirmRoute, 'post', status);

    assert.equal(result.type, 'object');
    assert.deepEqual([...result.required].sort(), [
      'catalogGameId', 'createdNewGame', 'idempotentReplay', 'identityConflict',
      'publicReviewStatus', 'status', 'submissionId'
    ]);
    // The id the client is blocked on, typed as a uuid rather than a free object.
    assert.deepEqual(result.properties.catalogGameId.type, ['string', 'null']);
    assert.equal(result.properties.catalogGameId.format, 'uuid');
    assert.equal(result.properties.status.$ref, '#/components/schemas/GameSubmissionStatus');
    assert.equal(result.properties.publicReviewStatus.$ref, '#/components/schemas/CatalogPublicationStatus');
    assert.equal(result.properties.createdNewGame.type, 'boolean');
    assert.equal(result.properties.idempotentReplay.type, 'boolean');

    // The conflict is a named schema too, down to the provider and the reason code.
    const conflict = deref(result.properties.identityConflict);

    assert.deepEqual(conflict.type, ['object', 'null']);
    assert.deepEqual([...conflict.required].sort(), ['existingCatalogGameId', 'provider', 'reasonCode']);
    assert.equal(conflict.properties.provider.$ref, '#/components/schemas/CatalogIdentityProvider');
    assert.equal(conflict.properties.existingCatalogGameId.format, 'uuid');
    assert.deepEqual(conflict.properties.reasonCode.enum, ['verified_identity_already_exists']);
  }

  // Both statuses must describe the same result, or a client has to branch on the code.
  assert.equal(
    contract.paths[confirmRoute].post.responses['200'].content['application/json'].schema.$ref,
    contract.paths[confirmRoute].post.responses['201'].content['application/json'].schema.$ref
  );

  // 2. getCatalogSubmission — typed status, resolution and resulting game.
  const state = dataSchemaOf('/api/v1/catalog/submissions/{submissionId}', 'get', '200');

  assert.deepEqual([...state.required].sort(), [
    'aiFallbackUsed', 'candidateSummary', 'catalogGameId', 'clarifyingQuestions', 'createdAt',
    'draftReadable', 'expired', 'expiresAt', 'inputType', 'locale', 'newGameDraft', 'platformHint',
    'publicReviewStatus', 'regionCode', 'status', 'submissionId', 'updatedAt'
  ]);
  assert.equal(state.properties.status.$ref, '#/components/schemas/GameSubmissionStatus');
  assert.equal(state.properties.inputType.$ref, '#/components/schemas/GameSubmissionInputType');
  assert.equal(state.properties.catalogGameId.format, 'uuid');
  assert.equal(state.properties.draftReadable.type, 'boolean');

  // The resolution the client needs: the re-validated draft, reachable field by field.
  const draft = deref(state.properties.newGameDraft);

  assert.deepEqual(draft.type, ['object', 'null']);
  assert.deepEqual([...draft.required].sort(), [
    'fieldProvenance', 'genres', 'identities', 'localizations', 'originalTitle',
    'platforms', 'regionalReleases', 'requiresTitleConfirmation'
  ]);
  // The optional draft fields are omitted by the server when empty, so requiring
  // them would promise something the wire does not carry.
  for (const optional of ['developerName', 'publisherName', 'firstReleaseDate',
    'supportsSinglePlayer', 'supportsMultiplayer', 'typicalSessionMinutes']) {
    assert.ok(draft.properties[optional], `${optional} must be declared`);
    assert.equal(draft.required.includes(optional), false, `${optional} must not be required`);
  }

  assert.equal(deref(draft.properties.localizations.items).properties.kind.enum.length, 3);
  assert.equal(deref(draft.properties.regionalReleases.items).properties.serviceStatus.$ref,
    '#/components/schemas/CatalogServiceStatus');
  assert.equal(deref(draft.properties.identities.items).properties.provider.$ref,
    '#/components/schemas/CatalogIdentityProvider');
  assert.equal(deref(draft.properties.fieldProvenance.items).properties.provenance.$ref,
    '#/components/schemas/CatalogProvenance');
  assert.ok(deref(state.properties.candidateSummary).properties.candidateCount);
  assert.equal(state.properties.clarifyingQuestions.maxItems, 1);

  // 3 & 4. Both cursors reachable as typed values.
  const search = dataSchemaOf('/api/v1/catalog/games/search', 'get', '200');
  const searchMeta = deref(search.properties.meta);

  assert.deepEqual([...search.required].sort(), ['games', 'meta']);
  assert.equal(search.properties.games.items.$ref, '#/components/schemas/CatalogGameSummary');
  assert.deepEqual([...searchMeta.required].sort(), ['limit', 'matchedBy', 'nextCursor', 'totalScanned']);
  assert.deepEqual(searchMeta.properties.nextCursor.type, ['string', 'null']);
  assert.deepEqual(searchMeta.properties.matchedBy.enum,
    ['empty_query', 'no_match', 'normalized_title_exact', 'ranked']);

  const playSessions = dataSchemaOf('/api/v1/users/me/play-sessions', 'get', '200');
  const playMeta = deref(playSessions.properties.meta);

  assert.deepEqual([...playSessions.required].sort(), ['meta', 'playSessions']);
  assert.equal(playSessions.properties.playSessions.items.$ref, '#/components/schemas/PlaySession');
  // Only the two keys the runtime actually emits; no invented total or page count.
  assert.deepEqual([...playMeta.required].sort(), ['limit', 'nextCursor']);
  assert.deepEqual(Object.keys(playMeta.properties).sort(), ['limit', 'nextCursor']);
  assert.deepEqual(playMeta.properties.nextCursor.type, ['string', 'null']);

  // No target response may leave an untyped object behind.
  for (const [route, method, status] of [
    [confirmRoute, 'post', '200'], [confirmRoute, 'post', '201'],
    ['/api/v1/catalog/submissions/{submissionId}', 'get', '200'],
    ['/api/v1/catalog/games/search', 'get', '200'],
    ['/api/v1/users/me/play-sessions', 'get', '200']
  ]) {
    (function assertNoOpaqueObject(node, pointer) {
      if (!node || typeof node !== 'object') {
        return;
      }

      if (node.type === 'object' && !node.properties && !node.$ref && node.additionalProperties !== true) {
        assert.fail(`${method.toUpperCase()} ${route} ${status}: opaque object at ${pointer}`);
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== '$ref') {
          assertNoOpaqueObject(child, `${pointer}/${key}`);
        }
      }
    })(dataSchemaOf(route, method, status), `${method} ${route} ${status}`);
  }
});

test('the generic SuccessEnvelope is untouched, so unrelated operations still generate', () => {
  // The typed envelopes are additive. Stretching SuccessEnvelope itself would have
  // changed every other operation's generated type.
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const envelope = contract.components.schemas.SuccessEnvelope;

  assert.deepEqual(envelope.required, ['success', 'data']);
  assert.equal(envelope.properties.success.const, true);
  assert.deepEqual(envelope.properties.data, { type: 'object' });

  // It is still the schema every non-target operation answers with.
  const stillGeneric = [];

  for (const [route, item] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const schema = response.content?.['application/json']?.schema;

        if (schema?.$ref === '#/components/schemas/SuccessEnvelope') {
          stillGeneric.push(`${method.toUpperCase()} ${route} ${status}`);
        }
      }
    }
  }

  assert.ok(stillGeneric.length > 0, 'the generic envelope must remain in use by other operations');

  // ...but none of the four operations this change targeted. Matched on the exact
  // route, because sibling routes share a prefix: /play-sessions/calendar is a
  // separate, unpaginated operation that deliberately keeps the generic envelope.
  const targetedOperations = new Set([
    'POST /api/v1/catalog/submissions/{submissionId}/confirm',
    'GET /api/v1/catalog/submissions/{submissionId}',
    'GET /api/v1/catalog/games/search',
    'GET /api/v1/users/me/play-sessions'
  ]);

  for (const entry of stillGeneric) {
    const operation = entry.split(' ').slice(0, 2).join(' ');

    assert.equal(targetedOperations.has(operation), false,
      `${operation} must no longer answer the generic envelope`);
  }

  // The unpaginated calendar operation has no cursor, so no dedicated page schema
  // was invented for it; it must still be reachable through the generic envelope.
  assert.ok(stillGeneric.some((entry) => entry.startsWith('GET /api/v1/users/me/play-sessions/calendar ')),
    'the calendar operation must be left as it is');
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
