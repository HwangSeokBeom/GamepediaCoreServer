const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Round-2 review findings, proven against a real PostgreSQL 16 database.
//
// A mocked Prisma client cannot prove any of this. A CHECK constraint, a
// SELECT ... FOR UPDATE lock, a transaction rollback and a genuine race between
// connections only exist in the database, and every finding in this file was about
// exactly one of those. Each test therefore performs the attack and asserts on rows
// read back from the database afterwards.
//
// Skipped unless RUN_POSTGRES_INTEGRATION=1 with a disposable DATABASE_URL, which
// scripts/test/run-product-2-2-postgres-gate.sh supplies.

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';

const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';

function uniqueSuffix() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function createUser(prisma, label) {
  const suffix = uniqueSuffix();

  return prisma.user.create({
    data: {
      email: `r2-${label}-${suffix}@example.invalid`,
      nickname: `r2-${label}-${suffix}`.slice(0, 50),
      passwordHash: 'integration-test-not-a-real-password-hash'
    }
  });
}

/// SQLSTATE of a raised PostgreSQL error, wherever Prisma decided to put it.
function sqlStateOf(error) {
  return error?.meta?.code ?? error?.code ?? null;
}

// ===========================================================================
// A. Legacy Steam identity capture
// ===========================================================================

test('a user-supplied appid cannot capture a later real Steam sync', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');

  const attacker = await createUser(prisma, 'attacker');
  const externalId = `capture-${uniqueSuffix()}`;
  const createdGames = [];

  // The attacker's side of the attack: a quick-add claim naming a provider key they
  // do not own, on a catalog game whose title they chose.
  const attackerGame = await prisma.catalogGame.create({
    data: {
      originalTitle: 'Attacker Controlled Title',
      normalizedTitle: 'attacker controlled title',
      genres: [],
      steamTags: [],
      platforms: ['STEAM'],
      // The publication CHECK constraint forbids PUBLISHED here, which is itself
      // half the fix: the attacker cannot even stage a public game.
      publicationStatus: 'PENDING_REVIEW',
      titleProvenance: 'USER_CONFIRMED',
      createdByUserId: attacker.id
    },
    select: { id: true }
  });
  createdGames.push(attackerGame.id);

  try {
    await catalogIdentityService.recordIdentityClaim({
      catalogGameId: attackerGame.id,
      claimedByUserId: attacker.id,
      provider: 'STEAM',
      externalId,
      provenance: 'USER_CONFIRMED',
      claimSource: 'quick_add_syntax_parse'
    });

    // The victim's real Steam owned-games sync for the same appid.
    const { catalogGameId } = await catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
      provider: 'STEAM',
      externalId,
      title: 'Real Provider Title',
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'PROVIDER_VERIFIED',
      identityProvenance: 'PROVIDER_VERIFIED',
      verificationSource: 'steam_owned_games_sync',
      platforms: ['STEAM'],
      verifiedAt: new Date()
    });

    createdGames.push(catalogGameId);

    // The whole finding: the sync used to return the attacker's game.
    assert.notEqual(catalogGameId, attackerGame.id,
      'a real provider sync must never adopt an unverified claim\'s catalog game');

    const canonical = await prisma.catalogGame.findUnique({
      where: { id: catalogGameId },
      select: { originalTitle: true, publicationStatus: true, titleProvenance: true, createdByUserId: true }
    });

    assert.equal(canonical.originalTitle, 'Real Provider Title');
    assert.equal(canonical.publicationStatus, 'PUBLISHED');
    assert.equal(canonical.titleProvenance, 'PROVIDER_VERIFIED');
    assert.equal(canonical.createdByUserId, null, 'a provider-created game is attributed to no account');

    // The attacker's game is untouched: not merged, not published, not renamed.
    const attackerRow = await prisma.catalogGame.findUnique({
      where: { id: attackerGame.id },
      select: { originalTitle: true, publicationStatus: true, titleProvenance: true, mergedIntoCatalogGameId: true }
    });

    assert.equal(attackerRow.originalTitle, 'Attacker Controlled Title');
    assert.equal(attackerRow.publicationStatus, 'PENDING_REVIEW');
    assert.equal(attackerRow.titleProvenance, 'USER_CONFIRMED');
    assert.equal(attackerRow.mergedIntoCatalogGameId, null);

    // Exactly one verified identity for the key, pointing at the provider's game,
    // and the attacker's claim still recorded separately as a claim.
    const identities = await prisma.gameExternalIdentity.findMany({
      where: { provider: 'STEAM', externalId },
      select: { catalogGameId: true, provenance: true, verifiedAt: true, verificationSource: true }
    });

    assert.equal(identities.length, 1);
    assert.equal(identities[0].catalogGameId, catalogGameId);
    assert.equal(identities[0].provenance, 'PROVIDER_VERIFIED');
    assert.equal(identities[0].verificationSource, 'steam_owned_games_sync');
    assert.ok(identities[0].verifiedAt instanceof Date);

    const claims = await prisma.gameIdentityClaim.findMany({
      where: { provider: 'STEAM', externalId },
      select: { catalogGameId: true, provenance: true }
    });

    assert.equal(claims.length, 1);
    assert.equal(claims[0].catalogGameId, attackerGame.id);
    assert.equal(claims[0].provenance, 'USER_CONFIRMED');
  } finally {
    await prisma.user.deleteMany({ where: { id: attacker.id } });
    await prisma.gameExternalIdentity.deleteMany({ where: { provider: 'STEAM', externalId } });
    await prisma.gameIdentityClaim.deleteMany({ where: { provider: 'STEAM', externalId } });
    await prisma.gameLocalization.deleteMany({ where: { catalogGameId: { in: createdGames } } });
    await prisma.catalogGame.deleteMany({ where: { id: { in: createdGames } } });
  }
});

