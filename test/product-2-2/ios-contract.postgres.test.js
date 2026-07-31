const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

// The iOS generated client is built from openapi/product-2.2.openapi.json, so a
// schema that merely looks plausible is not enough: it has to match the bytes the
// server actually puts on the wire. These tests issue real HTTP requests against a
// real PostgreSQL and compare every returned field against the declared schema.
//
// Four operations answered with the generic SuccessEnvelope and an untyped
// data/meta, which left the generated Swift client unable to reach the confirmed
// catalogGameId, the submission's status and resolution, or either cursor. Each is
// now bound to a dedicated typed envelope, and each is checked here.
//
// The auth middleware is replaced before src/app is required, because every router
// destructures it at module load.

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';

const authMiddleware = require('../../src/middlewares/auth.middleware');

const authState = { userId: null };

authMiddleware.authenticateAccessToken = (req, res, next) => {
  req.auth = { userId: authState.userId, email: 'ios-contract@example.invalid', status: 'ACTIVE' };
  next();
};

const contract = require('../../openapi/product-2.2.openapi.json');

function uniqueSuffix() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function resolveRef(pointer) {
  return pointer
    .replace(/^#\//, '')
    .split('/')
    .reduce((node, segment) => node?.[segment], contract);
}

/// Follows a `$ref` until a concrete schema is reached.
function deref(schema) {
  let current = schema;

  while (current && typeof current.$ref === 'string') {
    current = resolveRef(current.$ref);
  }

  return current;
}

/// The schema an operation's response body resolves to, following the envelope.
function responseSchema(routePath, method, status) {
  const operation = contract.paths[routePath][method];
  const envelope = deref(operation.responses[status].content['application/json'].schema);

  return deref(envelope.properties.data);
}

/// Asserts that a real payload and its declared schema describe the same object.
///
/// Every key on the wire must be declared, every declared `required` key must be
/// present, and — when the schema declares no optional properties — the two key
/// sets must be identical. This is what catches both a contract that promises a
/// field the server never sends and a server field the client cannot reach.
function assertObjectMatchesSchema(payload, schema, label) {
  const declared = Object.keys(schema.properties ?? {});
  const required = schema.required ?? [];
  const present = Object.keys(payload);

  const undeclared = present.filter((key) => !declared.includes(key));
  assert.deepEqual(undeclared, [], `${label}: wire fields missing from the schema: ${undeclared.join(', ')}`);

  const missing = required.filter((key) => !present.includes(key));
  assert.deepEqual(missing, [], `${label}: schema requires fields the server did not send: ${missing.join(', ')}`);

  if (declared.length === required.length) {
    assert.deepEqual([...present].sort(), [...required].sort(),
      `${label}: every property is required, so the key sets must match exactly`);
  }
}

async function request(baseUrl, method, routePath, body) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: method.toUpperCase(),
    headers: {
      authorization: 'Bearer ios-contract',
      connection: 'close',
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  return { status: response.status, payload: await response.json() };
}

async function listen() {
  const { app } = require('../../src/app');

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function draftFor(title, { rich }) {
  const game = {
    originalTitle: title,
    requiresTitleConfirmation: false,
    genres: [],
    platforms: [],
    localizations: [],
    regionalReleases: [],
    identities: [],
    fieldProvenance: []
  };

  if (!rich) {
    return { version: 2, game, aiUsed: false, aiFallbackUsed: false, degradedToManual: true };
  }

  return {
    version: 2,
    game: {
      ...game,
      developerName: 'Contract Studio',
      publisherName: 'Contract Publishing',
      firstReleaseDate: '2024-05-01',
      genres: ['Action'],
      platforms: ['STEAM'],
      supportsSinglePlayer: true,
      supportsMultiplayer: false,
      typicalSessionMinutes: 45,
      localizations: [{ kind: 'ORIGINAL_TITLE', languageCode: 'en', regionCode: null, title }],
      regionalReleases: [{
        countryCode: 'KR',
        languageCode: 'ko',
        platform: 'STEAM',
        operatorName: null,
        serverRegion: null,
        releaseDate: '2024-05-01',
        shutdownDate: null,
        serviceStatus: 'LIVE'
      }],
      fieldProvenance: [{ fieldPath: 'originalTitle', provenance: 'AI_INFERRED', confidence: 0.8 }]
    },
    parsedIdentityClaim: { provider: 'STEAM', externalId: `ios-${uniqueSuffix()}`, regionKey: 'GLOBAL' },
    aiUsed: true,
    aiFallbackUsed: false,
    degradedToManual: false
  };
}

async function createSubmission(prisma, userId, draft) {
  const { fingerprintInput } = require('../../src/modules/catalog/catalog-title.util');

  return prisma.gameSubmission.create({
    data: {
      userId,
      status: 'PREVIEW',
      inputType: 'TEXT',
      inputFingerprint: fingerprintInput(`ios-${uniqueSuffix()}`),
      locale: 'ko',
      regionCode: 'KR',
      draft,
      expiresAt: new Date(Date.now() + 3600_000)
    },
    select: { id: true }
  });
}

test('confirmCatalogSubmission answers a typed result on every path, matching the schema exactly',
  { skip: !enabled }, async () => {
    const { prisma } = require('../../src/config/prisma');
    const server = await listen();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const user = await prisma.user.create({
      data: {
        email: `ios-confirm-${uniqueSuffix()}@example.invalid`,
        nickname: `ios-confirm-${uniqueSuffix()}`.slice(0, 50),
        passwordHash: 'integration-test-not-a-real-password-hash'
      }
    });
    authState.userId = user.id;

    const route = '/api/v1/catalog/submissions/{submissionId}/confirm';

    try {
      const created = await createSubmission(prisma, user.id, draftFor(`Confirm Create ${uniqueSuffix()}`, { rich: true }));
      const createResponse = await request(baseUrl, 'post',
        `/api/v1/catalog/submissions/${created.id}/confirm`, { requestPublicReview: false });

      assert.equal(createResponse.status, 201);
      assertObjectMatchesSchema(createResponse.payload.data, responseSchema(route, 'post', '201'), 'confirm 201');
      // The blocker: the catalog game id has to be a typed, non-opaque value.
      assert.match(createResponse.payload.data.catalogGameId, /^[0-9a-f-]{36}$/);
      assert.equal(createResponse.payload.data.createdNewGame, true);
      assert.equal(createResponse.payload.data.idempotentReplay, false);

      // Replaying the same confirmation is a 200 with the same typed shape.
      const replayResponse = await request(baseUrl, 'post',
        `/api/v1/catalog/submissions/${created.id}/confirm`, { requestPublicReview: false });

      assert.equal(replayResponse.status, 200);
      assertObjectMatchesSchema(replayResponse.payload.data, responseSchema(route, 'post', '200'), 'confirm 200 replay');
      assert.equal(replayResponse.payload.data.idempotentReplay, true);
      assert.equal(replayResponse.payload.data.catalogGameId, createResponse.payload.data.catalogGameId);

      // Linking an existing candidate is also a 200 with the same shape.
      const linkTarget = await prisma.catalogGame.create({
        data: {
          originalTitle: `Link Target ${uniqueSuffix()}`,
          normalizedTitle: 'link target',
          genres: [],
          steamTags: [],
          platforms: [],
          publicationStatus: 'PRIVATE',
          titleProvenance: 'USER_CONFIRMED',
          createdByUserId: user.id
        },
        select: { id: true }
      });
      const linkSubmission = await createSubmission(prisma, user.id, draftFor(`Confirm Link ${uniqueSuffix()}`, { rich: false }));
      const linkResponse = await request(baseUrl, 'post',
        `/api/v1/catalog/submissions/${linkSubmission.id}/confirm`,
        { selectedCatalogGameId: linkTarget.id, requestPublicReview: false });

      assert.equal(linkResponse.status, 200);
      assertObjectMatchesSchema(linkResponse.payload.data, responseSchema(route, 'post', '200'), 'confirm 200 link');
      assert.equal(linkResponse.payload.data.catalogGameId, linkTarget.id);
      assert.equal(linkResponse.payload.data.createdNewGame, false);

      // A verified identity elsewhere is reported as a typed conflict.
      const externalId = `ios-conflict-${uniqueSuffix()}`;
      const verifiedGame = await prisma.catalogGame.create({
        data: {
          originalTitle: `Verified Owner ${uniqueSuffix()}`,
          normalizedTitle: 'verified owner',
          genres: [],
          steamTags: [],
          platforms: ['STEAM'],
          publicationStatus: 'PUBLISHED',
          titleProvenance: 'PROVIDER_VERIFIED'
        },
        select: { id: true }
      });
      await prisma.gameExternalIdentity.create({
        data: {
          catalogGameId: verifiedGame.id,
          provider: 'STEAM',
          externalId,
          regionKey: 'GLOBAL',
          provenance: 'PROVIDER_VERIFIED',
          verifiedAt: new Date(),
          verificationSource: 'steam_owned_games_sync'
        }
      });

      const conflictDraft = draftFor(`Confirm Conflict ${uniqueSuffix()}`, { rich: true });
      conflictDraft.parsedIdentityClaim = { provider: 'STEAM', externalId, regionKey: 'GLOBAL' };
      const conflictSubmission = await createSubmission(prisma, user.id, conflictDraft);
      const conflictResponse = await request(baseUrl, 'post',
        `/api/v1/catalog/submissions/${conflictSubmission.id}/confirm`, { requestPublicReview: false });

      assertObjectMatchesSchema(conflictResponse.payload.data, responseSchema(route, 'post', '201'), 'confirm identity conflict');

      const conflictSchema = deref(responseSchema(route, 'post', '201').properties.identityConflict);
      assertObjectMatchesSchema(conflictResponse.payload.data.identityConflict, conflictSchema, 'identityConflict');
      assert.equal(conflictResponse.payload.data.identityConflict.existingCatalogGameId, verifiedGame.id);
      assert.equal(conflictResponse.payload.data.identityConflict.reasonCode, 'verified_identity_already_exists');
    } finally {
      server.close();
    }
  });

test('getCatalogSubmission answers a typed status, resolution and resulting game',
  { skip: !enabled }, async () => {
    const { prisma } = require('../../src/config/prisma');
    const server = await listen();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const user = await prisma.user.create({
      data: {
        email: `ios-get-${uniqueSuffix()}@example.invalid`,
        nickname: `ios-get-${uniqueSuffix()}`.slice(0, 50),
        passwordHash: 'integration-test-not-a-real-password-hash'
      }
    });
    authState.userId = user.id;

    const route = '/api/v1/catalog/submissions/{submissionId}';
    const schema = responseSchema(route, 'get', '200');

    try {
      // 1. A confirmed submission with a fully populated draft.
      const rich = await createSubmission(prisma, user.id, draftFor(`Get Rich ${uniqueSuffix()}`, { rich: true }));
      await request(baseUrl, 'post', `/api/v1/catalog/submissions/${rich.id}/confirm`, { requestPublicReview: false });

      const confirmed = await request(baseUrl, 'get', `/api/v1/catalog/submissions/${rich.id}`);

      assert.equal(confirmed.status, 200);
      assertObjectMatchesSchema(confirmed.payload.data, schema, 'submission state (confirmed)');
      assert.equal(confirmed.payload.data.status, 'PERSONAL_CONFIRMED');
      assert.equal(confirmed.payload.data.draftReadable, true);
      assert.match(confirmed.payload.data.catalogGameId, /^[0-9a-f-]{36}$/);

      const draftSchema = deref(schema.properties.newGameDraft);
      assertObjectMatchesSchema(confirmed.payload.data.newGameDraft, draftSchema, 'newGameDraft (rich)');

      const localizationSchema = deref(draftSchema.properties.localizations.items);
      assertObjectMatchesSchema(confirmed.payload.data.newGameDraft.localizations[0], localizationSchema, 'draft localization');

      const releaseSchema = deref(draftSchema.properties.regionalReleases.items);
      assertObjectMatchesSchema(confirmed.payload.data.newGameDraft.regionalReleases[0], releaseSchema, 'draft regional release');

      const provenanceSchema = deref(draftSchema.properties.fieldProvenance.items);
      assertObjectMatchesSchema(confirmed.payload.data.newGameDraft.fieldProvenance[0], provenanceSchema, 'draft field provenance');

      // 2. A minimal draft: the optional fields are absent, not null, so the schema
      //    must leave them out of `required`.
      const minimal = await createSubmission(prisma, user.id, draftFor(`Get Minimal ${uniqueSuffix()}`, { rich: false }));
      const preview = await request(baseUrl, 'get', `/api/v1/catalog/submissions/${minimal.id}`);

      assertObjectMatchesSchema(preview.payload.data, schema, 'submission state (preview)');
      assertObjectMatchesSchema(preview.payload.data.newGameDraft, draftSchema, 'newGameDraft (minimal)');
      assert.equal('developerName' in preview.payload.data.newGameDraft, false,
        'an absent optional draft field must be omitted, which is why it is not required');
      assert.equal(preview.payload.data.catalogGameId, null);
      assert.equal(preview.payload.data.status, 'PREVIEW');

      // 3. A draft that no longer validates: newGameDraft is null and the client is
      //    told so by draftReadable rather than having to guess.
      const { fingerprintInput } = require('../../src/modules/catalog/catalog-title.util');
      const unreadable = await prisma.gameSubmission.create({
        data: {
          userId: user.id,
          status: 'PREVIEW',
          inputType: 'URL',
          inputFingerprint: fingerprintInput(`ios-bad-${uniqueSuffix()}`),
          locale: 'ko',
          regionCode: 'KR',
          platformHint: 'STEAM',
          draft: { version: 1, legacy: true },
          candidateSummary: { version: 1, candidateCount: 2, catalogGameIds: [], reasonCodes: ['normalized_title_exact'] },
          clarifyingQuestion: 'Which platform did you play it on?',
          aiFallbackUsed: true,
          expiresAt: new Date(Date.now() - 1000)
        },
        select: { id: true }
      });

      const degraded = await request(baseUrl, 'get', `/api/v1/catalog/submissions/${unreadable.id}`);

      assertObjectMatchesSchema(degraded.payload.data, schema, 'submission state (unreadable draft)');
      assert.equal(degraded.payload.data.newGameDraft, null);
      assert.equal(degraded.payload.data.draftReadable, false);
      assert.equal(degraded.payload.data.expired, true);
      assert.equal(degraded.payload.data.clarifyingQuestions.length, 1);

      const candidateSchema = deref(schema.properties.candidateSummary);
      assertObjectMatchesSchema(degraded.payload.data.candidateSummary, candidateSchema, 'candidateSummary');
    } finally {
      server.close();
    }
  });

test('catalog search returns a typed cursor and every matchedBy the runtime can produce',
  { skip: !enabled }, async () => {
    const { prisma } = require('../../src/config/prisma');
    const { normalizeTitle } = require('../../src/modules/catalog/catalog-title.util');
    const server = await listen();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const user = await prisma.user.create({
      data: {
        email: `ios-search-${uniqueSuffix()}@example.invalid`,
        nickname: `ios-search-${uniqueSuffix()}`.slice(0, 50),
        passwordHash: 'integration-test-not-a-real-password-hash'
      }
    });
    authState.userId = user.id;

    const schema = responseSchema('/api/v1/catalog/games/search', 'get', '200');
    const metaSchema = deref(schema.properties.meta);
    const title = `Ios Contract Search ${uniqueSuffix()}`;

    try {
      for (let index = 0; index < 3; index += 1) {
        const gameTitle = `${title} ${index}`;

        await prisma.catalogGame.create({
          data: {
            originalTitle: gameTitle,
            normalizedTitle: normalizeTitle(gameTitle),
            genres: [],
            steamTags: [],
            platforms: [],
            publicationStatus: 'PUBLISHED',
            titleProvenance: 'EDITOR_VERIFIED'
          }
        });
      }

      const firstPage = await request(baseUrl, 'get',
        `/api/v1/catalog/games/search?query=${encodeURIComponent(title)}&limit=2`);

      assert.equal(firstPage.status, 200);
      assertObjectMatchesSchema(firstPage.payload.data, schema, 'search page');
      assertObjectMatchesSchema(firstPage.payload.data.meta, metaSchema, 'search meta');

      // The cursor must be a real, usable value, not a documented fiction.
      const cursor = firstPage.payload.data.meta.nextCursor;
      assert.equal(typeof cursor, 'string');
      assert.ok(cursor.length > 0);

      const secondPage = await request(baseUrl, 'get',
        `/api/v1/catalog/games/search?query=${encodeURIComponent(title)}&limit=2&cursor=${encodeURIComponent(cursor)}`);

      assertObjectMatchesSchema(secondPage.payload.data.meta, metaSchema, 'search meta (last page)');
      assert.equal(secondPage.payload.data.meta.nextCursor, null, 'the last page must close the cursor');

      const firstIds = firstPage.payload.data.games.map((game) => game.catalogGameId);
      const secondIds = secondPage.payload.data.games.map((game) => game.catalogGameId);

      assert.equal(firstIds.some((id) => secondIds.includes(id)), false, 'a cursor page must not repeat a row');

      // Every declared matchedBy value must be one the server can actually return.
      const observed = new Set([firstPage.payload.data.meta.matchedBy]);

      const exactTitle = `Ios Exact ${uniqueSuffix()}`;
      await prisma.catalogGame.create({
        data: {
          originalTitle: exactTitle,
          normalizedTitle: normalizeTitle(exactTitle),
          genres: [],
          steamTags: [],
          platforms: [],
          publicationStatus: 'PUBLISHED',
          titleProvenance: 'EDITOR_VERIFIED'
        }
      });

      const exact = await request(baseUrl, 'get', `/api/v1/catalog/games/search?query=${encodeURIComponent(exactTitle)}`);
      observed.add(exact.payload.data.meta.matchedBy);

      const noMatch = await request(baseUrl, 'get',
        `/api/v1/catalog/games/search?query=${encodeURIComponent(`nothing here ${uniqueSuffix()}`)}`);
      observed.add(noMatch.payload.data.meta.matchedBy);

      // A punctuation-only query passes validation but normalizes to nothing.
      const punctuation = await request(baseUrl, 'get', '/api/v1/catalog/games/search?query=%21%21%21');
      observed.add(punctuation.payload.data.meta.matchedBy);

      assert.deepEqual([...observed].sort(), [...metaSchema.properties.matchedBy.enum].sort(),
        'the declared matchedBy enum must be exactly the set the server produces');
    } finally {
      server.close();
    }
  });

test('the Playlog list returns a typed keyset cursor that pages without gaps',
  { skip: !enabled }, async () => {
    const { prisma } = require('../../src/config/prisma');
    const server = await listen();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const user = await prisma.user.create({
      data: {
        email: `ios-play-${uniqueSuffix()}@example.invalid`,
        nickname: `ios-play-${uniqueSuffix()}`.slice(0, 50),
        passwordHash: 'integration-test-not-a-real-password-hash'
      }
    });
    authState.userId = user.id;

    const schema = responseSchema('/api/v1/users/me/play-sessions', 'get', '200');
    const metaSchema = deref(schema.properties.meta);

    try {
      const game = await prisma.catalogGame.create({
        data: {
          originalTitle: `Ios Play Target ${uniqueSuffix()}`,
          normalizedTitle: 'ios play target',
          genres: [],
          steamTags: [],
          platforms: [],
          publicationStatus: 'PUBLISHED',
          titleProvenance: 'EDITOR_VERIFIED'
        },
        select: { id: true }
      });

      for (let index = 0; index < 3; index += 1) {
        await request(baseUrl, 'post', '/api/v1/users/me/play-sessions', {
          catalogGameId: game.id,
          playedAt: new Date(Date.UTC(2026, 5, 10 + index, 10, 0, 0)).toISOString(),
          durationMinutes: 30 + index,
          outcome: 'CONTINUE',
          clientMutationId: `ios-session-${index}-${uniqueSuffix()}`
        });
      }

      const empty = await request(baseUrl, 'get', '/api/v1/users/me/play-sessions?limit=50&catalogGameId=' +
        '00000000-0000-4000-8000-00000000dead');

      assertObjectMatchesSchema(empty.payload.data, schema, 'play session page (empty)');
      assertObjectMatchesSchema(empty.payload.data.meta, metaSchema, 'play session meta (empty)');
      assert.equal(empty.payload.data.meta.nextCursor, null);

      const firstPage = await request(baseUrl, 'get', '/api/v1/users/me/play-sessions?limit=2');

      assert.equal(firstPage.status, 200);
      assertObjectMatchesSchema(firstPage.payload.data, schema, 'play session page');
      assertObjectMatchesSchema(firstPage.payload.data.meta, metaSchema, 'play session meta');
      assert.equal(firstPage.payload.data.playSessions.length, 2);

      const cursor = firstPage.payload.data.meta.nextCursor;
      assert.equal(typeof cursor, 'string');

      const secondPage = await request(baseUrl, 'get',
        `/api/v1/users/me/play-sessions?limit=2&cursor=${encodeURIComponent(cursor)}`);

      assertObjectMatchesSchema(secondPage.payload.data.meta, metaSchema, 'play session meta (last page)');
      assert.equal(secondPage.payload.data.meta.nextCursor, null);

      const firstIds = firstPage.payload.data.playSessions.map((session) => session.id);
      const secondIds = secondPage.payload.data.playSessions.map((session) => session.id);

      assert.equal(firstIds.some((id) => secondIds.includes(id)), false, 'a keyset page must not repeat a row');
      assert.equal(new Set([...firstIds, ...secondIds]).size, 3, 'paging must reach every session exactly once');

      // The session items themselves must satisfy the referenced PlaySession schema.
      const sessionSchema = deref(schema.properties.playSessions.items);
      const declared = Object.keys(sessionSchema.properties);
      const undeclared = Object.keys(firstPage.payload.data.playSessions[0])
        .filter((key) => !declared.includes(key));

      assert.deepEqual(undeclared, [], `play session fields missing from PlaySession: ${undeclared.join(', ')}`);
    } finally {
      server.close();
    }
  });

test('the contract document under test is the one the iOS gate generates from',
  { skip: !enabled }, () => {
    // A guard against this file drifting onto a copy of the document.
    assert.equal(
      path.resolve(require.resolve('../../openapi/product-2.2.openapi.json')),
      path.resolve(process.cwd(), 'openapi/product-2.2.openapi.json')
    );
  });
