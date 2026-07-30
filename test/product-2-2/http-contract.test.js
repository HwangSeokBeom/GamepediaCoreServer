const test = require('node:test');
const assert = require('node:assert/strict');
const { USER_A, USER_B, CATALOG_GAME_A, stubPrisma } = require('./helpers/test-env');

const authMiddleware = require('../../src/middlewares/auth.middleware');
const { AppError } = require('../../src/utils/error-response');

// HTTP-level contract for the Product 2.2 surface.
//
// The auth middleware is replaced before src/app is required, because every
// router destructures it at module load. `authState` lets an individual test
// switch between authenticated, unauthenticated and a second account.

const authState = { userId: USER_A, authenticated: true };

authMiddleware.authenticateAccessToken = (req, res, next) => {
  if (!authState.authenticated) {
    next(new AppError(401, 'UNAUTHORIZED', 'A valid bearer access token is required'));
    return;
  }

  req.auth = { userId: authState.userId, email: 'contract@example.invalid', status: 'ACTIVE' };
  next();
};

const catalogService = require('../../src/modules/catalog/catalog.service');
const catalogSubmissionService = require('../../src/modules/catalog/catalog-submission.service');
const playlogService = require('../../src/modules/play/playlog.service');
const gameDnaService = require('../../src/modules/play/game-dna.service');
const playCompassService = require('../../src/modules/play/play-compass.service');
const monthlyReplayService = require('../../src/modules/play/monthly-replay.service');
const articleService = require('../../src/modules/feed/article.service');
const todayService = require('../../src/modules/feed/today.service');
const productEventService = require('../../src/modules/product/product-event.service');
const userRoleService = require('../../src/modules/product/user-role.service');

const { app } = require('../../src/app');
const contract = require('../../openapi/product-2.2.openapi.json');

const OWNED_SESSION_ID = '00000000-0000-4000-8000-0000000000e1';
const SUBMISSION_ID = '00000000-0000-4000-8000-0000000000f1';
const CLIENT_MUTATION_ID = 'http-contract-mutation-1';

function isoNow() {
  return new Date('2026-07-30T12:00:00.000Z').toISOString();
}

function sessionFixture() {
  return {
    id: OWNED_SESSION_ID,
    catalogGameId: CATALOG_GAME_A,
    regionalReleaseId: null,
    playedAt: new Date('2026-07-15T10:00:00.000Z'),
    durationMinutes: 90,
    progressPercent: 40,
    mood: 'FOCUSED',
    note: null,
    outcome: 'CONTINUE',
    visibility: 'PRIVATE',
    provenance: 'USER_CONFIRMED',
    clientMutationId: CLIENT_MUTATION_ID,
    createdAt: new Date('2026-07-15T10:05:00.000Z'),
    updatedAt: new Date('2026-07-15T10:05:00.000Z')
  };
}

// --- service stubs: the HTTP layer is what is under test here ---
catalogService.searchCatalogGames = async () => ({ games: [], meta: { limit: 20, nextCursor: null, matchedBy: 'no_match', totalScanned: 0 } });
catalogService.getCatalogGameDetail = async ({ catalogGameId }) => ({
  catalogGameId,
  originalTitle: 'Fixture Game',
  slug: 'fixture-game',
  developerName: null,
  publisherName: null,
  firstReleaseDate: null,
  genres: [],
  platforms: [],
  publicationStatus: 'PUBLISHED',
  titleProvenance: 'PROVIDER_VERIFIED',
  identities: [],
  steamTags: [],
  supportsSinglePlayer: null,
  supportsMultiplayer: null,
  typicalSessionMinutes: null,
  localizations: [],
  regionalReleases: [],
  assets: [],
  fieldEvidence: [],
  createdAt: isoNow(),
  updatedAt: isoNow(),
  requestedCatalogGameId: catalogGameId,
  resolvedFromMerge: false,
  isFollowedByMe: false
});
catalogService.followCatalogGame = async ({ catalogGameId }) => ({ catalogGameId, following: true, created: true });
catalogService.unfollowCatalogGame = async ({ catalogGameId }) => ({ catalogGameId, following: false, removed: true });
catalogService.submitCatalogCorrection = async ({ catalogGameId }) => ({ catalogGameId, recordedCount: 1, reviewStatus: 'PENDING_REVIEW' });