test('the database itself refuses an unverified global identity', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');

  const game = await prisma.catalogGame.create({
    data: {
      originalTitle: `Check Constraint Probe ${uniqueSuffix()}`,
      normalizedTitle: 'check constraint probe',
      genres: [],
      steamTags: [],
      platforms: [],
      publicationStatus: 'PENDING_REVIEW',
      titleProvenance: 'UNKNOWN'
    },
    select: { id: true }
  });

  try {
    // 1. An unverified provenance in the global table.
    for (const provenance of ['USER_CONFIRMED', 'COMMUNITY_CONFIRMED', 'AI_INFERRED', 'UNKNOWN', 'DISPUTED']) {
      const error = await prisma.$executeRawUnsafe(`
        INSERT INTO "game_external_identities"
          ("id", "catalog_game_id", "provider", "external_id", "region_key",
           "provenance", "confidence", "verified_at", "verification_source",
           "created_at", "updated_at")
        VALUES (gen_random_uuid(), '${game.id}'::uuid, 'STEAM', 'probe-${uniqueSuffix()}', 'GLOBAL',
                '${provenance}'::"CatalogProvenance", 1, CURRENT_TIMESTAMP, 'steam_owned_games_sync',
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).then(() => null, (caught) => caught);

      assert.ok(error, `${provenance} must be rejected by the database`);
      assert.equal(sqlStateOf(error), CHECK_VIOLATION,
        `${provenance} must fail the verified-provenance CHECK, not something else`);
    }

    // 2. A missing verifiedAt, which is what every legacy row had.
    const missingVerifiedAt = await prisma.$executeRawUnsafe(`
      INSERT INTO "game_external_identities"
        ("id", "catalog_game_id", "provider", "external_id", "region_key",
         "provenance", "confidence", "verified_at", "verification_source",
         "created_at", "updated_at")
      VALUES (gen_random_uuid(), '${game.id}'::uuid, 'STEAM', 'probe-${uniqueSuffix()}', 'GLOBAL',
              'PROVIDER_VERIFIED'::"CatalogProvenance", 1, NULL, 'steam_owned_games_sync',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).then(() => null, (caught) => caught);

    assert.ok(missingVerifiedAt);
    assert.equal(sqlStateOf(missingVerifiedAt), NOT_NULL_VIOLATION, 'verified_at must be NOT NULL');

    // 3. A blank verification source, which would satisfy NOT NULL but name nothing.
    const blankSource = await prisma.$executeRawUnsafe(`
      INSERT INTO "game_external_identities"
        ("id", "catalog_game_id", "provider", "external_id", "region_key",
         "provenance", "confidence", "verified_at", "verification_source",
         "created_at", "updated_at")
      VALUES (gen_random_uuid(), '${game.id}'::uuid, 'STEAM', 'probe-${uniqueSuffix()}', 'GLOBAL',
              'PROVIDER_VERIFIED'::"CatalogProvenance", 1, CURRENT_TIMESTAMP, '   ',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).then(() => null, (caught) => caught);

    assert.ok(blankSource);
    assert.equal(sqlStateOf(blankSource), CHECK_VIOLATION, 'a blank verification source must be rejected');

    // 4. A claim that asserts verified provenance, which is the same capture by
    //    another route.
    const verifiedClaim = await prisma.$executeRawUnsafe(`
      INSERT INTO "game_identity_claims"
        ("id", "catalog_game_id", "provider", "external_id", "region_key",
         "provenance", "claim_source", "created_at", "updated_at")
      VALUES (gen_random_uuid(), '${game.id}'::uuid, 'STEAM', 'probe-${uniqueSuffix()}', 'GLOBAL',
              'PROVIDER_VERIFIED'::"CatalogProvenance", 'quick_add_syntax_parse',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).then(() => null, (caught) => caught);

    assert.ok(verifiedClaim);
    assert.equal(sqlStateOf(verifiedClaim), CHECK_VIOLATION, 'a claim must never assert verified provenance');

    // 5. A PUBLISHED game whose title provenance is not verified — the state the
    //    round-1 migration left behind for realistic-looking legacy titles.
    const publishedUnverified = await prisma.$executeRawUnsafe(`
      UPDATE "catalog_games" SET "publication_status" = 'PUBLISHED' WHERE "id" = '${game.id}'::uuid
    `).then(() => null, (caught) => caught);

    assert.ok(publishedUnverified);
    assert.equal(sqlStateOf(publishedUnverified), CHECK_VIOLATION,
      'an UNKNOWN title provenance must not be publishable');
  } finally {
    await prisma.gameExternalIdentity.deleteMany({ where: { catalogGameId: game.id } });
    await prisma.gameIdentityClaim.deleteMany({ where: { catalogGameId: game.id } });
    await prisma.catalogGame.deleteMany({ where: { id: game.id } });
  }
});

test('the successor migration demoted realistic legacy titles and their localizations', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');

  // The round-1 migration only demoted synthetic "PROVIDER:id" placeholders, so a
  // legacy title that merely looked like a real game name stayed PUBLISHED with
  // UNKNOWN provenance, and its ORIGINAL_TITLE localization kept the
  // PROVIDER_VERIFIED provenance the first backfill wrote. Whatever the fixture
  // contains, neither state may exist anywhere in the database now.
  const publishedUnverified = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS count FROM "catalog_games"
    WHERE "publication_status" = 'PUBLISHED'
      AND "title_provenance" NOT IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED')
  `);

  assert.equal(Number(publishedUnverified[0].count), 0,
    'no PUBLISHED game may carry unverified title provenance, placeholder-looking or not');

  const overstatedLocalizations = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS count
    FROM "game_localizations" AS localization
    JOIN "catalog_games" AS game ON game."id" = localization."catalog_game_id"
    WHERE localization."provenance" IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED')
      AND game."title_provenance" NOT IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED')
  `);

  assert.equal(Number(overstatedLocalizations[0].count), 0,
    'a localization cannot be verified when its game\'s title provenance is not');

  const unverifiedIdentities = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS count FROM "game_external_identities"
    WHERE "verified_at" IS NULL
       OR btrim("verification_source") = ''
       OR "provenance" NOT IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED')
  `);

  assert.equal(Number(unverifiedIdentities[0].count), 0,
    'the global identity table must contain verified rows only');

  // The four invariants must exist as constraints, not merely hold by luck.
  const constraints = await prisma.$queryRawUnsafe(`
    SELECT conname FROM pg_constraint
    WHERE contype = 'c' AND conname IN (
      'game_external_identities_verified_provenance_check',
      'game_external_identities_verification_source_present_check',
      'catalog_games_published_requires_verified_title_check',
      'game_identity_claims_unverified_provenance_check'
    )
  `);

  assert.equal(constraints.length, 4, 'every round-2 CHECK constraint must be present');
});

// ===========================================================================
// B. Catalog creation atomicity
// ===========================================================================

test('a failed identity insert leaves no orphan game, and the retry does not duplicate', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');

  const externalId = `atomic-fail-${uniqueSuffix()}`;
  const title = `Atomicity Probe ${uniqueSuffix()}`;
  const triggerName = 'product_2_2_round_3_reject_atomic_identity';
  const functionName = 'product_2_2_round_3_reject_atomic_identity';

  const gamesWithTitle = () => prisma.catalogGame.count({ where: { originalTitle: title } });

  try {
    // Failure injection lives in the disposable database, not production code.
    // It fires only for this test's prefix and only after the actual service has
    // created its game and localization in the same transaction.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.external_id LIKE 'atomic-fail-%' THEN
          RAISE EXCEPTION 'round-3 deterministic identity insert failure'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON "game_external_identities"
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
    `);

    const injectedFailure = await catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
      provider: 'STEAM',
      externalId,
      title,
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'PROVIDER_VERIFIED',
      identityProvenance: 'PROVIDER_VERIFIED',
      verificationSource: 'steam_owned_games_sync',
      platforms: ['STEAM'],
      verifiedAt: new Date()
    }).then(() => null, (caught) => caught);

    assert.ok(injectedFailure, 'the actual service call must reach the injected identity failure');
    assert.equal(sqlStateOf(injectedFailure), CHECK_VIOLATION);

    // The pre-fix code left the published game behind here, with no identity.
    assert.equal(await gamesWithTitle(), 0, 'a rolled-back create must leave no orphan catalog game');
    assert.equal(await prisma.gameExternalIdentity.count({ where: { provider: 'STEAM', externalId } }), 0);

    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${triggerName} ON "game_external_identities"`
    );
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);

    // The retry: exactly one game, exactly one identity.
    const first = await catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
      provider: 'STEAM',
      externalId,
      title,
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'PROVIDER_VERIFIED',
      identityProvenance: 'PROVIDER_VERIFIED',
      verificationSource: 'steam_owned_games_sync',
      platforms: ['STEAM'],
      verifiedAt: new Date()
    });

    assert.equal(await gamesWithTitle(), 1, 'the retry must create exactly one game');

    // And a second retry is a no-op, not a third game.
    const second = await catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
      provider: 'STEAM',
      externalId,
      title,
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'PROVIDER_VERIFIED',
      identityProvenance: 'PROVIDER_VERIFIED',
      verificationSource: 'steam_owned_games_sync',
      platforms: ['STEAM'],
      verifiedAt: new Date()
    });

    assert.equal(second.catalogGameId, first.catalogGameId);
    assert.equal(second.created, false);
    assert.equal(await gamesWithTitle(), 1, 'a repeated sync must not duplicate the canonical game');
    assert.equal(await prisma.gameExternalIdentity.count({ where: { provider: 'STEAM', externalId } }), 1);
  } finally {
    const games = await prisma.catalogGame.findMany({ where: { originalTitle: title }, select: { id: true } });
    const ids = games.map((game) => game.id);

    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${triggerName} ON "game_external_identities"`
    );
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await prisma.gameExternalIdentity.deleteMany({ where: { provider: 'STEAM', externalId } });
    await prisma.gameLocalization.deleteMany({ where: { catalogGameId: { in: ids } } });
    await prisma.catalogGame.deleteMany({ where: { id: { in: ids } } });
  }
});

