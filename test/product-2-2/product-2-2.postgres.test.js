const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Real-PostgreSQL verification for Product 2.2.
//
// Skipped unless RUN_POSTGRES_INTEGRATION=1 and a disposable DATABASE_URL is
// supplied, which scripts/test/run-product-2-2-postgres-gate.sh does. These
// assertions cover the properties that only a real database can prove: the
// provider-key uniqueness constraint, the additive nullable columns, dual-write
// idempotency, Playlog idempotency under a genuine unique index, and cross-account
// isolation.

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';

function uniqueSuffix() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function createUser(prisma, label) {
  const suffix = uniqueSuffix();

  return prisma.user.create({
    data: {
      email: `p22-${label}-${suffix}@example.invalid`,
      nickname: `p22-${label}-${suffix}`.slice(0, 50),
      passwordHash: 'integration-test-not-a-real-password-hash'
    }
  });
}

test('the disposable gate database is not a production or staging database', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const [{ current_database: currentDatabase }] = await prisma.$queryRawUnsafe('SELECT current_database()');

  assert.ok(typeof currentDatabase === 'string' && currentDatabase.length > 0);
  // The gate always generates a disposable name with this prefix.
  assert.match(currentDatabase, /^gamepedia_product_2_2/, `unexpected target database: ${currentDatabase}`);
  // Whole underscore-delimited segments only, so "product" is not read as "prod".
  assert.doesNotMatch(
    `_${currentDatabase}_`,
    /_(prod|production|stage|staging|live|prd|stg)_/i,
    `refusing to treat ${currentDatabase} as disposable`
  );
});