catalogSubmissionService.previewSubmission = async () => ({
  submissionId: SUBMISSION_ID,
  createdAt: isoNow(),
  expiresAt: isoNow(),
  existingCandidates: [],
  newGameDraft: { originalTitle: null, requiresTitleConfirmation: true },
  fieldProvenance: [],
  clarifyingQuestions: [],
  resolution: { stage: 'manual_draft', aiUsed: true, aiFallbackUsed: true, degradeReason: 'missing_api_key' },
  personalRegistrationAvailable: true,
  publicReviewStatus: 'PENDING_REVIEW'
});
catalogSubmissionService.confirmSubmission = async () => ({
  submissionId: SUBMISSION_ID,
  status: 'PERSONAL_CONFIRMED',
  catalogGameId: CATALOG_GAME_A,
  createdNewGame: true,
  idempotentReplay: false,
  publicReviewStatus: 'PRIVATE'
});
catalogSubmissionService.getSubmission = async ({ userId, submissionId }) => {
  // Mirrors the real ownership rule so the HTTP boundary can be checked.
  if (userId !== USER_A) {
    throw new AppError(404, 'SUBMISSION_NOT_FOUND', 'Game submission could not be found');
  }

  return { submissionId, status: 'PREVIEW', publicReviewStatus: 'PRIVATE' };
};

playlogService.listPlaySessions = async ({ userId }) => ({
  sessions: userId === USER_A ? [sessionFixture()] : [],
  meta: { limit: 20, nextCursor: null }
});
playlogService.createPlaySession = async () => ({ session: sessionFixture(), idempotentReplay: false });
playlogService.updatePlaySession = async ({ userId }) => {
  if (userId !== USER_A) {
    throw new AppError(404, 'PLAY_SESSION_NOT_FOUND', 'Play session could not be found');
  }

  return { session: sessionFixture(), idempotentReplay: false };
};
playlogService.deletePlaySession = async ({ userId }) => {
  if (userId !== USER_A) {
    throw new AppError(404, 'PLAY_SESSION_NOT_FOUND', 'Play session could not be found');
  }

  return { deleted: true, idempotentReplay: false };
};
playlogService.getPlayCalendar = async ({ month, timezone }) => ({
  monthKey: month,
  timezone,
  windowStartUtc: isoNow(),
  windowEndUtc: isoNow(),
  days: [],
  summary: { dayCount: 0, playedDayCount: 0, sessionCount: 0, totalMinutes: 0, sessionsWithoutDuration: 0, isEmpty: true }
});

gameDnaService.getGameDna = async () => ({
  signalCount: 0,
  confidence: 'LOW',
  generatedAt: isoNow(),
  dataFreshness: { freshestSignalAt: null, recentWindowDays: 30, recentSignalCount: 0, stale: true },
  genreProfile: { topGenres: [], distinctGenreCount: 0, distinctSteamTagCount: 0, concentration: null },
  completionProfile: {},
  sessionLengthProfile: { label: 'UNKNOWN' },
  socialProfile: { label: 'BALANCED' },
  toneProfile: { label: 'BALANCED' },
  ratingProfile: { averageRating: null, ratingCount: 0 },
  missingSignals: ['ratings'],
  reasonCodes: [],
  computation: { deterministic: true, aiNarrationIncluded: false }
});
playCompassService.recommend = async () => ({
  recommendations: [],
  confidence: 'LOW',
  generatedAt: isoNow(),
  dataFreshness: { candidatePoolSize: 0, freshestLibraryUpdateAt: null, stale: true },
  emptyReason: 'no_owned_playing_or_backlog_games',
  ownedOnly: true,
  requestHash: 'a'.repeat(64)
});
playCompassService.recordCompassEvent = async () => ({ eventRecordId: 'evt-1', action: 'SELECTED', occurredAt: isoNow() });
monthlyReplayService.getMonthlyReplay = async ({ month, timezone }) => ({
  monthKey: month,
  timezone,
  window: { startUtc: isoNow(), endUtc: isoNow(), localDayCount: 31 },
  generatedAt: isoNow(),
  isEmpty: true,
  emptyReason: 'no_play_sessions_recorded_in_month',
  playedDates: [],
  totals: { sessionCount: 0, playedDayCount: 0, totalMinutes: 0, minutesKnownForAllSessions: true, distinctGameCount: 0 },
  startedGames: [],
  completedGames: [],
  droppedGames: [],
  mostPlayedGame: null,
  surpriseGame: null,
  genreDistribution: {},
  moodDistribution: {},
  perGame: [],
  provenance: { basis: 'user_playlog', sessionProvenanceCounts: {}, deterministic: true },
  missingData: []
});