test('ten concurrent Steam syncs of one appid converge on a single canonical game', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');

  const externalId = `race-${uniqueSuffix()}`;
  const title = `Race Probe ${uniqueSuffix()}`;

  try {
    // Ten real connections, ten real transactions. A process-local mutex would
    // prove nothing here; the unique index and ON CONFLICT DO NOTHING must.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
        provider: 'STEAM',
        externalId,
        title,
        publicationStatus: 'PUBLISHED',
        titleProvenance: 'PROVIDER_VERIFIED',
        identityProvenance: 'PROVIDER_VERIFIED',
        verificationSource: 'steam_owned_games_sync',
        platforms: ['STEAM'],
        verifiedAt: new Date()
      }))
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');

    assert.ok(fulfilled.length > 0, 'at least one concurrent sync must succeed');

    // A serialization failure is an acceptable loss (the caller retries); a wrong
    // answer is not. Every winner must name the same canonical game.
    const canonicalIds = new Set(fulfilled.map((result) => result.value.catalogGameId));

    assert.equal(canonicalIds.size, 1, `all winners must agree, saw ${canonicalIds.size} distinct games`);

    const identities = await prisma.gameExternalIdentity.count({ where: { provider: 'STEAM', externalId } });

    assert.equal(identities, 1, 'the provider key must resolve to exactly one verified identity');

    // No losing transaction may have left its catalog game behind.
    const games = await prisma.catalogGame.count({ where: { originalTitle: title } });

    assert.equal(games, 1, `exactly one catalog game must survive the race, found ${games}`);
  } finally {
    const games = await prisma.catalogGame.findMany({ where: { originalTitle: title }, select: { id: true } });
    const ids = games.map((game) => game.id);

    await prisma.gameExternalIdentity.deleteMany({ where: { provider: 'STEAM', externalId } });
    await prisma.gameLocalization.deleteMany({ where: { catalogGameId: { in: ids } } });
    await prisma.catalogGame.deleteMany({ where: { id: { in: ids } } });
  }
});