test('every Product 2.2 table exists with the expected additive columns', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const expectedTables = [
    'catalog_games', 'game_localizations', 'regional_releases', 'game_external_identities',
    'game_assets', 'game_field_evidence', 'game_submissions', 'catalog_merge_audits', 'game_follows',
    'play_sessions', 'client_mutation_receipts', 'play_compass_events',
    'editorial_articles', 'article_revisions', 'article_sources', 'article_game_links', 'article_assets',
    'product_events', 'product_feature_flags', 'user_role_assignments'
  ];

  const rows = await prisma.$queryRawUnsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const present = new Set(rows.map((row) => row.table_name));

  for (const table of expectedTables) {
    assert.ok(present.has(table), `${table} must exist`);
  }

  // The four additive columns must be nullable so legacy writes keep working.
  const columns = await prisma.$queryRawUnsafe(`
    SELECT table_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'catalog_game_id'
      AND table_name IN ('reviews', 'favorite_games', 'user_game_library', 'user_activity_events')
  `);

  assert.equal(columns.length, 4, 'all four legacy tables must carry catalog_game_id');
  assert.equal(columns.every((column) => column.is_nullable === 'YES'), true, 'catalog_game_id must be nullable');

  // The quick-add counter reuses the existing AI usage table.
  const quickAdd = await prisma.$queryRawUnsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_usage_limits' AND column_name = 'quick_add_count'
  `);

  assert.equal(quickAdd.length, 1);
});

test('the provider key uniqueness constraint is enforced by the database', { skip: !enabled }, async () => {
  const { Prisma } = require('@prisma/client');
  const { prisma } = require('../../src/config/prisma');
  const externalId = `steam-${uniqueSuffix()}`;

  const gameOne = await prisma.catalogGame.create({
    data: { originalTitle: 'Constraint Game One', normalizedTitle: 'constraint game one' },
    select: { id: true }
  });
  const gameTwo = await prisma.catalogGame.create({
    data: { originalTitle: 'Constraint Game Two', normalizedTitle: 'constraint game two' },
    select: { id: true }
  });

  // The global identity table is verified-only since the round-2 migration: every
  // row needs a verified provenance, a verifiedAt and a named verification source.
  const verifiedIdentity = {
    provenance: 'PROVIDER_VERIFIED',
    verifiedAt: new Date(),
    verificationSource: 'steam_owned_games_sync'
  };

  try {
    await prisma.gameExternalIdentity.create({
      data: { catalogGameId: gameOne.id, provider: 'STEAM', externalId, regionKey: 'GLOBAL', ...verifiedIdentity }
    });

    // The same provider key cannot point at a second canonical game.
    await assert.rejects(
      prisma.gameExternalIdentity.create({
        data: { catalogGameId: gameTwo.id, provider: 'STEAM', externalId, regionKey: 'GLOBAL', ...verifiedIdentity }
      }),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );

    // A different region key is a different listing and is allowed.
    await assert.doesNotReject(prisma.gameExternalIdentity.create({
      data: { catalogGameId: gameTwo.id, provider: 'STEAM', externalId, regionKey: 'KR', ...verifiedIdentity }
    }));
  } finally {
    await prisma.catalogGame.deleteMany({ where: { id: { in: [gameOne.id, gameTwo.id] } } });
  }
});

test('the trusted Steam link is idempotent and reuses the canonical game', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');
  const externalId = `dual-${uniqueSuffix()}`;

  const link = () => catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
    provider: 'STEAM',
    externalId,
    title: 'Dual Write Game',
    publicationStatus: 'PUBLISHED',
    titleProvenance: 'PROVIDER_VERIFIED',
    identityProvenance: 'PROVIDER_VERIFIED',
    verificationSource: 'steam_owned_games_sync',
    platforms: ['STEAM']
  });

  const first = await link();
  const second = await link();
  // Concurrent callers must converge on the same canonical game.
  const concurrent = await Promise.all(Array.from({ length: 5 }, link));

  try {
    assert.equal(second.catalogGameId, first.catalogGameId, 'a repeated link must not create a second canonical game');
    assert.equal(
      new Set([first, second, ...concurrent].map((result) => result.catalogGameId)).size,
      1,
      'all callers must converge on one canonical game'
    );

    const identities = await prisma.gameExternalIdentity.findMany({
      where: { provider: 'STEAM', externalId },
      select: { id: true, verifiedAt: true, verificationSource: true }
    });
    assert.equal(identities.length, 1, 'exactly one identity row must exist');
    assert.ok(identities[0].verifiedAt, 'a trusted link marks the identity verified');
    assert.equal(identities[0].verificationSource, 'steam_owned_games_sync');
  } finally {
    await prisma.catalogGame.deleteMany({ where: { id: first.catalogGameId } });
  }
});

test('a merge tombstone still resolves to the surviving canonical game', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');

  const survivor = await prisma.catalogGame.create({
    data: { originalTitle: 'Survivor', normalizedTitle: 'survivor' },
    select: { id: true }
  });
  const tombstone = await prisma.catalogGame.create({
    data: { originalTitle: 'Tombstone', normalizedTitle: 'tombstone', mergedIntoCatalogGameId: survivor.id },
    select: { id: true }
  });

  try {
    assert.equal(await catalogIdentityService.resolveCanonicalGameId(tombstone.id), survivor.id);
    assert.equal(await catalogIdentityService.resolveCanonicalGameId(survivor.id), survivor.id);
  } finally {
    await prisma.catalogGame.deleteMany({ where: { id: { in: [tombstone.id, survivor.id] } } });
  }
});

test('a repeated Playlog clientMutationId cannot create a duplicate row', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const playlogService = require('../../src/modules/play/playlog.service');

  const user = await createUser(prisma, 'playlog');
  const game = await prisma.catalogGame.create({
    data: {
      originalTitle: 'Playlog Game',
      normalizedTitle: 'playlog game',
      publicationStatus: 'PUBLISHED',
      // A PUBLISHED game requires verified title provenance (round-2 CHECK constraint).
      titleProvenance: 'EDITOR_VERIFIED'
    },
    select: { id: true }
  });
  const clientMutationId = `gate-${uniqueSuffix()}`;
  const input = {
    catalogGameId: game.id,
    playedAt: new Date('2026-07-15T10:00:00.000Z'),
    durationMinutes: 60,
    outcome: 'CONTINUE',
    visibility: 'PRIVATE',
    clientMutationId
  };

  try {
    const first = await playlogService.createPlaySession({ userId: user.id, input });
    const second = await playlogService.createPlaySession({ userId: user.id, input });
    // Five concurrent retries of the same key must still yield one row.
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => playlogService
      .createPlaySession({ userId: user.id, input })
      .catch((error) => ({ error }))));

    assert.equal(first.idempotentReplay, false);
    assert.equal(second.idempotentReplay, true);
    assert.equal(second.session.id, first.session.id);
    assert.equal(concurrent.every((result) => !result.error), true, 'a concurrent retry must not surface an error');

    const count = await prisma.playSession.count({ where: { userId: user.id, clientMutationId } });
    assert.equal(count, 1, 'exactly one session row may exist for one clientMutationId');
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.catalogGame.deleteMany({ where: { id: game.id } });
  }
});

test('the same clientMutationId from two accounts creates two independent sessions', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const playlogService = require('../../src/modules/play/playlog.service');

  const userA = await createUser(prisma, 'iso-a');
  const userB = await createUser(prisma, 'iso-b');
  const game = await prisma.catalogGame.create({
    data: {
      originalTitle: 'Isolation Game',
      normalizedTitle: 'isolation game',
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'EDITOR_VERIFIED'
    },
    select: { id: true }
  });
  const clientMutationId = `shared-${uniqueSuffix()}`;
  const input = {
    catalogGameId: game.id,
    playedAt: new Date('2026-07-15T10:00:00.000Z'),
    outcome: 'CONTINUE',
    clientMutationId
  };

  try {
    const sessionA = await playlogService.createPlaySession({ userId: userA.id, input });
    const sessionB = await playlogService.createPlaySession({ userId: userB.id, input });

    // The unique index is scoped per account, so one account's key never blocks
    // another's.
    assert.notEqual(sessionA.session.id, sessionB.session.id);
    assert.equal(sessionA.idempotentReplay, false);
    assert.equal(sessionB.idempotentReplay, false);

    // Account B cannot see, update or delete account A's session.
    const listedForB = await playlogService.listPlaySessions({ userId: userB.id });
    assert.deepEqual(listedForB.sessions.map((session) => session.id), [sessionB.session.id]);

    await assert.rejects(
      playlogService.updatePlaySession({ userId: userB.id, sessionId: sessionA.session.id, patch: { outcome: 'COMPLETED' } }),
      (error) => error.code === 'PLAY_SESSION_NOT_FOUND'
    );
    await assert.rejects(
      playlogService.deletePlaySession({ userId: userB.id, sessionId: sessionA.session.id }),
      (error) => error.code === 'PLAY_SESSION_NOT_FOUND'
    );

    const stillThere = await prisma.playSession.count({ where: { id: sessionA.session.id } });
    assert.equal(stillThere, 1, "account A's session must survive account B's delete attempt");
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await prisma.catalogGame.deleteMany({ where: { id: game.id } });
  }
});

test('a product event batch is idempotent under a real unique index', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const productEventService = require('../../src/modules/product/product-event.service');

  const user = await createUser(prisma, 'events');
  const eventId = `evt-${uniqueSuffix()}`;
  const events = [{
    eventId,
    eventCode: 'game_dna_view',
    occurredAt: new Date('2026-07-30T12:00:00.000Z'),
    properties: { confidence: 'HIGH', signalCount: 12, rawQuery: 'must be dropped' }
  }];

  try {
    const first = await productEventService.recordProductEvents({ userId: user.id, events });
    const second = await productEventService.recordProductEvents({ userId: user.id, events });

    assert.equal(first.acceptedCount, 1);
    assert.equal(second.duplicateCount, 1);

    const stored = await prisma.productEvent.findMany({ where: { eventId }, select: { properties: true } });
    assert.equal(stored.length, 1, 'a replayed eventId must not double count');
    assert.deepEqual(stored[0].properties, { confidence: 'HIGH', signalCount: 12 });
    assert.equal(JSON.stringify(stored[0].properties).includes('must be dropped'), false);
  } finally {
    await prisma.productEvent.deleteMany({ where: { eventId } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('a feature flag override is read from the database, not a process cache', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const featureFlagService = require('../../src/modules/product/feature-flag.service');

  try {
    assert.deepEqual(await featureFlagService.isFeatureEnabled('playlog'), { enabled: true, degraded: false });

    await prisma.productFeatureFlag.upsert({
      where: { key: 'playlog' },
      create: { key: 'playlog', enabled: false },
      update: { enabled: false }
    });

    // No process restart and no cache invalidation: the next read must observe it.
    assert.deepEqual(await featureFlagService.isFeatureEnabled('playlog'), { enabled: false, degraded: false });
    assert.deepEqual(
      await featureFlagService.isFeatureEnabled('openCatalog'),
      { enabled: true, degraded: false },
      'other switches stay independent'
    );

    await prisma.productFeatureFlag.update({ where: { key: 'playlog' }, data: { enabled: true } });
    assert.deepEqual(await featureFlagService.isFeatureEnabled('playlog'), { enabled: true, degraded: false });
  } finally {
    await prisma.productFeatureFlag.deleteMany({ where: { key: 'playlog' } });
  }
});

test('an unrevoked role grants capability and a revoked one immediately removes it', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const userRoleService = require('../../src/modules/product/user-role.service');

  const user = await createUser(prisma, 'role');

  try {
    assert.equal(await userRoleService.hasAnyRole(user.id, ['EDITOR', 'ADMIN']), false);

    await prisma.userRoleAssignment.create({ data: { userId: user.id, role: 'EDITOR' } });
    assert.equal(await userRoleService.hasAnyRole(user.id, ['EDITOR', 'ADMIN']), true);

    await prisma.userRoleAssignment.updateMany({
      where: { userId: user.id, role: 'EDITOR' },
      data: { revokedAt: new Date() }
    });
    // Revocation takes effect on the next request, not on token expiry.
    assert.equal(await userRoleService.hasAnyRole(user.id, ['EDITOR', 'ADMIN']), false);
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('deleting an account removes its private records but keeps catalog facts', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');

  const user = await createUser(prisma, 'deletion');
  const game = await prisma.catalogGame.create({
    data: {
      originalTitle: 'Deletion Policy Game',
      normalizedTitle: 'deletion policy game',
      publicationStatus: 'PUBLISHED',
      // A PUBLISHED game requires verified title provenance (round-2 CHECK constraint).
      titleProvenance: 'EDITOR_VERIFIED',
      // createdByUserId is audit-only and deliberately has no foreign key, so a
      // public catalog fact outlives the account that contributed it.
      createdByUserId: user.id
    },
    select: { id: true }
  });

  await prisma.playSession.create({
    data: {
      userId: user.id,
      catalogGameId: game.id,
      playedAt: new Date('2026-07-15T10:00:00.000Z'),
      outcome: 'CONTINUE',
      note: 'a private note that must not survive deletion',
      clientMutationId: `del-${uniqueSuffix()}`
    }
  });
  await prisma.gameFollow.create({ data: { userId: user.id, catalogGameId: game.id } });
  await prisma.gameFieldEvidence.create({
    data: {
      catalogGameId: game.id,
      fieldPath: 'developerName',
      provenance: 'USER_CONFIRMED',
      confidence: 0.5,
      sourceType: 'user_report'
    }
  });

  try {
    await prisma.user.delete({ where: { id: user.id } });

    // Personal records cascade away.
    assert.equal(await prisma.playSession.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.gameFollow.count({ where: { userId: user.id } }), 0);

    // The public catalog fact and its provenance survive.
    const survivingGame = await prisma.catalogGame.findUnique({
      where: { id: game.id },
      select: { id: true, createdByUserId: true }
    });
    assert.ok(survivingGame, 'a published catalog game must survive account deletion');
    assert.equal(survivingGame.createdByUserId, user.id, 'the audit-only attribution is retained');
    assert.equal(await prisma.gameFieldEvidence.count({ where: { catalogGameId: game.id } }), 1);
  } finally {
    await prisma.catalogGame.deleteMany({ where: { id: game.id } });
  }
});

test('applied migration count matches the repository migration count', { skip: !enabled }, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { prisma } = require('../../src/config/prisma');

  const migrationDirs = fs.readdirSync(path.resolve(process.cwd(), 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .length;
  const [{ count }] = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
  );

  assert.equal(Number(count), migrationDirs, 'every repository migration must be applied');
});

// ===========================================================================
// Review-fix verification that only a real database can prove
// ===========================================================================

test('ten concurrent quick-add confirms converge on exactly one catalog game', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogSubmissionService = require('../../src/modules/catalog/catalog-submission.service');
  const { fingerprintInput } = require('../../src/modules/catalog/catalog-title.util');

  const user = await createUser(prisma, 'confirm');
  const submission = await prisma.gameSubmission.create({
    data: {
      userId: user.id,
      status: 'PREVIEW',
      inputType: 'URL',
      inputFingerprint: fingerprintInput(`concurrent-${uniqueSuffix()}`),
      locale: 'ko',
      regionCode: 'KR',
      draft: {
        version: 2,
        game: {
          originalTitle: 'Concurrent Confirm Game',
          requiresTitleConfirmation: false,
          developerName: null,
          publisherName: null,
          firstReleaseDate: null,
          genres: [],
          platforms: [],
          supportsSinglePlayer: null,
          supportsMultiplayer: null,
          typicalSessionMinutes: null,
          localizations: [],
          regionalReleases: [],
          identities: [{ provider: 'STEAM', externalId: `sq-${uniqueSuffix()}`, regionKey: 'GLOBAL' }],
          fieldProvenance: []
        },
        parsedIdentityClaim: { provider: 'STEAM', externalId: `sq-${uniqueSuffix()}`, regionKey: 'GLOBAL' },
        aiUsed: false,
        aiFallbackUsed: false,
        degradedToManual: false
      },
      expiresAt: new Date(Date.now() + 3_600_000)
    },
    select: { id: true }
  });

  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => catalogSubmissionService
      .confirmSubmission({ userId: user.id, submissionId: submission.id })
      .then((value) => ({ value }))
      .catch((error) => ({ error }))));

    const succeeded = results.filter((result) => result.value);
    const failed = results.filter((result) => result.error);

    assert.equal(failed.length, 0, `no confirm should error, saw: ${failed.map((f) => f.error.code ?? f.error.message).join(', ')}`);

    // Exactly one request created the game; the other nine replayed it.
    const created = succeeded.filter((result) => result.value.createdNewGame);
    const replays = succeeded.filter((result) => result.value.idempotentReplay);

    assert.equal(created.length, 1, 'exactly one confirm may create the catalog game');
    assert.equal(replays.length, 9, 'every loser must report an idempotent replay');

    const catalogGameIds = new Set(succeeded.map((result) => result.value.catalogGameId));
    assert.equal(catalogGameIds.size, 1, 'all callers must converge on one catalog game id');

    // No orphan games: the submission points at the only game that exists.
    const persisted = await prisma.gameSubmission.findUnique({
      where: { id: submission.id },
      select: { personalCatalogGameId: true, status: true }
    });

    assert.equal(persisted.personalCatalogGameId, [...catalogGameIds][0]);
    assert.equal(persisted.status, 'PERSONAL_CONFIRMED');

    const ownedGames = await prisma.catalogGame.count({ where: { createdByUserId: user.id } });
    assert.equal(ownedGames, 1, 'a concurrent confirm must not leave an orphan catalog game behind');

    // The claim is recorded, and never in the globally unique identity table.
    const claims = await prisma.gameIdentityClaim.count({ where: { catalogGameId: persisted.personalCatalogGameId } });
    assert.equal(claims, 1);

    const identities = await prisma.gameExternalIdentity.count({
      where: { catalogGameId: persisted.personalCatalogGameId }
    });
    assert.equal(identities, 0, 'a submission must never occupy a global provider identity');

    // A sequential retry after the fact returns the same result.
    const retry = await catalogSubmissionService.confirmSubmission({ userId: user.id, submissionId: submission.id });
    assert.equal(retry.idempotentReplay, true);
    assert.equal(retry.catalogGameId, persisted.personalCatalogGameId);
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.catalogGame.deleteMany({ where: { createdByUserId: user.id } });
  }
});

test('another account cannot confirm or read a submission', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogSubmissionService = require('../../src/modules/catalog/catalog-submission.service');
  const { fingerprintInput } = require('../../src/modules/catalog/catalog-title.util');

  const owner = await createUser(prisma, 'own');
  const stranger = await createUser(prisma, 'stranger');
  const submission = await prisma.gameSubmission.create({
    data: {
      userId: owner.id,
      status: 'PREVIEW',
      inputType: 'TEXT',
      inputFingerprint: fingerprintInput('cross account'),
      locale: 'ko',
      regionCode: 'KR',
      draft: { version: 2, game: { originalTitle: 'X', requiresTitleConfirmation: false, genres: [], platforms: [], localizations: [], regionalReleases: [], identities: [], fieldProvenance: [] }, parsedIdentityClaim: null, aiUsed: false, aiFallbackUsed: false, degradedToManual: false },
      expiresAt: new Date(Date.now() + 3_600_000)
    },
    select: { id: true }
  });

  try {
    await assert.rejects(
      catalogSubmissionService.confirmSubmission({ userId: stranger.id, submissionId: submission.id }),
      (error) => error.statusCode === 404 && error.code === 'SUBMISSION_NOT_FOUND'
    );
    await assert.rejects(
      catalogSubmissionService.getSubmission({ userId: stranger.id, submissionId: submission.id }),
      (error) => error.statusCode === 404
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
  }
});

test('an unverified claim does not block a real provider sync from verifying the key', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogDualWriteService = require('../../src/modules/catalog/catalog-dual-write.service');
  const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');

  const attacker = await createUser(prisma, 'squatter');
  const victim = await createUser(prisma, 'victim');
  const appId = `squat-${uniqueSuffix()}`;

  // The attacker registers a PRIVATE game and claims the provider key.
  const privateGame = await prisma.catalogGame.create({
    data: {
      originalTitle: 'Attacker Private Game',
      normalizedTitle: 'attacker private game',
      publicationStatus: 'PRIVATE',
      titleProvenance: 'USER_CONFIRMED',
      createdByUserId: attacker.id
    },
    select: { id: true }
  });
  await catalogIdentityService.recordIdentityClaim({
    catalogGameId: privateGame.id,
    claimedByUserId: attacker.id,
    provider: 'STEAM',
    externalId: appId
  });

  const libraryEntry = await prisma.userGameLibrary.create({
    data: {
      userId: victim.id,
      gameSource: 'STEAM',
      externalGameId: appId,
      gameName: 'Real Game Name',
      status: 'PLAYING'
    },
    select: { id: true }
  });

  try {
    // A verified lookup must not see the attacker's claim at all.
    assert.equal(
      await catalogIdentityService.findCanonicalGameByIdentity({ provider: 'STEAM', externalId: appId }),
      null
    );

    // The victim's real Steam sync verifies the key normally.
    const result = await catalogDualWriteService.linkVerifiedSteamOwnership({
      entries: [{ libraryEntryId: libraryEntry.id, externalGameId: appId, gameName: 'Real Game Name' }]
    });

    assert.equal(result.canonicalLinkStatus, 'linked');

    const linked = await prisma.userGameLibrary.findUnique({
      where: { id: libraryEntry.id },
      select: { catalogGameId: true, ownershipProvenance: true }
    });

    assert.ok(linked.catalogGameId);
    assert.notEqual(linked.catalogGameId, privateGame.id,
      "a real provider sync must not be captured by another account's claim");
    assert.equal(linked.ownershipProvenance, 'PROVIDER_VERIFIED');

    const verified = await prisma.catalogGame.findUnique({
      where: { id: linked.catalogGameId },
      select: { publicationStatus: true, titleProvenance: true, createdByUserId: true }
    });

    assert.equal(verified.publicationStatus, 'PUBLISHED');
    assert.equal(verified.titleProvenance, 'PROVIDER_VERIFIED');
    assert.equal(verified.createdByUserId, null);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [attacker.id, victim.id] } } });
    await prisma.catalogGame.deleteMany({ where: { id: privateGame.id } });
    await prisma.gameExternalIdentity.deleteMany({ where: { provider: 'STEAM', externalId: appId } });
  }
});

test('concurrent Steam sync links converge on one verified identity', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogDualWriteService = require('../../src/modules/catalog/catalog-dual-write.service');

  const user = await createUser(prisma, 'sync');
  const appId = `sync-${uniqueSuffix()}`;
  const entries = [];

  for (let index = 0; index < 5; index += 1) {
    const row = await prisma.userGameLibrary.create({
      data: {
        userId: user.id,
        gameSource: 'STEAM',
        externalGameId: `${appId}-${index}`,
        gameName: 'Concurrent Sync Game',
        status: 'PLAYING'
      },
      select: { id: true }
    });

    // Every row claims the SAME appid so all five races for one identity.
    entries.push({ libraryEntryId: row.id, externalGameId: appId, gameName: 'Concurrent Sync Game' });
  }

  try {
    const results = await Promise.all(entries.map((entry) => catalogDualWriteService
      .linkVerifiedSteamOwnership({ entries: [entry] })));

    assert.equal(results.every((result) => result.canonicalLinkStatus === 'linked'), true,
      'every concurrent sync must link successfully');

    const identities = await prisma.gameExternalIdentity.findMany({
      where: { provider: 'STEAM', externalId: appId },
      select: { catalogGameId: true, verifiedAt: true, verificationSource: true }
    });

    assert.equal(identities.length, 1, 'the provider key must resolve to exactly one identity row');
    assert.ok(identities[0].verifiedAt, 'a real sync must mark the identity verified');
    assert.equal(identities[0].verificationSource, 'steam_owned_games_sync');

    const linkedRows = await prisma.userGameLibrary.findMany({
      where: { userId: user.id },
      select: { catalogGameId: true }
    });

    const distinct = new Set(linkedRows.map((row) => row.catalogGameId));
    assert.equal(distinct.size, 1, 'all rows must converge on one canonical game');
    assert.equal(distinct.has(identities[0].catalogGameId), true);

    // Re-running the sync is idempotent.
    const again = await catalogDualWriteService.linkVerifiedSteamOwnership({ entries });
    assert.equal(again.canonicalLinkStatus, 'linked');
    assert.equal(
      await prisma.gameExternalIdentity.count({ where: { provider: 'STEAM', externalId: appId } }),
      1
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.gameExternalIdentity.deleteMany({ where: { provider: 'STEAM', externalId: appId } });
  }
});

test('a sync recovers a row whose catalogGameId is still null', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogDualWriteService = require('../../src/modules/catalog/catalog-dual-write.service');

  const user = await createUser(prisma, 'recover');
  const appId = `recover-${uniqueSuffix()}`;
  const row = await prisma.userGameLibrary.create({
    data: {
      userId: user.id,
      gameSource: 'STEAM',
      externalGameId: appId,
      gameName: 'Recovered Game',
      status: 'PLAYING'
      // catalogGameId deliberately null, as an earlier failed attempt would leave it.
    },
    select: { id: true, catalogGameId: true }
  });

  try {
    assert.equal(row.catalogGameId, null);

    await catalogDualWriteService.linkVerifiedSteamOwnership({
      entries: [{ libraryEntryId: row.id, externalGameId: appId, gameName: 'Recovered Game' }]
    });

    const recovered = await prisma.userGameLibrary.findUnique({
      where: { id: row.id },
      select: { catalogGameId: true, ownershipProvenance: true }
    });

    assert.ok(recovered.catalogGameId, 'the next sync must repair a null canonical link');
    assert.equal(recovered.ownershipProvenance, 'PROVIDER_VERIFIED');
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.gameExternalIdentity.deleteMany({ where: { provider: 'STEAM', externalId: appId } });
  }
});

test('a user-supplied provider id cannot create a published game or a verified identity', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogDualWriteService = require('../../src/modules/catalog/catalog-dual-write.service');

  const user = await createUser(prisma, 'manual');
  const claimedAppId = `manual-${uniqueSuffix()}`;
  const libraryEntry = await prisma.userGameLibrary.create({
    data: {
      userId: user.id,
      gameSource: 'STEAM',
      externalGameId: claimedAppId,
      gameName: 'Totally Legit Provider Game',
      status: 'PLAYING',
      // What the manual write path records: the user's own claim.
      ownershipProvenance: 'USER_CONFIRMED'
    },
    select: { id: true }
  });

  try {
    // This is the hook a manual library / review / favorite write uses.
    const linked = await catalogDualWriteService.linkResolvedLibraryEntry({
      libraryEntryId: libraryEntry.id,
      gameSource: 'STEAM',
      externalGameId: claimedAppId
    });

    assert.equal(linked, null, 'an unverified provider id must not resolve to anything');

    // No verified identity, and no catalog game at all, from a request body.
    assert.equal(
      await prisma.gameExternalIdentity.count({ where: { provider: 'STEAM', externalId: claimedAppId } }),
      0,
      'a manual write must not mint a global provider identity'
    );
    assert.equal(
      await prisma.catalogGame.count({ where: { originalTitle: 'Totally Legit Provider Game' } }),
      0,
      'a manual write must not create a catalog game'
    );

    const row = await prisma.userGameLibrary.findUnique({
      where: { id: libraryEntry.id },
      select: { catalogGameId: true, ownershipProvenance: true, gameSource: true, gameName: true }
    });

    // The legacy write still stands and kept its own identity columns.
    assert.equal(row.gameSource, 'STEAM');
    assert.equal(row.gameName, 'Totally Legit Provider Game');
    assert.equal(row.catalogGameId, null, 'an unresolvable claim leaves catalogGameId null');
    assert.equal(row.ownershipProvenance, 'USER_CONFIRMED');
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('a Playlog receipt cannot survive a failed mutation', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const playlogService = require('../../src/modules/play/playlog.service');

  const user = await createUser(prisma, 'receipt');
  const clientMutationId = `receipt-${uniqueSuffix()}`;
  const missingSessionId = '00000000-0000-4000-8000-00000000dead';

  try {
    // The session does not exist, so the delete fails inside the transaction.
    await assert.rejects(
      playlogService.deletePlaySession({ userId: user.id, sessionId: missingSessionId, clientMutationId }),
      (error) => error.statusCode === 404
    );

    // The receipt must have rolled back with it.
    assert.equal(
      await prisma.clientMutationReceipt.count({
        where: { userId: user.id, scope: 'play_session_delete', clientMutationId }
      }),
      0,
      'a receipt must not outlive the mutation it describes'
    );

    // So a retry against a real session actually performs the delete rather than
    // reporting a bogus replay.
    const game = await prisma.catalogGame.create({
      data: {
        originalTitle: 'Receipt Game',
        normalizedTitle: 'receipt game',
        publicationStatus: 'PUBLISHED',
        titleProvenance: 'EDITOR_VERIFIED'
      },
      select: { id: true }
    });
    const session = await prisma.playSession.create({
      data: {
        userId: user.id,
        catalogGameId: game.id,
        playedAt: new Date('2026-07-15T10:00:00.000Z'),
        outcome: 'CONTINUE',
        clientMutationId: `create-${uniqueSuffix()}`
      },
      select: { id: true }
    });

    const retry = await playlogService.deletePlaySession({
      userId: user.id,
      sessionId: session.id,
      clientMutationId
    });

    assert.equal(retry.deleted, true, 'the retry must really delete, not report a replay');
    assert.equal(retry.idempotentReplay, false);
    assert.equal(await prisma.playSession.count({ where: { id: session.id } }), 0);

    await prisma.catalogGame.deleteMany({ where: { id: game.id } });
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('concurrent delete retries with one key apply exactly once', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const playlogService = require('../../src/modules/play/playlog.service');

  const user = await createUser(prisma, 'delrace');
  const game = await prisma.catalogGame.create({
    data: {
      originalTitle: 'Delete Race',
      normalizedTitle: 'delete race',
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'EDITOR_VERIFIED'
    },
    select: { id: true }
  });
  const session = await prisma.playSession.create({
    data: {
      userId: user.id,
      catalogGameId: game.id,
      playedAt: new Date('2026-07-15T10:00:00.000Z'),
      outcome: 'CONTINUE',
      clientMutationId: `seed-${uniqueSuffix()}`
    },
    select: { id: true }
  });
  const clientMutationId = `race-${uniqueSuffix()}`;

  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => playlogService
      .deletePlaySession({ userId: user.id, sessionId: session.id, clientMutationId })
      .then((value) => ({ value }))
      .catch((error) => ({ error }))));

    const applied = results.filter((result) => result.value?.deleted === true);
    const replayed = results.filter((result) => result.value?.idempotentReplay === true);

    assert.equal(applied.length, 1, 'exactly one concurrent retry may apply the delete');
    assert.equal(applied.length + replayed.length, 6, 'every other retry must be a replay');
    assert.equal(await prisma.playSession.count({ where: { id: session.id } }), 0);
    assert.equal(
      await prisma.clientMutationReceipt.count({
        where: { userId: user.id, scope: 'play_session_delete', clientMutationId }
      }),
      1
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.catalogGame.deleteMany({ where: { id: game.id } });
  }
});

test('a play session always stores the canonical survivor id', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const playlogService = require('../../src/modules/play/playlog.service');

  const user = await createUser(prisma, 'canon');
  const survivor = await prisma.catalogGame.create({
    data: {
      originalTitle: 'Survivor Game',
      normalizedTitle: 'survivor game',
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'EDITOR_VERIFIED'
    },
    select: { id: true }
  });
  const tombstone = await prisma.catalogGame.create({
    data: {
      originalTitle: 'Tombstone Game',
      normalizedTitle: 'tombstone game',
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'EDITOR_VERIFIED',
      mergedIntoCatalogGameId: survivor.id
    },
    select: { id: true }
  });

  try {
    // Create with the tombstone id.
    const created = await playlogService.createPlaySession({
      userId: user.id,
      input: {
        catalogGameId: tombstone.id,
        playedAt: new Date('2026-07-15T10:00:00.000Z'),
        outcome: 'CONTINUE',
        clientMutationId: `canon-${uniqueSuffix()}`
      }
    });

    assert.equal(created.session.catalogGameId, survivor.id, 'create must resolve to the survivor');

    // Update with the tombstone id too.
    const other = await prisma.catalogGame.create({
      data: {
        originalTitle: 'Other Game',
        normalizedTitle: 'other game',
        publicationStatus: 'PUBLISHED',
        titleProvenance: 'EDITOR_VERIFIED'
      },
      select: { id: true }
    });
    const otherTombstone = await prisma.catalogGame.create({
      data: {
        originalTitle: 'Other Tombstone',
        normalizedTitle: 'other tombstone',
        publicationStatus: 'PUBLISHED',
        titleProvenance: 'EDITOR_VERIFIED',
        mergedIntoCatalogGameId: other.id
      },
      select: { id: true }
    });

    const updated = await playlogService.updatePlaySession({
      userId: user.id,
      sessionId: created.session.id,
      patch: { catalogGameId: otherTombstone.id }
    });

    assert.equal(updated.session.catalogGameId, other.id, 'update must resolve to the survivor');

    await prisma.catalogGame.deleteMany({ where: { id: { in: [other.id, otherTombstone.id] } } });
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.catalogGame.deleteMany({ where: { id: { in: [tombstone.id, survivor.id] } } });
  }
});

test('the article current revision is a real enforced reference', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');

  const foreignKeys = await prisma.$queryRawUnsafe(`
    SELECT tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'editorial_articles'
      AND kcu.column_name = 'current_revision_id'
      AND tc.constraint_type = 'FOREIGN KEY'
  `);

  assert.equal(foreignKeys.length, 1, 'current_revision_id must be a real foreign key');

  // Prisma expresses @unique as a unique index rather than a table constraint.
  const uniqueIndexes = await prisma.$queryRawUnsafe(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'editorial_articles'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
      AND indexdef LIKE '%current_revision_id%'
  `);

  assert.equal(uniqueIndexes.length, 1, 'current_revision_id must be unique');
});

