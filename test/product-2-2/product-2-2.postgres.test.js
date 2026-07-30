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

  try {
    await prisma.gameExternalIdentity.create({
      data: { catalogGameId: gameOne.id, provider: 'STEAM', externalId, regionKey: 'GLOBAL' }
    });

    // The same provider key cannot point at a second canonical game.
    await assert.rejects(
      prisma.gameExternalIdentity.create({
        data: { catalogGameId: gameTwo.id, provider: 'STEAM', externalId, regionKey: 'GLOBAL' }
      }),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );

    // A different region key is a different listing and is allowed.
    await assert.doesNotReject(prisma.gameExternalIdentity.create({
      data: { catalogGameId: gameTwo.id, provider: 'STEAM', externalId, regionKey: 'KR' }
    }));
  } finally {
    await prisma.catalogGame.deleteMany({ where: { id: { in: [gameOne.id, gameTwo.id] } } });
  }
});

test('the legacy dual write is idempotent and reuses the canonical game', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');
  const externalId = `dual-${uniqueSuffix()}`;

  const first = await catalogIdentityService.linkLegacyIdentity({
    gameSource: 'STEAM',
    externalGameId: externalId,
    title: 'Dual Write Game'
  });
  const second = await catalogIdentityService.linkLegacyIdentity({
    gameSource: 'STEAM',
    externalGameId: externalId,
    title: 'Dual Write Game'
  });
  // Concurrent callers must converge on the same canonical game.
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => catalogIdentityService.linkLegacyIdentity({
    gameSource: 'STEAM',
    externalGameId: externalId,
    title: 'Dual Write Game'
  })));

  try {
    assert.equal(second, first, 'a repeated dual write must not create a second canonical game');
    assert.equal(new Set([first, second, ...concurrent]).size, 1, 'all callers must converge on one canonical game');

    const identities = await prisma.gameExternalIdentity.findMany({
      where: { provider: 'STEAM', externalId },
      select: { id: true }
    });
    assert.equal(identities.length, 1, 'exactly one identity row must exist');
  } finally {
    await prisma.catalogGame.deleteMany({ where: { id: first } });
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
    data: { originalTitle: 'Playlog Game', normalizedTitle: 'playlog game', publicationStatus: 'PUBLISHED' },
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
    data: { originalTitle: 'Isolation Game', normalizedTitle: 'isolation game', publicationStatus: 'PUBLISHED' },
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
    assert.equal(await featureFlagService.isFeatureEnabled('playlog'), true);

    await prisma.productFeatureFlag.upsert({
      where: { key: 'playlog' },
      create: { key: 'playlog', enabled: false },
      update: { enabled: false }
    });

    // No process restart and no cache invalidation: the next read must observe it.
    assert.equal(await featureFlagService.isFeatureEnabled('playlog'), false);
    assert.equal(await featureFlagService.isFeatureEnabled('openCatalog'), true, 'other switches stay independent');

    await prisma.productFeatureFlag.update({ where: { key: 'playlog' }, data: { enabled: true } });
    assert.equal(await featureFlagService.isFeatureEnabled('playlog'), true);
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
