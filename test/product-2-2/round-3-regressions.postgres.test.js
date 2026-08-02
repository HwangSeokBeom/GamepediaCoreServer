const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Round-3 regression proofs that require the real PostgreSQL storage semantics.
// The disposable database and RUN_POSTGRES_INTEGRATION flag are supplied by
// scripts/test/run-product-2-2-postgres-gate.sh.

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';

function uniqueSuffix() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function createUser(prisma, label) {
  const suffix = uniqueSuffix();

  return prisma.user.create({
    data: {
      email: `r3-${label}-${suffix}@example.invalid`,
      nickname: `r3-${label}-${suffix}`.slice(0, 50),
      passwordHash: 'integration-test-not-a-real-password-hash'
    }
  });
}

async function createEditor(prisma, label) {
  const user = await createUser(prisma, label);

  await prisma.userRoleAssignment.create({ data: { userId: user.id, role: 'EDITOR' } });

  return user;
}

async function createPublicGame(prisma, label) {
  const suffix = uniqueSuffix();
  const title = `${label} ${suffix}`;

  return prisma.catalogGame.create({
    data: {
      originalTitle: title,
      normalizedTitle: title.toLocaleLowerCase('und'),
      genres: [],
      steamTags: [],
      platforms: [],
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'EDITOR_VERIFIED'
    },
    select: { id: true }
  });
}

function expectAppError({ statusCode, code }) {
  return (error) => {
    assert.equal(error?.statusCode, statusCode);
    assert.equal(error?.code, code);
    return true;
  };
}

function parseOrThrow(schema, input, buildError) {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw buildError(parsed.error);
  }

  return parsed.data;
}