// ===========================================================================
// C. Editorial TOCTOU
// ===========================================================================

async function createEditor(prisma, label) {
  const user = await createUser(prisma, label);

  await prisma.userRoleAssignment.create({ data: { userId: user.id, role: 'EDITOR' } });

  return user;
}

async function createScheduledArticle(prisma, { editorUserId, slug, bodyMarkdown = '# Reviewed body' }) {
  const article = await prisma.editorialArticle.create({
    data: {
      slug,
      status: 'SCHEDULED',
      locale: 'ko',
      headline: 'Scheduled headline',
      excerpt: 'Scheduled excerpt',
      authorUserId: editorUserId
    },
    select: { id: true }
  });

  const revision = await prisma.articleRevision.create({
    data: {
      articleId: article.id,
      revisionNumber: 1,
      status: 'SCHEDULED',
      headline: 'Scheduled headline',
      excerpt: 'Scheduled excerpt',
      bodyMarkdown,
      changeNote: 'ready for review',
      editorUserId
    },
    select: { id: true, revisionNumber: true }
  });

  await prisma.editorialArticle.update({
    where: { id: article.id },
    data: { currentRevisionId: revision.id }
  });

  return { articleId: article.id, revisionNumber: revision.revisionNumber };
}

test('an edit that races a real concurrent publish cannot silently change the live article', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const articleService = require('../../src/modules/feed/article.service');

  const editor = await createEditor(prisma, 'editor-race');
  const slug = `race-article-${uniqueSuffix()}`;
  const { articleId } = await createScheduledArticle(prisma, { editorUserId: editor.id, slug });

  try {
    // Two connections, both starting from the same SCHEDULED state. Whichever loses
    // the row lock must see the winner's committed status, not its own stale read.
    const [publishResult, editResult] = await Promise.allSettled([
      articleService.publishArticle({ actorUserId: editor.id, slug }),
      articleService.updateArticle({
        actorUserId: editor.id,
        slug,
        // An ordinary edit, prepared while the article was still SCHEDULED.
        input: { headline: 'Quietly changed', sources: [], relatedGames: [], assets: [] }
      })
    ]);

    const article = await prisma.editorialArticle.findUnique({
      where: { id: articleId },
      select: { status: true, headline: true, correctedAt: true }
    });

    // Publishing a valid scheduled article has no legal losing outcome. In
    // particular, asserting only the final row used to let "both failed" pass.
    assert.equal(publishResult.status, 'fulfilled',
      `publish must succeed; rejected with ${publishResult.reason?.code ?? publishResult.reason?.name ?? 'unknown'}`);
    assert.equal(article.status, 'PUBLISHED');
    assert.equal(article.correctedAt, null);

    if (editResult.status === 'fulfilled') {
      // The edit acquired the lock first while the row was SCHEDULED; publish then
      // appended the next revision.
      assert.equal(article.status, 'PUBLISHED');
      assert.equal(article.headline, 'Quietly changed',
        'a successful edit must have committed before publish');
    } else {
      // Publish acquired the lock first. The edit must re-read PUBLISHED under the
      // lock and enforce the correction contract; no other rejection is legal.
      assert.equal(editResult.reason.statusCode, 409);
      assert.equal(editResult.reason.code, 'ARTICLE_CORRECTION_REQUIRED');
      assert.equal(article.headline, 'Scheduled headline', 'a refused edit must not have been applied');
    }

    // The only legal histories are edit→publish (1,2,3) or publish→refused edit
    // (1,2). This asserts both completeness and uniqueness.
    const revisions = await prisma.articleRevision.findMany({
      where: { articleId },
      select: { revisionNumber: true },
      orderBy: { revisionNumber: 'asc' }
    });
    const numbers = revisions.map((revision) => revision.revisionNumber);

    assert.deepEqual(numbers, editResult.status === 'fulfilled' ? [1, 2, 3] : [1, 2]);
  } finally {
    await prisma.editorialArticle.update({ where: { id: articleId }, data: { currentRevisionId: null } });
    await prisma.articleRevision.deleteMany({ where: { articleId } });
    await prisma.editorialArticle.deleteMany({ where: { id: articleId } });
    await prisma.user.deleteMany({ where: { id: editor.id } });
  }
});

