#!/usr/bin/env node
//
// Idempotent development fixture for Product 2.2.
//
// Refuses to run outside development and test. There is no automatic seeding
// anywhere in the server bootstrap: this script must be invoked explicitly, so a
// production database can never be seeded as a side effect of a deploy.
//
// Every row is keyed and upserted, so running the script twice leaves the same
// data. All content is obviously synthetic: no real released game's article text
// is reproduced, and the editorial fixture is a placeholder about the fixture
// itself rather than invented reporting about a real release.
//
//   NODE_ENV=development node scripts/seed/product-2-2-dev-seed.js

const { env } = require('../../src/config/env');
const { prisma } = require('../../src/config/prisma');
const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');
const { clampTitle, normalizeTitle } = require('../../src/modules/catalog/catalog-title.util');

const ALLOWED_ENVIRONMENTS = new Set(['development', 'test']);

// Deterministic ids so re-running the script updates rather than duplicates.
const FIXTURE_GAMES = [
  {
    id: '00000000-0000-4000-8000-00000000f101',
    originalTitle: 'Fixture Quest',
    slug: 'fixture-quest',
    developerName: 'Fixture Studio',
    publisherName: 'Fixture Publishing',
    genres: ['rpg', 'adventure'],
    steamTags: ['story rich', 'singleplayer'],
    platforms: ['STEAM', 'PC'],
    supportsSinglePlayer: true,
    supportsMultiplayer: false,
    typicalSessionMinutes: 120,
    identities: [{ provider: 'STEAM', externalId: '9000001', regionKey: 'GLOBAL' }],
    localizations: [
      { kind: 'ORIGINAL_TITLE', languageCode: 'en', regionCode: 'GLOBAL', title: 'Fixture Quest' },
      { kind: 'REGIONAL_TITLE', languageCode: 'ko', regionCode: 'KR', title: '픽스처 퀘스트' },
      { kind: 'ALIAS', languageCode: 'en', regionCode: 'GLOBAL', title: 'FQ' }
    ],
    regionalReleases: [
      {
        countryCode: 'KR',
        languageCode: 'ko',
        platform: 'PC',
        operatorName: 'Fixture Korea',
        serverRegion: 'kr-1',
        releaseDate: '2026-03-01',
        shutdownDate: null,
        serviceStatus: 'LIVE'
      },
      {
        countryCode: 'JP',
        languageCode: 'ja',
        platform: 'PC',
        operatorName: 'Fixture Japan',
        serverRegion: 'jp-1',
        releaseDate: '2026-04-01',
        shutdownDate: '2026-12-31',
        serviceStatus: 'SUNSET_ANNOUNCED'
      }
    ]
  },
  {
    id: '00000000-0000-4000-8000-00000000f102',
    originalTitle: 'Fixture Puzzler',
    slug: 'fixture-puzzler',
    developerName: 'Fixture Studio',
    publisherName: null,
    genres: ['puzzle', 'casual'],
    steamTags: ['casual', 'relaxing'],
    platforms: ['STEAM'],
    supportsSinglePlayer: true,
    supportsMultiplayer: false,
    typicalSessionMinutes: 25,
    identities: [{ provider: 'STEAM', externalId: '9000002', regionKey: 'GLOBAL' }],
    localizations: [{ kind: 'ORIGINAL_TITLE', languageCode: 'en', regionCode: 'GLOBAL', title: 'Fixture Puzzler' }],
    regionalReleases: []
  },
  {
    id: '00000000-0000-4000-8000-00000000f103',
    originalTitle: 'Fixture Arena',
    slug: 'fixture-arena',
    developerName: 'Fixture Multiplayer Labs',
    publisherName: null,
    genres: ['shooter', 'multiplayer'],
    steamTags: ['pvp', 'co-op'],
    platforms: ['STEAM', 'PC'],
    supportsSinglePlayer: false,
    supportsMultiplayer: true,
    typicalSessionMinutes: 40,
    identities: [
      { provider: 'STEAM', externalId: '9000003', regionKey: 'GLOBAL' },
      { provider: 'GOOGLE_PLAY', externalId: 'test.fixture.arena', regionKey: 'GLOBAL' }
    ],
    localizations: [{ kind: 'ORIGINAL_TITLE', languageCode: 'en', regionCode: 'GLOBAL', title: 'Fixture Arena' }],
    regionalReleases: []
  }
];