todayService.getTodayFeed = async ({ timezone, locale }) => ({
  generatedAt: isoNow(),
  timezone,
  locale: locale ?? null,
  sections: todayService.SECTION_ORDER.map((key) => ({ key, status: 'ok', reasonCode: null, data: {} })),
  meta: { sectionOrder: [...todayService.SECTION_ORDER], limit: 8, nextCursor: null, partialFailure: false }
});
articleService.getPublishedArticleBySlug = async ({ slug }) => ({
  slug,
  status: 'PUBLISHED',
  locale: 'ko',
  headline: 'Fixture Headline',
  excerpt: 'Fixture excerpt.',
  publishedAt: isoNow(),
  correctedAt: null,
  retractedAt: null,
  heroImage: null,
  heroImageWithheldReason: null,
  sources: [],
  relatedGames: []
});
articleService.listArticlesForEditor = async () => ({ articles: [] });
articleService.createArticle = async ({ input }) => ({ slug: input.slug, status: 'DRAFT', locale: input.locale, headline: input.headline, excerpt: input.excerpt, sources: [], relatedGames: [] });
articleService.updateArticle = async ({ slug }) => ({ slug, status: 'FACT_CHECK', locale: 'ko', headline: 'h', excerpt: 'e', sources: [], relatedGames: [] });
articleService.publishArticle = async ({ slug }) => ({ slug, status: 'PUBLISHED', locale: 'ko', headline: 'h', excerpt: 'e', sources: [], relatedGames: [] });
articleService.retractArticle = async ({ slug }) => ({ slug, status: 'RETRACTED', locale: 'ko', headline: 'h', excerpt: 'e', sources: [], relatedGames: [] });
productEventService.recordProductEvents = async ({ events }) => ({
  acceptedCount: events.length,
  duplicateCount: 0,
  results: events.map((event) => ({ eventId: event.eventId, status: 'recorded', droppedPropertyKeys: [] }))
});

async function listen() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