test('a hero asset added mid-request cannot be published on a stale rights check', { skip: !enabled }, async () => {
  const { PrismaClient } = require('@prisma/client');
  const { prisma } = require('../../src/config/prisma');
  const articleService = require('../../src/modules/feed/article.service');

  const editor = await createEditor(prisma, 'editor-rights');
  const slug = `rights-article-${uniqueSuffix()}`;
  const { articleId } = await createScheduledArticle(prisma, { editorUserId: editor.id, slug });
  const assetClient = new PrismaClient();
  const observerClient = new PrismaClient();
  let allowAssetInsert = null;
  let assetTransaction = null;

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    return { promise, resolve, reject };
  }

  async function waitForPublishBlockedBy(blockerPid) {
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      const [state] = await observerClient.$queryRaw`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity AS activity
          WHERE activity.datname = current_database()
            AND ${blockerPid}::int = ANY(pg_blocking_pids(activity.pid))
        ) AS blocked
      `;

      if (state?.blocked === true) {
        return;
      }

      // Yield to the two database clients without relying on a timing guess.
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.fail('publish never reached the row lock held by the asset transaction');
  }

  try {
    const lockReady = deferred();
    allowAssetInsert = deferred();
    const assetUrl = `https://cdn.example.invalid/${uniqueSuffix()}.png`;

    // Connection A owns the article row lock. Connection B (the real production
    // service client) is then observed waiting on that exact backend pid. Only
    // after this explicit barrier does A insert the unresolved asset and commit.
    assetTransaction = assetClient.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;

      await tx.$queryRaw`
        SELECT "id" FROM "editorial_articles"
        WHERE "id" = ${articleId}::uuid
        FOR UPDATE
      `;
      lockReady.resolve(Number(backend.pid));
      await allowAssetInsert.promise;

      await tx.articleAsset.create({
        data: {
          articleId,
          kind: 'HERO',
          url: assetUrl,
          rightsStatus: 'USER_SUBMITTED',
          isHero: true
        }
      });
    }, {
      timeout: 15000
    });
    assetTransaction.catch((error) => lockReady.reject(error));

    const blockerPid = await lockReady.promise;
    const publishOutcome = articleService.publishArticle({ actorUserId: editor.id, slug })
      .then((value) => ({ status: 'fulfilled', value }))
      .catch((reason) => ({ status: 'rejected', reason }));

    await waitForPublishBlockedBy(blockerPid);
    allowAssetInsert.resolve();
    await assetTransaction;

    const publishResult = await publishOutcome;

    assert.equal(publishResult.status, 'rejected');
    assert.equal(publishResult.reason?.statusCode, 409);
    assert.equal(publishResult.reason?.code, 'ARTICLE_HERO_RIGHTS_UNRESOLVED');

    const article = await prisma.editorialArticle.findUnique({
      where: { id: articleId },
      select: { status: true, publishedAt: true }
    });

    assert.equal(article.status, 'SCHEDULED', 'the refused publish must not have moved the status');
    assert.equal(article.publishedAt, null);
  } finally {
    // Unblock a failed setup before waiting for or disconnecting its client.
    allowAssetInsert?.resolve();
    if (assetTransaction) {
      await Promise.allSettled([assetTransaction]);
    }
    await Promise.allSettled([assetClient.$disconnect(), observerClient.$disconnect()]);
    await prisma.articleAsset.deleteMany({ where: { articleId } });
    await prisma.editorialArticle.update({ where: { id: articleId }, data: { currentRevisionId: null } });
    await prisma.articleRevision.deleteMany({ where: { articleId } });
    await prisma.editorialArticle.deleteMany({ where: { id: articleId } });
    await prisma.user.deleteMany({ where: { id: editor.id } });
  }
});