test('published article bodies survive the full editorial lifecycle', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const articleService = require('../../src/modules/feed/article.service');

  const editor = await createUser(prisma, 'editor');
  await prisma.userRoleAssignment.create({ data: { userId: editor.id, role: 'EDITOR' } });
  const slug = `lifecycle-${uniqueSuffix()}`;

  try {
    await articleService.createArticle({
      actorUserId: editor.id,
      input: {
        slug,
        locale: 'ko',
        headline: 'Lifecycle headline',
        excerpt: 'Lifecycle excerpt.',
        bodyMarkdown: '# The real body\n\nWith content.',
        sources: [],
        relatedGames: [],
        assets: []
      }
    });

    // Advance through the workflow without ever resupplying the body.
    for (const status of ['FACT_CHECK', 'RIGHTS_REVIEW', 'SCHEDULED']) {
      await articleService.updateArticle({
        actorUserId: editor.id,
        slug,
        input: { status, sources: [], relatedGames: [], assets: [] }
      });
    }

    await articleService.publishArticle({ actorUserId: editor.id, slug });

    const published = await articleService.getPublishedArticleBySlug({ slug });

    // The public magazine endpoint must return the actual article.
    assert.equal(published.bodyMarkdown, '# The real body\n\nWith content.');
    assert.equal(published.bodyFormat, 'commonmark-no-html');
    assert.equal(published.status, 'PUBLISHED');
    assert.ok(published.revision.revisionNumber >= 5);

    // The current revision pointer is consistent with what was served.
    const article = await prisma.editorialArticle.findUnique({
      where: { slug },
      select: { currentRevisionId: true, currentRevision: { select: { bodyMarkdown: true, status: true } } }
    });

    assert.ok(article.currentRevisionId);
    assert.equal(article.currentRevision.bodyMarkdown, '# The real body\n\nWith content.');
    assert.equal(article.currentRevision.status, 'PUBLISHED');

    // A silent edit of live content is refused.
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: editor.id,
        slug,
        input: { headline: 'Sneaky', sources: [], relatedGames: [], assets: [] }
      }),
      (error) => error.code === 'ARTICLE_CORRECTION_REQUIRED'
    );

    // A proper correction is audited and keeps the body.
    await articleService.updateArticle({
      actorUserId: editor.id,
      slug,
      input: {
        headline: 'Corrected headline',
        status: 'CORRECTED',
        changeNote: 'Fixed a factual error',
        sources: [],
        relatedGames: [],
        assets: []
      }
    });

    const corrected = await prisma.editorialArticle.findUnique({
      where: { slug },
      select: { status: true, correctedAt: true, currentRevision: { select: { changeNote: true, bodyMarkdown: true } } }
    });

    assert.equal(corrected.status, 'CORRECTED');
    assert.ok(corrected.correctedAt, 'a correction must be timestamped');
    assert.equal(corrected.currentRevision.changeNote, 'Fixed a factual error');
    assert.equal(corrected.currentRevision.bodyMarkdown, '# The real body\n\nWith content.');

    // A CORRECTED article is still publicly readable, with its body.
    const afterCorrection = await articleService.getPublishedArticleBySlug({ slug });
    assert.equal(afterCorrection.bodyMarkdown, '# The real body\n\nWith content.');

    // Retraction removes it from the public endpoint.
    await articleService.retractArticle({ actorUserId: editor.id, slug, reasonCode: 'factual_error' });
    await assert.rejects(
      articleService.getPublishedArticleBySlug({ slug }),
      (error) => error.code === 'ARTICLE_NOT_FOUND'
    );
  } finally {
    await prisma.editorialArticle.deleteMany({ where: { slug } });
    await prisma.user.deleteMany({ where: { id: editor.id } });
  }
});