async function request(baseUrl, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: method.toUpperCase(),
    headers: {
      authorization: 'Bearer fixture',
      connection: 'close',
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  return { status: response.status, payload: await response.json() };
}

/// Every Product 2.2 operation with a representative request body.
const OPERATIONS = [
  ['get', '/api/v1/catalog/games/search?query=portal', undefined, 200],
  ['get', `/api/v1/catalog/games/${CATALOG_GAME_A}`, undefined, 200],
  ['post', '/api/v1/catalog/submissions/preview', { inputType: 'TEXT', input: 'some game', locale: 'ko', regionCode: 'KR' }, 200],
  ['post', `/api/v1/catalog/submissions/${SUBMISSION_ID}/confirm`, { requestPublicReview: false }, 201],
  ['get', `/api/v1/catalog/submissions/${SUBMISSION_ID}`, undefined, 200],
  ['post', `/api/v1/catalog/games/${CATALOG_GAME_A}/corrections`, { corrections: [{ fieldPath: 'developerName', proposedValue: 'Team Cherry' }] }, 202],
  ['put', `/api/v1/catalog/games/${CATALOG_GAME_A}/follow`, {}, 200],
  ['delete', `/api/v1/catalog/games/${CATALOG_GAME_A}/follow`, undefined, 200],
  ['get', '/api/v1/users/me/play-sessions', undefined, 200],
  ['post', '/api/v1/users/me/play-sessions', {
    catalogGameId: CATALOG_GAME_A,
    playedAt: '2026-07-15T10:00:00.000Z',
    outcome: 'CONTINUE',
    clientMutationId: CLIENT_MUTATION_ID
  }, 201],
  ['patch', `/api/v1/users/me/play-sessions/${OWNED_SESSION_ID}`, { outcome: 'COMPLETED' }, 200],
  ['delete', `/api/v1/users/me/play-sessions/${OWNED_SESSION_ID}`, {}, 200],
  ['get', '/api/v1/users/me/play-sessions/calendar?month=2026-07&timezone=Asia%2FSeoul', undefined, 200],
  ['get', '/api/v1/users/me/game-dna', undefined, 200],
  ['post', '/api/v1/users/me/play-compass', { availableMinutes: 60 }, 200],
  ['post', '/api/v1/users/me/play-compass/events', { catalogGameId: CATALOG_GAME_A, action: 'SELECTED' }, 201],
  ['get', '/api/v1/users/me/replays/monthly?month=2026-07&timezone=Asia%2FSeoul', undefined, 200],
  ['get', '/api/v1/users/me/today?timezone=Asia%2FSeoul', undefined, 200],
  ['get', '/api/v1/articles/fixture-article', undefined, 200],
  ['get', '/api/v1/editorial/articles', undefined, 200],
  ['post', '/api/v1/editorial/articles', { slug: 'new-article', locale: 'ko', headline: 'H', excerpt: 'E' }, 201],
  ['patch', '/api/v1/editorial/articles/new-article', { status: 'FACT_CHECK' }, 200],
  ['post', '/api/v1/editorial/articles/new-article/publish', undefined, 200],
  ['post', '/api/v1/editorial/articles/new-article/retract', { reasonCode: 'factual_error' }, 200],
  ['get', '/api/v1/product-config', undefined, 200],
  ['post', '/api/v1/product-events', {
    events: [{ eventId: 'evt-http-0001', eventCode: 'game_dna_view', occurredAt: '2026-07-30T12:00:00.000Z' }]
  }, 202]
];

function allFeaturesEnabledStub() {
  return stubPrisma({
    productFeatureFlag: { findMany: async () => [] },
    userRoleAssignment: { findMany: async () => [{ role: 'EDITOR' }] }
  });
}

test('every Product 2.2 operation is routed and returns the shared success envelope', async () => {
  authState.userId = USER_A;
  authState.authenticated = true;

  const restore = allFeaturesEnabledStub();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const [method, path, body, expectedStatus] of OPERATIONS) {
      const { status, payload } = await request(baseUrl, method, path, body);

      assert.equal(status, expectedStatus, `${method.toUpperCase()} ${path} expected ${expectedStatus}, got ${status}`);
      assert.equal(payload.success, true, `${method.toUpperCase()} ${path} must use the shared success envelope`);
      assert.equal(typeof payload.data, 'object');
      assert.notEqual(payload.data, null);
    }
  } finally {
    server.close();
    restore();
  }
});

test('every Product 2.2 operation rejects an unauthenticated request with the shared error envelope', async () => {
  authState.authenticated = false;

  const restore = allFeaturesEnabledStub();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const [method, path, body] of OPERATIONS) {
      const { status, payload } = await request(baseUrl, method, path, body);

      assert.equal(status, 401, `${method.toUpperCase()} ${path} must require authentication`);
      assert.equal(payload.success, false);
      assert.equal(payload.error.code, 'UNAUTHORIZED');
    }
  } finally {
    authState.authenticated = true;
    server.close();
    restore();
  }
});