// ===========================================================================
// D. Publication contract
// ===========================================================================

test('an empty body cannot be published and a correction cannot be noteless', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const articleService = require('../../src/modules/feed/article.service');

  const editor = await createEditor(prisma, 'editor-contract');
  const emptySlug = `empty-article-${uniqueSuffix()}`;
  const publishedSlug = `published-article-${uniqueSuffix()}`;

  const empty = await createScheduledArticle(prisma, { editorUserId: editor.id, slug: emptySlug, bodyMarkdown: null });
  const publishable = await createScheduledArticle(prisma, { editorUserId: editor.id, slug: publishedSlug });

  try {
    // 1. A null body must not become a public article with bodyMarkdown null.
    await assert.rejects(
      articleService.publishArticle({ actorUserId: editor.id, slug: emptySlug }),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_BODY_REQUIRED_FOR_PUBLICATION'
    );

    const stillScheduled = await prisma.editorialArticle.findUnique({
      where: { id: empty.articleId },
      select: { status: true }
    });

    assert.equal(stillScheduled.status, 'SCHEDULED');

    // 2. A real publish, then the correction rules against the live article.
    await articleService.publishArticle({ actorUserId: editor.id, slug: publishedSlug });

    // A status-only CORRECTED used to write a revision with changeNote null.
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: editor.id,
        slug: publishedSlug,
        input: { status: 'CORRECTED', sources: [], relatedGames: [], assets: [] }
      }),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_CORRECTION_EMPTY'
    );

    // A real content change with no note is refused too.
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: editor.id,
        slug: publishedSlug,
        input: { headline: 'Corrected', status: 'CORRECTED', sources: [], relatedGames: [], assets: [] }
      }),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_CORRECTION_NOTE_REQUIRED'
    );

    // A proper correction succeeds and its revision carries the note.
    await articleService.updateArticle({
      actorUserId: editor.id,
      slug: publishedSlug,
      input: {
        headline: 'Corrected headline',
        status: 'CORRECTED',
        changeNote: 'Fixed the release date',
        sources: [],
        relatedGames: [],
        assets: []
      }
    });

    // Every publicly readable revision in the database must satisfy the contract
    // the OpenAPI document promises.
    const violations = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count
      FROM "editorial_articles" AS article
      JOIN "article_revisions" AS revision ON revision."id" = article."current_revision_id"
      WHERE article."status" IN ('PUBLISHED', 'CORRECTED')
        AND (
          revision."body_markdown" IS NULL
          OR btrim(revision."body_markdown") = ''
          OR (article."status" = 'CORRECTED'
              AND (revision."change_note" IS NULL OR btrim(revision."change_note") = ''))
        )
    `);

    assert.equal(Number(violations[0].count), 0,
      'no publicly readable article may have an empty body or a noteless correction');

    // And the public DTO agrees, rather than degrading to nulls.
    const publicArticle = await articleService.getPublishedArticleBySlug({ slug: publishedSlug });

    assert.equal(publicArticle.status, 'CORRECTED');
    assert.equal(typeof publicArticle.bodyMarkdown, 'string');
    assert.ok(publicArticle.bodyMarkdown.length > 0);
    assert.equal(publicArticle.revision.changeNote, 'Fixed the release date');
    assert.ok(publicArticle.correctedAt);
  } finally {
    for (const articleId of [empty.articleId, publishable.articleId]) {
      await prisma.editorialArticle.update({ where: { id: articleId }, data: { currentRevisionId: null } });
      await prisma.articleRevision.deleteMany({ where: { articleId } });
      await prisma.editorialArticle.deleteMany({ where: { id: articleId } });
    }

    await prisma.user.deleteMany({ where: { id: editor.id } });
  }
});

// ===========================================================================
// E. Markdown rights and privacy
// ===========================================================================

test('a body carrying a remote image is refused at write and at publish', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const articleService = require('../../src/modules/feed/article.service');
  const { createArticleSchema } = require('../../src/modules/feed/feed.validator');

  const editor = await createEditor(prisma, 'editor-markdown');
  const slug = `markdown-article-${uniqueSuffix()}`;
  const trackingUrl = 'https://tracker.example.invalid/pixel.gif';

  // The write boundary refuses every image form, so none of these reach the table.
  for (const body of [
    `Intro\n\n![tracking pixel](${trackingUrl})\n`,
    `Intro\n\n![pixel][ref]\n\n[ref]: ${trackingUrl}\n`,
    'Intro\n\n![inline](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)\n',
    `Intro\n\n<img src="${trackingUrl}">\n`
  ]) {
    const parsed = createArticleSchema.safeParse({
      slug,
      locale: 'ko',
      headline: 'H',
      excerpt: 'E',
      bodyMarkdown: body
    });

    assert.equal(parsed.success, false, `the write boundary must refuse: ${body.slice(0, 40)}`);
  }

  // A body that predates the rule, written directly to the table, must still not be
  // publishable: publish re-validates the stored body.
  const { articleId } = await createScheduledArticle(prisma, {
    editorUserId: editor.id,
    slug,
    bodyMarkdown: `Legacy intro\n\n![tracking pixel](${trackingUrl})\n`
  });

  try {
    const rejection = await articleService.publishArticle({ actorUserId: editor.id, slug })
      .then(() => null, (caught) => caught);

    assert.ok(rejection, 'a stored unsafe body must not be publishable');
    assert.equal(rejection.statusCode, 409);
    assert.equal(rejection.code, 'ARTICLE_MARKDOWN_RESOURCE_NOT_ALLOWED');

    // The refusal must not echo the destination back to the caller: a rejection
    // that repeats the tracking URL hands it to every log and error reporter.
    const serialized = JSON.stringify(rejection.details ?? rejection.message ?? '');

    assert.equal(serialized.includes('tracker.example.invalid'), false,
      'the rejection must carry reason codes only, never the destination');
    assert.match(serialized, /markdown_image_not_allowed/);

    const article = await prisma.editorialArticle.findUnique({
      where: { id: articleId },
      select: { status: true }
    });

    assert.equal(article.status, 'SCHEDULED');
  } finally {
    await prisma.editorialArticle.update({ where: { id: articleId }, data: { currentRevisionId: null } });
    await prisma.articleRevision.deleteMany({ where: { articleId } });
    await prisma.editorialArticle.deleteMany({ where: { id: articleId } });
    await prisma.user.deleteMany({ where: { id: editor.id } });
  }
});

// ===========================================================================
// F. Unicode code-point storage semantics
// ===========================================================================

test('JavaScript truncation and PostgreSQL varchar(300) agree on every corpus title', { skip: !enabled }, async () => {
  const { prisma } = require('../../src/config/prisma');
  const { normalizeTitle, clampTitle } = require('../../src/modules/catalog/catalog-title.util');
  const { countCodePoints, hasUnpairedSurrogate } = require('../../src/utils/unicode-text');

  // The supported corpus. Astral characters are the whole point: '𠮷' is one code
  // point but two UTF-16 units, which is where the JS and SQL length rules diverged.
  const corpus = [
    { label: 'astral tail past the limit', value: `a${'\u{20BB7}'.repeat(200)}` },
    { label: 'exactly 300 astral code points', value: '\u{20BB7}'.repeat(300) },
    { label: '301 astral code points', value: '\u{20BB7}'.repeat(301) },
    { label: 'BMP and astral mixed', value: `${'가'.repeat(150)}${'\u{1F600}'.repeat(160)}` },
    { label: 'combining mark at the boundary', value: `${'e'.repeat(299)}é${'x'.repeat(20)}` },
    { label: 'astral pair straddling the boundary', value: `${'x'.repeat(299)}\u{20BB7}${'y'.repeat(10)}` },
    { label: 'plain ASCII over the limit', value: 'a'.repeat(400) }
  ];

  const created = [];

  try {
    for (const { label, value } of corpus) {
      const clamped = clampTitle(value);
      const normalized = normalizeTitle(value);

      // 1. Never more than the column holds, and never a broken pair.
      assert.ok(countCodePoints(clamped) <= 300, `${label}: clampTitle must not exceed 300 code points`);
      assert.ok(countCodePoints(normalized) <= 300, `${label}: normalizeTitle must not exceed 300 code points`);
      assert.equal(hasUnpairedSurrogate(clamped), false, `${label}: clampTitle must not split a surrogate pair`);
      assert.equal(hasUnpairedSurrogate(normalized), false,
        `${label}: normalizeTitle must not split a surrogate pair`);

      // 2. The clamped value must actually store in varchar(300).
      const game = await prisma.catalogGame.create({
        data: {
          originalTitle: clamped,
          normalizedTitle: normalized,
          genres: [],
          steamTags: [],
          platforms: [],
          publicationStatus: 'PENDING_REVIEW',
          titleProvenance: 'UNKNOWN'
        },
        select: { id: true, originalTitle: true }
      });
      created.push(game.id);

      assert.equal(game.originalTitle, clamped, `${label}: PostgreSQL must round-trip the clamped title`);

      // 3. PostgreSQL's own character count must match JavaScript's code-point count,
      //    which is the parity the finding was about.
      const [{ pg_length: pgLength, pg_left_matches: pgLeftMatches }] = await prisma.$queryRaw`
        SELECT char_length("original_title")::int AS pg_length,
               (left(${value}, 300) = ${clampTitle(value)}) AS pg_left_matches
        FROM "catalog_games" WHERE "id" = ${game.id}::uuid
      `;

      assert.equal(Number(pgLength), countCodePoints(clamped),
        `${label}: char_length must equal the JavaScript code-point count`);
      // clampTitle is trimmed, so only compare where trimming changes nothing.
      if (value === value.trim()) {
        assert.equal(pgLeftMatches, true,
          `${label}: left(value, 300) must equal clampTitle(value)`);
      }
    }
  } finally {
    await prisma.catalogGame.deleteMany({ where: { id: { in: created } } });
  }
});