test('CORRECTED compares the canonical public representation under the article lock',
  { skip: !enabled }, async (t) => {
    const { prisma } = require('../../src/config/prisma');
    const articleService = require('../../src/modules/feed/article.service');
    const { updateArticleSchema } = require('../../src/modules/feed/feed.validator');

    const editor = await createEditor(prisma, 'canonical-correction');
    const games = [
      await createPublicGame(prisma, 'Canonical Game A'),
      await createPublicGame(prisma, 'Canonical Game B')
    ];
    const slug = `canonical-correction-${uniqueSuffix()}`;
    const sourceA = {
      sourceType: 'OFFICIAL_SITE',
      publisherKey: 'publisher-a',
      headline: 'Source A',
      excerpt: 'Excerpt A',
      sourceUrl: 'https://example.invalid/source-a',
      publishedAt: '2026-07-20T00:00:00.000Z',
      fetchedAt: '2026-07-21T00:00:00.000Z',
      contentHash: 'a'.repeat(64)
    };
    const sourceB = {
      sourceType: 'STEAM_NEWS',
      publisherKey: 'publisher-b',
      headline: 'Source B',
      excerpt: null,
      sourceUrl: 'https://example.invalid/source-b',
      publishedAt: null,
      fetchedAt: '2026-07-22T00:00:00.000Z',
      contentHash: 'b'.repeat(64)
    };
    const assetA = {
      kind: 'HERO',
      url: 'https://example.invalid/hero.png',
      rightsStatus: 'CLEARED',
      attribution: 'Studio A',
      isHero: true
    };
    const assetB = {
      kind: 'SCREENSHOT',
      url: 'https://example.invalid/screenshot.png',
      rightsStatus: 'OFFICIAL_PRESS_KIT',
      attribution: null,
      isHero: false
    };

    const article = await prisma.editorialArticle.create({
      data: {
        slug,
        status: 'PUBLISHED',
        locale: 'ko',
        headline: 'Original headline',
        excerpt: 'Original excerpt',
        authorUserId: editor.id,
        publishedAt: new Date('2026-07-23T00:00:00.000Z')
      },
      select: { id: true }
    });

    const revision = await prisma.articleRevision.create({
      data: {
        articleId: article.id,
        revisionNumber: 1,
        status: 'PUBLISHED',
        headline: 'Original headline',
        excerpt: 'Original excerpt',
        bodyMarkdown: '# Body\n\nVisible text',
        changeNote: 'published',
        editorUserId: editor.id
      },
      select: { id: true }
    });

    await prisma.editorialArticle.update({
      where: { id: article.id },
      data: { currentRevisionId: revision.id }
    });

    await prisma.articleSource.createMany({
      data: [sourceA, sourceB].map((source) => ({
        articleId: article.id,
        ...source,
        publishedAt: source.publishedAt ? new Date(source.publishedAt) : null,
        fetchedAt: new Date(source.fetchedAt)
      }))
    });
    await prisma.articleGameLink.createMany({
      data: [
        { articleId: article.id, catalogGameId: games[0].id, relation: 'SUBJECT' },
        { articleId: article.id, catalogGameId: games[1].id, relation: 'RELATED' }
      ]
    });
    await prisma.articleAsset.createMany({
      data: [assetA, assetB].map((asset) => ({ articleId: article.id, ...asset }))
    });

    async function assertNoWriteAfterEmptyCorrection(input) {
      const before = await prisma.articleRevision.count({ where: { articleId: article.id } });

      await assert.rejects(
        articleService.updateArticle({
          actorUserId: editor.id,
          slug,
          input: updateArticleSchema.parse(input),
          now: new Date('2026-07-24T00:00:00.000Z')
        }),
        expectAppError({ statusCode: 409, code: 'ARTICLE_CORRECTION_EMPTY' })
      );

      const stored = await prisma.editorialArticle.findUnique({
        where: { id: article.id },
        select: { status: true, correctedAt: true, currentRevisionId: true }
      });

      assert.equal(await prisma.articleRevision.count({ where: { articleId: article.id } }), before);
      assert.equal(stored.status, 'PUBLISHED');
      assert.equal(stored.correctedAt, null);
      assert.equal(stored.currentRevisionId, revision.id);
    }

    try {
      await t.test('same scalar values are an empty correction', async () => {
        await assertNoWriteAfterEmptyCorrection({
          headline: '  Original headline  ',
          excerpt: ' Original excerpt ',
          locale: 'ko',
          status: 'CORRECTED',
          changeNote: 'No semantic change'
        });
      });

      await t.test('body that is equal after contract trimming is an empty correction', async () => {
        await assertNoWriteAfterEmptyCorrection({
          bodyMarkdown: '  # Body\n\nVisible text  ',
          status: 'CORRECTED',
          changeNote: 'Whitespace only'
        });
      });

      await t.test('relation upserts ignore order and duplicate requests with the same final meaning', async () => {
        await assertNoWriteAfterEmptyCorrection({
          status: 'CORRECTED',
          changeNote: 'Relations reordered only',
          sources: [sourceB, sourceA, sourceB],
          relatedGames: [
            { catalogGameId: games[1].id, relation: 'RELATED' },
            { catalogGameId: games[0].id, relation: 'SUBJECT' },
            { catalogGameId: games[1].id, relation: 'RELATED' }
          ],
          assets: [assetB, assetA, assetB]
        });
      });

      await t.test('a real public delta still requires CORRECTED and then records one revision', async () => {
        await assert.rejects(
          articleService.updateArticle({
            actorUserId: editor.id,
            slug,
            input: updateArticleSchema.parse({ headline: 'Actually changed' })
          }),
          expectAppError({ statusCode: 409, code: 'ARTICLE_CORRECTION_REQUIRED' })
        );

        assert.equal(await prisma.articleRevision.count({ where: { articleId: article.id } }), 1);

        const corrected = await articleService.updateArticle({
          actorUserId: editor.id,
          slug,
          input: updateArticleSchema.parse({
            headline: 'Actually changed',
            status: 'CORRECTED',
            changeNote: 'Corrected a factual headline'
          }),
          now: new Date('2026-07-25T00:00:00.000Z')
        });

        assert.equal(corrected.status, 'CORRECTED');
        assert.equal(corrected.headline, 'Actually changed');
        assert.equal(corrected.correctedAt, '2026-07-25T00:00:00.000Z');
        assert.equal(await prisma.articleRevision.count({ where: { articleId: article.id } }), 2);
      });
    } finally {
      await prisma.editorialArticle.update({
        where: { id: article.id },
        data: { currentRevisionId: null }
      });
      await prisma.articleRevision.deleteMany({ where: { articleId: article.id } });
      await prisma.editorialArticle.deleteMany({ where: { id: article.id } });
      await prisma.catalogGame.deleteMany({ where: { id: { in: games.map((game) => game.id) } } });
      await prisma.user.deleteMany({ where: { id: editor.id } });
    }
  });

