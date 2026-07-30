#!/usr/bin/env node

const assert = require('node:assert/strict');
const { prisma } = require('../../src/config/prisma');
const {
  FIXTURE_ARTICLE,
  FIXTURE_GAMES,
  normalizeTitle
} = require('../seed/product-2-2-dev-seed');

function sorted(values) {
  return [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function main() {
  const gameIds = FIXTURE_GAMES.map((fixture) => fixture.id);
  const games = await prisma.catalogGame.findMany({
    where: { id: { in: gameIds } },
    select: {
      id: true,
      originalTitle: true,
      normalizedTitle: true,
      publicationStatus: true,
      titleProvenance: true
    },
    orderBy: { id: 'asc' }
  });

  assert.equal(games.length, FIXTURE_GAMES.length, 'every fixture game must exist exactly once');

  for (const fixture of FIXTURE_GAMES) {
    const game = games.find((row) => row.id === fixture.id);

    assert.ok(game, `missing fixture game ${fixture.id}`);
    assert.equal(game.originalTitle, fixture.originalTitle);
    assert.equal(game.normalizedTitle, normalizeTitle(fixture.originalTitle));
    assert.equal(game.publicationStatus, 'PUBLISHED');
    assert.equal(game.titleProvenance, 'EDITOR_VERIFIED');
  }

  const verifiedIdentityCount = await prisma.gameExternalIdentity.count({
    where: { catalogGameId: { in: gameIds } }
  });

  assert.equal(verifiedIdentityCount, 0,
    'development provider identifiers must never occupy the verified-only identity table');

  const claims = await prisma.gameIdentityClaim.findMany({
    where: { catalogGameId: { in: gameIds } },
    select: {
      id: true,
      catalogGameId: true,
      provider: true,
      externalId: true,
      regionKey: true,
      provenance: true,
      claimSource: true
    }
  });
  const expectedClaims = FIXTURE_GAMES.flatMap((fixture) => fixture.identities.map((identity) => ({
    catalogGameId: fixture.id,
    provider: identity.provider,
    externalId: identity.externalId,
    regionKey: identity.regionKey,
    provenance: 'UNKNOWN',
    claimSource: 'development_fixture_unverified'
  })));

  assert.deepEqual(
    sorted(claims.map(({ id: _id, ...claim }) => claim)),
    sorted(expectedClaims),
    'fixture provider identifiers must exist once each as unverified claims'
  );

  const localizations = await prisma.gameLocalization.findMany({
    where: { catalogGameId: { in: gameIds } },
    select: {
      catalogGameId: true,
      kind: true,
      languageCode: true,
      regionCode: true,
      title: true,
      normalizedTitle: true,
      provenance: true
    }
  });
  const expectedLocalizations = FIXTURE_GAMES.flatMap((fixture) => fixture.localizations.map((localization) => ({
    catalogGameId: fixture.id,
    kind: localization.kind,
    languageCode: localization.languageCode,
    regionCode: localization.regionCode,
    title: localization.title,
    normalizedTitle: normalizeTitle(localization.title),
    provenance: 'EDITOR_VERIFIED'
  })));

  assert.deepEqual(sorted(localizations), sorted(expectedLocalizations),
    'fixture localizations must be editor-verified and duplicate-free');

  const releases = await prisma.regionalRelease.findMany({
    where: { catalogGameId: { in: gameIds } },
    select: { id: true, catalogGameId: true }
  });
  const expectedReleaseCount = FIXTURE_GAMES.reduce(
    (count, fixture) => count + fixture.regionalReleases.length,
    0
  );

  assert.equal(releases.length, expectedReleaseCount, 'fixture releases must be duplicate-free');

  const article = await prisma.editorialArticle.findUnique({
    where: { slug: FIXTURE_ARTICLE.slug },
    select: {
      id: true,
      status: true,
      currentRevisionId: true,
      currentRevision: {
        select: {
          id: true,
          revisionNumber: true,
          status: true,
          headline: true,
          excerpt: true,
          bodyMarkdown: true
        }
      },
      revisions: { select: { id: true } },
      gameLinks: {
        select: { catalogGameId: true, relation: true },
        orderBy: { catalogGameId: 'asc' }
      }
    }
  });

  assert.ok(article, 'the editorial fixture article must exist');
  assert.equal(article.status, 'DRAFT');
  assert.equal(article.revisions.length, 1, 'the article must have exactly one reusable fixture revision');
  assert.equal(article.currentRevisionId, article.currentRevision?.id,
    'currentRevisionId must point at the reusable fixture revision');
  assert.equal(article.currentRevision.revisionNumber, 1);
  assert.equal(article.currentRevision.status, 'DRAFT');
  assert.equal(article.currentRevision.headline, FIXTURE_ARTICLE.headline);
  assert.equal(article.currentRevision.excerpt, FIXTURE_ARTICLE.excerpt);
  assert.equal(article.currentRevision.bodyMarkdown, FIXTURE_ARTICLE.bodyMarkdown);
  assert.deepEqual(article.gameLinks, [{
    catalogGameId: FIXTURE_GAMES[0].id,
    relation: 'SUBJECT'
  }]);

  const snapshot = {
    gameIds: games.map((game) => game.id),
    claimIds: claims.map((claim) => claim.id).sort(),
    localizationCount: localizations.length,
    regionalReleaseIds: releases.map((release) => release.id).sort(),
    articleId: article.id,
    currentRevisionId: article.currentRevisionId,
    revisionCount: article.revisions.length,
    articleGameLinks: article.gameLinks
  };

  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    process.stderr.write(`Product 2.2 development seed verification failed: ${error.message}\n`);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