test('a disabled kill switch returns 503 FEATURE_DISABLED and never a 500', async () => {
  authState.authenticated = true;
  authState.userId = USER_A;

  const gatedOperations = [
    ['openCatalog', 'get', '/api/v1/catalog/games/search?query=portal'],
    ['aiQuickAdd', 'get', `/api/v1/catalog/submissions/${SUBMISSION_ID}`],
    ['playlog', 'get', '/api/v1/users/me/play-sessions'],
    ['gameDNA', 'get', '/api/v1/users/me/game-dna'],
    ['monthlyReplay', 'get', '/api/v1/users/me/replays/monthly?month=2026-07&timezone=UTC'],
    ['todayFeed', 'get', '/api/v1/users/me/today?timezone=UTC'],
    ['magazine', 'get', '/api/v1/articles/fixture-article']
  ];

  for (const [flagKey, method, path] of gatedOperations) {
    const restore = stubPrisma({
      productFeatureFlag: { findMany: async () => [{ key: flagKey, enabled: false }] },
      userRoleAssignment: { findMany: async () => [{ role: 'EDITOR' }] }
    });
    const server = await listen();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const { status, payload } = await request(baseUrl, method, path);

      assert.equal(status, 503, `${path} must fail closed with 503 when ${flagKey} is off`);
      assert.equal(payload.success, false);
      assert.equal(payload.error.code, 'FEATURE_DISABLED');
    } finally {
      server.close();
      restore();
    }
  }
});

test('disabling one feature leaves the others reachable', async () => {
  authState.authenticated = true;
  const restore = stubPrisma({
    productFeatureFlag: { findMany: async () => [{ key: 'aiQuickAdd', enabled: false }] },
    userRoleAssignment: { findMany: async () => [{ role: 'EDITOR' }] }
  });
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const disabled = await request(baseUrl, 'get', `/api/v1/catalog/submissions/${SUBMISSION_ID}`);
    assert.equal(disabled.status, 503);

    for (const path of [
      '/api/v1/catalog/games/search?query=portal',
      '/api/v1/users/me/play-sessions',
      '/api/v1/users/me/game-dna',
      '/api/v1/users/me/today?timezone=UTC'
    ]) {
      const { status } = await request(baseUrl, 'get', path);
      assert.equal(status, 200, `${path} must stay reachable while aiQuickAdd is off`);
    }
  } finally {
    server.close();
    restore();
  }
});

test('a second account cannot read or mutate another account private records', async () => {
  const restore = allFeaturesEnabledStub();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    authState.userId = USER_B;

    const submission = await request(baseUrl, 'get', `/api/v1/catalog/submissions/${SUBMISSION_ID}`);
    assert.equal(submission.status, 404);
    assert.equal(submission.payload.error.code, 'SUBMISSION_NOT_FOUND');

    const patched = await request(baseUrl, 'patch', `/api/v1/users/me/play-sessions/${OWNED_SESSION_ID}`, { outcome: 'COMPLETED' });
    assert.equal(patched.status, 404);
    assert.equal(patched.payload.error.code, 'PLAY_SESSION_NOT_FOUND');

    const deleted = await request(baseUrl, 'delete', `/api/v1/users/me/play-sessions/${OWNED_SESSION_ID}`, {});
    assert.equal(deleted.status, 404);

    const listed = await request(baseUrl, 'get', '/api/v1/users/me/play-sessions');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload.data.playSessions, [], 'the list is scoped to the caller');
  } finally {
    authState.userId = USER_A;
    server.close();
    restore();
  }
});