const FIXTURE_ARTICLE = {
  slug: 'fixture-development-notice',
  locale: 'ko',
  headline: 'Development fixture article',
  excerpt: 'A synthetic placeholder used only by the local Product 2.2 development fixture. It is not reporting about any real game.',
  bodyMarkdown: [
    '# Development fixture',
    '',
    'This article exists so the Today feed and the magazine reader have something',
    'to render locally. It deliberately contains no claims about any real release.'
  ].join('\n')
};

function toDate(value) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

async function seedCatalogGames() {
  let created = 0;
  let updated = 0;

  for (const fixture of FIXTURE_GAMES) {
    const existing = await prisma.catalogGame.findUnique({ where: { id: fixture.id }, select: { id: true } });
    const originalTitle = clampTitle(fixture.originalTitle);

    await prisma.catalogGame.upsert({
      where: { id: fixture.id },
      create: {
        id: fixture.id,
        originalTitle,
        normalizedTitle: normalizeTitle(originalTitle),
        slug: fixture.slug,
        developerName: fixture.developerName,
        publisherName: fixture.publisherName,
        genres: fixture.genres,
        steamTags: fixture.steamTags,
        platforms: fixture.platforms,
        supportsSinglePlayer: fixture.supportsSinglePlayer,
        supportsMultiplayer: fixture.supportsMultiplayer,
        typicalSessionMinutes: fixture.typicalSessionMinutes,
        publicationStatus: 'PUBLISHED',
        // These are synthetic titles deliberately asserted by this local fixture,
        // not facts verified against Steam, Google Play or another provider.
        titleProvenance: 'EDITOR_VERIFIED'
      },
      update: {
        originalTitle,
        normalizedTitle: normalizeTitle(originalTitle),
        slug: fixture.slug,
        developerName: fixture.developerName,
        publisherName: fixture.publisherName,
        genres: fixture.genres,
        steamTags: fixture.steamTags,
        platforms: fixture.platforms,
        supportsSinglePlayer: fixture.supportsSinglePlayer,
        supportsMultiplayer: fixture.supportsMultiplayer,
        typicalSessionMinutes: fixture.typicalSessionMinutes,
        publicationStatus: 'PUBLISHED',
        titleProvenance: 'EDITOR_VERIFIED'
      },
      select: { id: true }
    });

    if (existing) {
      updated += 1;
    } else {
      created += 1;
    }

    for (const identity of fixture.identities) {
      // A made-up development provider id proves no provider relationship. Keep
      // it in the non-global claim/review flow so it cannot occupy a verified key.
      await catalogIdentityService.recordIdentityClaim({
        client: prisma,
        catalogGameId: fixture.id,
        provider: identity.provider,
        externalId: identity.externalId,
        regionKey: identity.regionKey,
        provenance: 'UNKNOWN',
        claimSource: 'development_fixture_unverified'
      });
    }

    for (const localization of fixture.localizations) {
      const title = clampTitle(localization.title);

      await prisma.gameLocalization.upsert({
        where: {
          catalogGameId_kind_languageCode_regionCode_normalizedTitle: {
            catalogGameId: fixture.id,
            kind: localization.kind,
            languageCode: localization.languageCode,
            regionCode: localization.regionCode,
            normalizedTitle: normalizeTitle(title)
          }
        },
        create: {
          catalogGameId: fixture.id,
          kind: localization.kind,
          languageCode: localization.languageCode,
          regionCode: localization.regionCode,
          title,
          normalizedTitle: normalizeTitle(title),
          provenance: 'EDITOR_VERIFIED'
        },
        update: { title, provenance: 'EDITOR_VERIFIED' },
        select: { id: true }
      });
    }

    for (const release of fixture.regionalReleases) {
      await prisma.regionalRelease.upsert({
        where: {
          catalogGameId_countryCode_languageCode_platform: {
            catalogGameId: fixture.id,
            countryCode: release.countryCode,
            languageCode: release.languageCode,
            platform: release.platform
          }
        },
        create: {
          catalogGameId: fixture.id,
          countryCode: release.countryCode,
          languageCode: release.languageCode,
          platform: release.platform,
          operatorName: release.operatorName,
          serverRegion: release.serverRegion,
          releaseDate: toDate(release.releaseDate),
          shutdownDate: toDate(release.shutdownDate),
          serviceStatus: release.serviceStatus,
          provenance: 'UNKNOWN'
        },
        update: {
          operatorName: release.operatorName,
          serverRegion: release.serverRegion,
          releaseDate: toDate(release.releaseDate),
          shutdownDate: toDate(release.shutdownDate),
          serviceStatus: release.serviceStatus
        },
        select: { id: true }
      });
    }
  }

  return { created, updated };
}