test('the successor migration corrected overstated legacy provenance', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');

  // Nothing in the database may claim PROVIDER_VERIFIED without a verifiedAt, and
  // nothing may be PUBLISHED on the strength of unverified provenance alone.
  const [{ count: unbackedVerified }] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS count FROM "game_external_identities"
    WHERE "provenance" = 'PROVIDER_VERIFIED' AND "verified_at" IS NULL
  `);
  assert.equal(Number(unbackedVerified), 0,
    'a PROVIDER_VERIFIED identity must carry a verifiedAt');

  const [{ count: syntheticPublished }] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS count FROM "catalog_games"
    WHERE "publication_status" = 'PUBLISHED'
      AND "merged_into_catalog_game_id" IS NULL
      AND "original_title" ~ '^(IGDB|STEAM|APPLE_APP_STORE|GOOGLE_PLAY|OFFICIAL_SITE|COMMUNITY):'
  `);
  assert.equal(Number(syntheticPublished), 0,
    'a synthetic PROVIDER:id placeholder must not be publicly searchable');
});

test('every stored normalized title matches the JavaScript normalizer exactly', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const {
    normalizeTitle,
    RETAINED_MARK_CLASS,
    STRIPPED_LEGAL_SYMBOLS
  } = require('../../src/modules/catalog/catalog-title.util');

  // A multi-script corpus written through the API, then normalized by the database
  // expression, must produce byte-identical results. This is the parity the
  // successor migration's recomputation depends on.
  const corpus = [
    'เกมออนไลน์', 'กิน', 'العاب اونلاين', 'Онлайн игра', 'Pokémon', 'Café Racer',
    'ゲーム', 'ポケモン ソード', '崩坏：星穹铁道', '傳說對決', '오버워치 2',
    'Hollow Knight™', 'Portal 2®', 'Ｐｏｒｔａｌ ２', 'FINAL FANTASY Ⅷ',
    'Việt Nam Game', 'Ελληνικό παιχνίδι', 'משחק עברי', 'S.T.A.L.K.E.R.'
  ];
  const created = [];

  try {
    for (const title of corpus) {
      const game = await prisma.catalogGame.create({
        data: {
          originalTitle: title,
          normalizedTitle: normalizeTitle(title),
          publicationStatus: 'PRIVATE'
        },
        select: { id: true }
      });

      created.push(game.id);
    }

    // Ask the database to recompute with the migration's own expression.
    const rows = await prisma.$queryRawUnsafe(`
      SELECT "original_title" AS original,
             "normalized_title" AS stored,
             left(btrim(regexp_replace(lower(normalize(translate("original_title", $$${STRIPPED_LEGAL_SYMBOLS}$$, ''), NFKC)),
                  $$[^[:alnum:]${RETAINED_MARK_CLASS}]+$$, ' ', 'g')), 300) AS recomputed
      FROM "catalog_games"
      WHERE "id" = ANY($1::uuid[])
    `, created);

    assert.equal(rows.length, corpus.length);

    for (const row of rows) {
      assert.equal(row.stored, row.recomputed,
        `stored and SQL-recomputed normalization must agree for ${row.original}`);
      assert.equal(row.stored, normalizeTitle(row.original),
        `JavaScript and SQL normalization must agree for ${row.original}`);
      assert.notEqual(row.stored, '', `${row.original} must remain searchable`);
    }
  } finally {
    await prisma.catalogGame.deleteMany({ where: { id: { in: created } } });
  }
});