test('editor-only routes require a database role', async () => {
  authState.authenticated = true;
  authState.userId = USER_A;

  const restore = stubPrisma({
    productFeatureFlag: { findMany: async () => [] },
    // No active role rows: the account is a plain user.
    userRoleAssignment: { findMany: async () => [] }
  });
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const [method, path, body] of [
      ['get', '/api/v1/editorial/articles', undefined],
      ['post', '/api/v1/editorial/articles', { slug: 'x-article', locale: 'ko', headline: 'H', excerpt: 'E' }],
      ['patch', '/api/v1/editorial/articles/x-article', { status: 'FACT_CHECK' }],
      ['post', '/api/v1/editorial/articles/x-article/publish', undefined],
      ['post', '/api/v1/editorial/articles/x-article/retract', { reasonCode: 'factual_error' }]
    ]) {
      const { status, payload } = await request(baseUrl, method, path, body);

      assert.equal(status, 403, `${method.toUpperCase()} ${path} must require an editor role`);
      assert.equal(payload.error.code, 'FORBIDDEN_ROLE');
    }

    // A reader endpoint is unaffected by the missing role.
    const article = await request(baseUrl, 'get', '/api/v1/articles/fixture-article');
    assert.equal(article.status, 200);
  } finally {
    server.close();
    restore();
  }
});

test('validation failures return 400 with the shared error envelope', async () => {
  authState.authenticated = true;
  authState.userId = USER_A;

  const restore = allFeaturesEnabledStub();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const cases = [
      ['get', '/api/v1/catalog/games/search', undefined, 'VALIDATION_ERROR'],
      ['get', '/api/v1/catalog/games/not-a-uuid', undefined, 'INVALID_IDENTIFIER'],
      ['post', '/api/v1/catalog/submissions/preview', { inputType: 'MAGIC', input: 'x', locale: 'ko', regionCode: 'KR' }, 'INVALID_SUBMISSION_INPUT_TYPE'],
      ['post', '/api/v1/users/me/play-sessions', {
        catalogGameId: CATALOG_GAME_A,
        playedAt: '2026-07-15T10:00:00.000Z',
        outcome: 'CONTINUE',
        clientMutationId: 'short'
      }, 'INVALID_CLIENT_MUTATION_ID'],
      ['post', '/api/v1/users/me/play-sessions', {
        catalogGameId: CATALOG_GAME_A,
        playedAt: '2026-07-15T10:00:00.000Z',
        outcome: 'NOT_AN_OUTCOME',
        clientMutationId: CLIENT_MUTATION_ID
      }, 'INVALID_PLAY_OUTCOME'],
      ['get', '/api/v1/users/me/replays/monthly?month=2026-13&timezone=UTC', undefined, 'INVALID_MONTH'],
      ['get', '/api/v1/users/me/replays/monthly?month=2026-07&timezone=Nope%2FNope', undefined, 'INVALID_TIMEZONE'],
      ['post', '/api/v1/users/me/play-compass', { availableMinutes: 1 }, 'INVALID_AVAILABLE_MINUTES'],
      ['post', '/api/v1/product-events', { events: [{ eventId: 'evt-1234567', eventCode: 'not_allowlisted', occurredAt: '2026-07-30T12:00:00.000Z' }] }, 'UNKNOWN_PRODUCT_EVENT_CODE']
    ];

    for (const [method, path, body, expectedCode] of cases) {
      const { status, payload } = await request(baseUrl, method, path, body);

      assert.equal(status, 400, `${method.toUpperCase()} ${path} must be a 400`);
      assert.equal(payload.success, false);
      assert.equal(payload.error.code, expectedCode, `${path} expected ${expectedCode}, got ${payload.error.code}`);
    }
  } finally {
    server.close();
    restore();
  }
});

test('an invalid timezone is rejected before any query runs', async () => {
  authState.authenticated = true;
  const restore = allFeaturesEnabledStub();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { status, payload } = await request(baseUrl, 'get', '/api/v1/users/me/play-sessions/calendar?month=2026-07&timezone=Fake%2FZone');

    assert.equal(status, 400);
    assert.equal(payload.error.code, 'INVALID_TIMEZONE');
  } finally {
    server.close();
    restore();
  }
});