async function seedEditorialArticle() {
  const article = await prisma.editorialArticle.upsert({
    where: { slug: FIXTURE_ARTICLE.slug },
    create: {
      slug: FIXTURE_ARTICLE.slug,
      // A fixture article stays in DRAFT: publishing is an editor decision that
      // requires a database role, and a seed script must not simulate one.
      status: 'DRAFT',
      locale: FIXTURE_ARTICLE.locale,
      headline: FIXTURE_ARTICLE.headline,
      excerpt: FIXTURE_ARTICLE.excerpt,
      aiDraftUsed: false
    },
    update: {
      headline: FIXTURE_ARTICLE.headline,
      excerpt: FIXTURE_ARTICLE.excerpt
    },
    select: { id: true }
  });

  const revision = await prisma.articleRevision.upsert({
    where: { articleId_revisionNumber: { articleId: article.id, revisionNumber: 1 } },
    create: {
      articleId: article.id,
      revisionNumber: 1,
      status: 'DRAFT',
      headline: FIXTURE_ARTICLE.headline,
      excerpt: FIXTURE_ARTICLE.excerpt,
      bodyMarkdown: FIXTURE_ARTICLE.bodyMarkdown,
      changeNote: 'development fixture',
      aiDraft: false
    },
    update: {
      status: 'DRAFT',
      headline: FIXTURE_ARTICLE.headline,
      excerpt: FIXTURE_ARTICLE.excerpt,
      bodyMarkdown: FIXTURE_ARTICLE.bodyMarkdown,
      changeNote: 'development fixture',
      aiDraft: false
    },
    select: { id: true }
  });

  // Creating or reusing a revision is not enough: the public/editor DTO reads the
  // body through currentRevisionId, so keep the pointer exact on every run.
  await prisma.editorialArticle.update({
    where: { id: article.id },
    data: {
      currentRevisionId: revision.id,
      status: 'DRAFT',
      locale: FIXTURE_ARTICLE.locale,
      headline: FIXTURE_ARTICLE.headline,
      excerpt: FIXTURE_ARTICLE.excerpt
    },
    select: { id: true }
  });

  await prisma.articleGameLink.upsert({
    where: { articleId_catalogGameId: { articleId: article.id, catalogGameId: FIXTURE_GAMES[0].id } },
    create: { articleId: article.id, catalogGameId: FIXTURE_GAMES[0].id, relation: 'SUBJECT' },
    update: { relation: 'SUBJECT' },
    select: { id: true }
  });

  return { articleId: article.id };
}

async function main() {
  if (!ALLOWED_ENVIRONMENTS.has(env.nodeEnv)) {
    throw new Error(
      `The Product 2.2 development seed refuses to run when NODE_ENV=${env.nodeEnv} (allowed: development, test)`
    );
  }

  const catalogResult = await seedCatalogGames();
  const articleResult = await seedEditorialArticle();

  process.stdout.write([
    'Product 2.2 development fixture applied (idempotent).',
    `  catalog games created: ${catalogResult.created}`,
    `  catalog games updated: ${catalogResult.updated}`,
    `  editorial fixture article: ${FIXTURE_ARTICLE.slug} (DRAFT)`,
    `  article id: ${articleResult.articleId}`,
    ''
  ].join('\n'));
}

if (require.main === module) {
  main()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (error) => {
      process.stderr.write(`Product 2.2 development seed failed: ${error.message}\n`);
      await prisma.$disconnect();
      process.exitCode = 1;
    });
}

module.exports = {
  ALLOWED_ENVIRONMENTS,
  FIXTURE_ARTICLE,
  FIXTURE_GAMES,
  clampTitle,
  normalizeTitle
};