test('a non-Latin title is findable through catalog search', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogService = require('../../src/modules/catalog/catalog.service');
  const { normalizeTitle } = require('../../src/modules/catalog/catalog-title.util');

  const user = await createUser(prisma, 'search');
  const titles = ['เกมออนไลน์ ผจญภัย', 'Онлайн игра Тетрис', 'العاب اونلاين حرب'];
  const created = [];

  try {
    for (const title of titles) {
      const game = await prisma.catalogGame.create({
        data: {
          originalTitle: title,
          normalizedTitle: normalizeTitle(title),
          publicationStatus: 'PUBLISHED',
          titleProvenance: 'EDITOR_VERIFIED'
        },
        select: { id: true }
      });

      created.push(game.id);
      await prisma.gameLocalization.create({
        data: {
          catalogGameId: game.id,
          kind: 'ORIGINAL_TITLE',
          languageCode: 'und',
          regionCode: 'GLOBAL',
          title,
          normalizedTitle: normalizeTitle(title),
          provenance: 'EDITOR_VERIFIED'
        }
      });
    }

    for (const title of titles) {
      const result = await catalogService.searchCatalogGames({ userId: user.id, query: title, limit: 10 });

      assert.ok(result.games.length > 0, `${title} must be findable by its exact title`);
      assert.equal(result.games.some((game) => game.originalTitle === title), true);

      // A case/punctuation variant must find it too.
      const variant = await catalogService.searchCatalogGames({
        userId: user.id,
        query: `  ${title}!  `,
        limit: 10
      });

      assert.ok(variant.games.length > 0, `${title} must be findable with punctuation noise`);
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.catalogGame.deleteMany({ where: { id: { in: created } } });
  }
});
