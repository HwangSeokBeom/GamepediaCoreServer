const test = require('node:test');
const assert = require('node:assert/strict');

// This file is run only in Phase B of the PostgreSQL gate:
//   33 legacy migrations -> pre-2.2 fixture -> 6 real Product 2.2 migrations.
// It therefore proves the upgraded-database path rather than reconstructing a
// post-migration lookalike row.

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';
const LEGACY_STEAM_LIBRARY_ID = '00000000-0000-4000-8000-00000000b003';

test('a migrated unverified Steam identity cannot capture the next real victim sync',
  { skip: !enabled }, async () => {
    const { prisma } = require('../../src/config/prisma');
    const catalogDualWriteService = require('../../src/modules/catalog/catalog-dual-write.service');

    const [{ count: migrationCount }] = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM "_prisma_migrations"
      WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
    `;

    assert.equal(Number(migrationCount), 39,
      'the scenario must run after all 33 legacy and 6 Product 2.2 migrations');

    const legacyLibraryRow = await prisma.userGameLibrary.findUnique({
      where: { id: LEGACY_STEAM_LIBRARY_ID },
      select: {
        id: true,
        catalogGameId: true,
        ownershipProvenance: true,
        externalGameId: true
      }
    });

    assert.ok(legacyLibraryRow);
    assert.equal(legacyLibraryRow.externalGameId, '620');
    assert.ok(legacyLibraryRow.catalogGameId);
    assert.equal(legacyLibraryRow.ownershipProvenance, 'UNKNOWN');

    const legacyClaim = await prisma.gameIdentityClaim.findFirst({
      where: { provider: 'STEAM', externalId: '620', regionKey: 'GLOBAL' },
      select: {
        id: true,
        catalogGameId: true,
        provenance: true,
        claimSource: true
      }
    });

    assert.ok(legacyClaim, 'the actual migration must preserve the legacy key as a claim');
    assert.equal(legacyClaim.catalogGameId, legacyLibraryRow.catalogGameId);
    assert.equal(legacyClaim.provenance, 'UNKNOWN');
    assert.equal(legacyClaim.claimSource, 'legacy_backfill_unverified');
    assert.equal(await prisma.gameExternalIdentity.count({
      where: { provider: 'STEAM', externalId: '620', regionKey: 'GLOBAL' }
    }), 0, 'the pre-2.2 row must not remain in the verified-only identity table');

    const legacyGameBefore = await prisma.catalogGame.findUnique({
      where: { id: legacyClaim.catalogGameId },
      select: {
        originalTitle: true,
        publicationStatus: true,
        titleProvenance: true,
        mergedIntoCatalogGameId: true
      }
    });
    let verifiedCatalogGameId = null;

    try {
      // This is the same trusted service boundary used after a real Steam
      // owned-games response, including the library-row linkage transaction.
      const result = await catalogDualWriteService.linkVerifiedSteamOwnership({
        entries: [{
          libraryEntryId: legacyLibraryRow.id,
          externalGameId: '620',
          gameName: 'Provider Verified Portal 2'
        }],
        now: new Date('2026-07-30T00:00:00.000Z')
      });

      assert.deepEqual(result, {
        canonicalLinkStatus: 'linked',
        canonicalLinkedCount: 1,
        canonicalPendingCount: 0,
        canonicalFailureReasonCodes: []
      });

      const linked = await prisma.userGameLibrary.findUnique({
        where: { id: legacyLibraryRow.id },
        select: { catalogGameId: true, ownershipProvenance: true }
      });

      verifiedCatalogGameId = linked.catalogGameId;
      assert.ok(verifiedCatalogGameId);
      assert.notEqual(verifiedCatalogGameId, legacyClaim.catalogGameId,
        'a verified sync must not adopt the game selected by an unverified legacy row');
      assert.equal(linked.ownershipProvenance, 'PROVIDER_VERIFIED');

      const identity = await prisma.gameExternalIdentity.findUnique({
        where: {
          provider_externalId_regionKey: {
            provider: 'STEAM',
            externalId: '620',
            regionKey: 'GLOBAL'
          }
        },
        select: {
          catalogGameId: true,
          provenance: true,
          verificationSource: true,
          verifiedAt: true
        }
      });

      assert.equal(identity.catalogGameId, verifiedCatalogGameId);
      assert.equal(identity.provenance, 'PROVIDER_VERIFIED');
      assert.equal(identity.verificationSource, 'steam_owned_games_sync');
      assert.equal(identity.verifiedAt.toISOString(), '2026-07-30T00:00:00.000Z');

      const verifiedGame = await prisma.catalogGame.findUnique({
        where: { id: verifiedCatalogGameId },
        select: {
          originalTitle: true,
          publicationStatus: true,
          titleProvenance: true,
          createdByUserId: true
        }
      });

      assert.deepEqual(verifiedGame, {
        originalTitle: 'Provider Verified Portal 2',
        publicationStatus: 'PUBLISHED',
        titleProvenance: 'PROVIDER_VERIFIED',
        createdByUserId: null
      });

      assert.deepEqual(
        await prisma.catalogGame.findUnique({
          where: { id: legacyClaim.catalogGameId },
          select: {
            originalTitle: true,
            publicationStatus: true,
            titleProvenance: true,
            mergedIntoCatalogGameId: true
          }
        }),
        legacyGameBefore,
        'the migrated unverified game must not be renamed, published or merged'
      );

      assert.deepEqual(
        await prisma.gameIdentityClaim.findUnique({
          where: { id: legacyClaim.id },
          select: {
            catalogGameId: true,
            provenance: true,
            claimSource: true
          }
        }),
        {
          catalogGameId: legacyClaim.catalogGameId,
          provenance: 'UNKNOWN',
          claimSource: 'legacy_backfill_unverified'
        },
        'the historical claim must remain an honest claim after the verified sync'
      );
    } finally {
      // Restore the legacy fixture so the gate can re-run its migration/backfill
      // assertions after this live sync proof.
      await prisma.userGameLibrary.update({
        where: { id: legacyLibraryRow.id },
        data: {
          catalogGameId: legacyLibraryRow.catalogGameId,
          ownershipProvenance: legacyLibraryRow.ownershipProvenance
        }
      });

      if (verifiedCatalogGameId && verifiedCatalogGameId !== legacyLibraryRow.catalogGameId) {
        await prisma.gameExternalIdentity.deleteMany({
          where: { catalogGameId: verifiedCatalogGameId }
        });
        await prisma.gameLocalization.deleteMany({
          where: { catalogGameId: verifiedCatalogGameId }
        });
        await prisma.catalogGame.deleteMany({
          where: { id: verifiedCatalogGameId }
        });
      }
    }
  });