test('the product config response is a versioned DTO with every kill switch', async () => {
  authState.authenticated = true;
  const restore = allFeaturesEnabledStub();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { status, payload } = await request(baseUrl, 'get', '/api/v1/product-config');

    assert.equal(status, 200);
    assert.equal(payload.data.dtoVersion, 1);
    assert.deepEqual(Object.keys(payload.data.features).sort(), [
      'aiQuickAdd', 'gameDNA', 'magazine', 'monthlyReplay', 'openCatalog', 'playCompass', 'playlog', 'todayFeed'
    ]);
  } finally {
    server.close();
    restore();
  }
});

test('legacy client routes are still registered and Product 2.2 shadows none of them', async () => {
  // The 401 here is the point: the route exists and reaches the auth middleware
  // rather than falling through to the 404 handler.
  authState.authenticated = false;

  const restore = allFeaturesEnabledStub();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const legacyRoutes = [
      ['get', '/users/me'],
      ['get', '/users/me/privacy'],
      ['get', '/users/me/privacy-settings'],
      ['get', '/users/me/recently-played'],
      ['get', '/users/me/recent-plays'],
      ['get', '/users/me/steam'],
      ['get', '/users/me/library'],
      ['get', '/users/me/library/owned'],
      ['get', '/users/me/library/playing'],
      ['get', '/users/me/library/liked'],
      ['get', '/users/me/library/reviews'],
      ['get', '/users/me/recommendations/friends'],
      ['get', '/users/me/recommendations/playtime-based'],
      ['get', '/users/me/favorites'],
      ['post', '/users/me/library/status'],
      ['post', '/users/me/library/steam/sync-owned'],
      ['put', '/users/me/push-token'],
      ['post', '/reports']
    ];

    for (const [method, path] of legacyRoutes) {
      const { status, payload } = await request(baseUrl, method, path, method === 'get' ? undefined : {});

      assert.notEqual(status, 404, `${method.toUpperCase()} ${path} must still be registered`);
      assert.equal(status, 401, `${method.toUpperCase()} ${path} must still reach the auth boundary`);
      assert.equal(payload.success, false);
    }

    // /health stays public and unversioned.
    authState.authenticated = true;
    const health = await request(baseUrl, 'get', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.payload.data.status, 'ok');
  } finally {
    authState.authenticated = true;
    server.close();
    restore();
  }
});

test('an unknown /api/v1 path still 404s through the shared handler', async () => {
  authState.authenticated = true;
  const restore = allFeaturesEnabledStub();
  const server = await listen();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { status, payload } = await request(baseUrl, 'get', '/api/v1/not-a-real-endpoint');

    assert.equal(status, 404);
    assert.equal(payload.success, false);
  } finally {
    server.close();
    restore();
  }
});

test('every routed operation is declared in the OpenAPI document and vice versa', () => {
  const declared = new Set();

  for (const [path, item] of Object.entries(contract.paths)) {
    for (const method of Object.keys(item)) {
      declared.add(`${method.toUpperCase()} ${path}`);
    }
  }

  const exercised = new Set(OPERATIONS.map(([method, path]) => {
    const withoutQuery = path.split('?')[0];
    const templated = withoutQuery
      .replace(CATALOG_GAME_A, '{catalogGameId}')
      .replace(SUBMISSION_ID, '{submissionId}')
      .replace(OWNED_SESSION_ID, '{id}')
      .replace('/api/v1/articles/fixture-article', '/api/v1/articles/{slug}')
      .replace(/\/api\/v1\/editorial\/articles\/[a-z0-9-]+(?=\/|$)/, '/api/v1/editorial/articles/{slug}');

    return `${method.toUpperCase()} ${templated}`;
  }));

  const undeclared = [...exercised].filter((operation) => !declared.has(operation));
  const untested = [...declared].filter((operation) => !exercised.has(operation));

  assert.deepEqual(undeclared, [], `routed but undeclared: ${undeclared.join(', ')}`);
  assert.deepEqual(untested, [], `declared but not exercised over HTTP: ${untested.join(', ')}`);
});