test('unpaired surrogates are rejected before persisted text reaches PostgreSQL',
  { skip: !enabled }, async (t) => {
    const { prisma } = require('../../src/config/prisma');
    const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');
    const playlogService = require('../../src/modules/play/playlog.service');
    const {
      buildPlayValidationError,
      createPlaySessionSchema
    } = require('../../src/modules/play/play.validator');

    const user = await createUser(prisma, 'unicode');
    const game = await createPublicGame(prisma, 'Unicode Game');
    const invalidCases = [
      { label: 'lone high surrogate', note: 'prefix\uD800suffix' },
      { label: 'lone low surrogate', note: 'prefix\uDFFFsuffix' },
      { label: 'astral character mixed with a lone surrogate', note: '정상😀\uD800혼합' }
    ];

    try {
      for (const [index, sample] of invalidCases.entries()) {
        await t.test(sample.label, async () => {
          const before = await prisma.playSession.count({ where: { userId: user.id } });

          assert.throws(
            () => parseOrThrow(createPlaySessionSchema, {
              catalogGameId: game.id,
              playedAt: '2026-07-26T00:00:00.000Z',
              note: sample.note,
              outcome: 'CONTINUE',
              clientMutationId: `unicode-invalid-${index}`
            }, buildPlayValidationError),
            expectAppError({ statusCode: 400, code: 'INVALID_UNICODE_TEXT' })
          );

          assert.equal(await prisma.playSession.count({ where: { userId: user.id } }), before);
        });
      }

      await t.test('the catalog service rejects malformed provider text before opening its write transaction',
        async () => {
          const externalId = `unicode-service-${uniqueSuffix()}`;
          const title = `Malformed \uD800 title ${uniqueSuffix()}`;
          const gamesBefore = await prisma.catalogGame.count();

          await assert.rejects(
            catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
              provider: 'STEAM',
              externalId,
              title,
              publicationStatus: 'PUBLISHED',
              titleProvenance: 'PROVIDER_VERIFIED',
              identityProvenance: 'PROVIDER_VERIFIED',
              verificationSource: 'steam_owned_games_sync',
              platforms: ['STEAM'],
              verifiedAt: new Date('2026-07-26T00:00:00.000Z')
            }),
            expectAppError({ statusCode: 400, code: 'INVALID_UNICODE_TEXT' })
          );

          // Never pass the malformed value to a database driver merely to prove
          // it was rejected. The safe total count plus the provider key prove no
          // part of the service transaction reached storage.
          assert.equal(await prisma.catalogGame.count(), gamesBefore);
          assert.equal(await prisma.gameExternalIdentity.count({
            where: { provider: 'STEAM', externalId }
          }), 0);
        });

      await t.test('a valid astral character round-trips without replacement', async () => {
        const note = '정상 astral 😀 𠮷';
        const input = parseOrThrow(createPlaySessionSchema, {
          catalogGameId: game.id,
          playedAt: '2026-07-26T00:00:00.000Z',
          note,
          outcome: 'CONTINUE',
          clientMutationId: `unicode-valid-${uniqueSuffix()}`
        }, buildPlayValidationError);

        const { session } = await playlogService.createPlaySession({ userId: user.id, input });
        const stored = await prisma.playSession.findUnique({
          where: { id: session.id },
          select: { note: true }
        });

        assert.equal(stored.note, note);
        assert.equal(stored.note.includes('\uFFFD'), false);
      });
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
      await prisma.catalogGame.deleteMany({ where: { id: game.id } });
    }
  });
