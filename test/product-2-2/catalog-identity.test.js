const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CATALOG_GAME_A,
  CATALOG_GAME_B,
  prisma,
  stubPrisma
} = require('./helpers/test-env');

const {
  buildSlug,
  compactTitle,
  fingerprintInput,
  normalizeTitle,
  titleSimilarity
} = require('../../src/modules/catalog/catalog-title.util');
const catalogIdentityService = require('../../src/modules/catalog/catalog-identity.service');
const { parseProviderIdentity } = require('../../src/modules/catalog/catalog-input.parser');

test('title normalization matches the SQL backfill rules', () => {
  assert.equal(normalizeTitle('Portal 2'), 'portal 2');
  assert.equal(normalizeTitle('PORTAL  2'), 'portal 2');
  assert.equal(normalizeTitle("Pokémon: Let's Go!"), 'pok mon let s go');
  assert.equal(normalizeTitle('Hollow Knight™'), 'hollow knight');
  assert.equal(normalizeTitle('  \t 뱀파이어 서바이버즈 '), '뱀파이어 서바이버즈');
  assert.equal(normalizeTitle('ゼルダの伝説'), 'ゼルダの伝説');
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(12), '');
  // The migration clamps to 300 characters; so must the API.
  assert.equal(normalizeTitle('a'.repeat(400)).length, 300);
});

test('compact and slug forms are derived deterministically', () => {
  assert.equal(compactTitle('Portal 2'), 'portal2');
  assert.equal(compactTitle('P O R T A L 2'), 'portal2');
  assert.equal(buildSlug('Hollow Knight'), 'hollow-knight');
  assert.equal(buildSlug('Hollow Knight', 'KR'), 'hollow-knight-kr');
  assert.equal(buildSlug('!!!'), null);
});

test('title similarity is symmetric, bounded and rejects unrelated titles', () => {
  const { FUZZY_MATCH_MIN_SIMILARITY } = require('../../src/modules/catalog/catalog.constants');

  assert.equal(titleSimilarity('Portal 2', 'Portal 2'), 1);
  assert.equal(titleSimilarity('Portal 2', 'portal  2'), 1);
  // A near-miss stays above the fuzzy gate; an unrelated title stays below it, so
  // "Portal" can never surface "Stardew Valley" as a candidate.
  assert.ok(titleSimilarity('Portal', 'Portal 2') > FUZZY_MATCH_MIN_SIMILARITY);
  assert.ok(titleSimilarity('Portal', 'Stardew Valley') < FUZZY_MATCH_MIN_SIMILARITY);
  assert.ok(titleSimilarity('Hollow Knight', 'Stardew Valley') < FUZZY_MATCH_MIN_SIMILARITY);
  assert.equal(titleSimilarity('Portal', ''), 0);
  assert.equal(
    titleSimilarity('Hollow Knight', 'Hollow Knight Silksong'),
    titleSimilarity('Hollow Knight Silksong', 'Hollow Knight')
  );
});

test('input fingerprint is a stable SHA-256 that never contains the input', () => {
  const fingerprint = fingerprintInput('  Some Secret Game Title  ');

  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, fingerprintInput('some secret game title'));
  assert.notEqual(fingerprint, fingerprintInput('a different title'));
  assert.equal(fingerprint.includes('secret'), false);
});

test('deterministic parsing resolves store URLs without any network access', () => {
  assert.deepEqual(
    parseProviderIdentity({ inputType: 'URL', input: 'https://store.steampowered.com/app/367520/Hollow_Knight/' }),
    { provider: 'STEAM', externalId: '367520', regionKey: 'GLOBAL', matchedBy: 'store_url' }
  );
  assert.deepEqual(
    parseProviderIdentity({ inputType: 'URL', input: 'https://apps.apple.com/kr/app/some-game/id1234567890' }),
    { provider: 'APPLE_APP_STORE', externalId: '1234567890', regionKey: 'KR', matchedBy: 'store_url' }
  );
  assert.deepEqual(
    parseProviderIdentity({ inputType: 'URL', input: 'https://play.google.com/store/apps/details?id=com.example.game&gl=kr' }),
    { provider: 'GOOGLE_PLAY', externalId: 'com.example.game', regionKey: 'KR', matchedBy: 'store_url' }
  );
  assert.deepEqual(
    parseProviderIdentity({ inputType: 'URL', input: 'https://www.igdb.com/games/hollow-knight' }),
    { provider: 'IGDB', externalId: 'hollow-knight', regionKey: 'GLOBAL', matchedBy: 'store_url' }
  );
});

test('deterministic parsing rejects non-https, unknown hosts and SSRF-shaped inputs', () => {
  const rejected = [
    'http://store.steampowered.com/app/367520/',
    'https://store.steampowered.com.evil.example/app/367520/',
    'https://127.0.0.1/app/367520/',
    'https://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'https://store.steampowered.com/',
    'javascript:alert(1)'
  ];

  for (const input of rejected) {
    assert.equal(parseProviderIdentity({ inputType: 'URL', input }), null, `must reject ${input}`);
  }
});

test('provider id parsing requires an unambiguous provider', () => {
  assert.deepEqual(
    parseProviderIdentity({ inputType: 'PROVIDER_ID', input: 'steam:367520' }),
    { provider: 'STEAM', externalId: '367520', regionKey: 'GLOBAL', matchedBy: 'provider_prefix' }
  );
  assert.deepEqual(
    parseProviderIdentity({ inputType: 'PROVIDER_ID', input: 'com.example.game' }),
    { provider: 'GOOGLE_PLAY', externalId: 'com.example.game', regionKey: 'GLOBAL', matchedBy: 'package_id' }
  );
  // A bare number is ambiguous without a platform hint.
  assert.equal(parseProviderIdentity({ inputType: 'PROVIDER_ID', input: '367520' }), null);
  assert.deepEqual(
    parseProviderIdentity({ inputType: 'PROVIDER_ID', input: '367520', platformHint: 'STEAM' }),
    { provider: 'STEAM', externalId: '367520', regionKey: 'GLOBAL', matchedBy: 'numeric_with_platform_hint' }
  );
  assert.equal(parseProviderIdentity({ inputType: 'PROVIDER_ID', input: 'steam:not-a-number' }), null);
  assert.equal(parseProviderIdentity({ inputType: 'TEXT', input: 'Hollow Knight' }), null);
});

test('canonical resolution follows a merge tombstone to the surviving game', async () => {
  const restore = stubPrisma({
    catalogGame: {
      findUnique: async ({ where }) => {
        if (where.id === CATALOG_GAME_A) {
          return { id: CATALOG_GAME_A, mergedIntoCatalogGameId: CATALOG_GAME_B };
        }

        if (where.id === CATALOG_GAME_B) {
          return { id: CATALOG_GAME_B, mergedIntoCatalogGameId: null };
        }

        return null;
      }
    }
  });

  try {
    assert.equal(await catalogIdentityService.resolveCanonicalGameId(CATALOG_GAME_A), CATALOG_GAME_B);
    assert.equal(await catalogIdentityService.resolveCanonicalGameId(CATALOG_GAME_B), CATALOG_GAME_B);
    assert.equal(await catalogIdentityService.resolveCanonicalGameId('00000000-0000-4000-8000-00000000dead'), null);
  } finally {
    restore();
  }
});

test('a merge cycle cannot hang canonical resolution', async () => {
  let lookups = 0;
  const restore = stubPrisma({
    catalogGame: {
      findUnique: async ({ where }) => {
        lookups += 1;

        return where.id === CATALOG_GAME_A
          ? { id: CATALOG_GAME_A, mergedIntoCatalogGameId: CATALOG_GAME_B }
          : { id: CATALOG_GAME_B, mergedIntoCatalogGameId: CATALOG_GAME_A };
      }
    }
  });

  try {
    const resolved = await catalogIdentityService.resolveCanonicalGameId(CATALOG_GAME_A);

    assert.ok([CATALOG_GAME_A, CATALOG_GAME_B].includes(resolved));
    assert.ok(lookups <= 8, `bounded traversal expected, saw ${lookups} lookups`);
  } finally {
    restore();
  }
});

test('legacy identity lookup maps GameSource to the canonical provider', async () => {
  const seen = [];
  const restore = stubPrisma({
    gameExternalIdentity: {
      findUnique: async ({ where }) => {
        seen.push(where.provider_externalId_regionKey);
        return { catalogGameId: CATALOG_GAME_A, provenance: 'PROVIDER_VERIFIED', confidence: 1 };
      }
    },
    catalogGame: {
      findUnique: async () => ({ id: CATALOG_GAME_A, mergedIntoCatalogGameId: null })
    }
  });

  try {
    const steam = await catalogIdentityService.findCanonicalGameByLegacyIdentity({
      gameSource: 'STEAM',
      externalGameId: ' 367520 '
    });
    const igdb = await catalogIdentityService.findCanonicalGameByLegacyIdentity({
      gameSource: 'IGDB',
      externalGameId: '1942'
    });

    assert.equal(steam.catalogGameId, CATALOG_GAME_A);
    assert.equal(igdb.catalogGameId, CATALOG_GAME_A);
    assert.deepEqual(seen, [
      { provider: 'STEAM', externalId: '367520', regionKey: 'GLOBAL' },
      { provider: 'IGDB', externalId: '1942', regionKey: 'GLOBAL' }
    ]);

    // An unsupported legacy source resolves to nothing rather than guessing.
    assert.equal(await catalogIdentityService.findCanonicalGameByLegacyIdentity({
      gameSource: 'EPIC',
      externalGameId: '5'
    }), null);
    assert.equal(await catalogIdentityService.findCanonicalGameByLegacyIdentity({
      gameSource: 'IGDB',
      externalGameId: '   '
    }), null);
  } finally {
    restore();
  }
});

test('attachIdentity reports a cross-game conflict instead of repointing a provider key', async () => {
  const uniqueViolation = Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    clientVersion: 'test',
    name: 'PrismaClientKnownRequestError'
  });
  const { Prisma } = require('@prisma/client');
  const realViolation = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['provider', 'external_id', 'region_key'] }
  });

  assert.equal(uniqueViolation.code, realViolation.code);

  const restore = stubPrisma({
    gameExternalIdentity: {
      create: async () => {
        throw realViolation;
      },
      findUnique: async () => ({ id: 'identity-1', catalogGameId: CATALOG_GAME_B })
    }
  });

  try {
    const result = await catalogIdentityService.attachIdentity({
      catalogGameId: CATALOG_GAME_A,
      provider: 'STEAM',
      externalId: '367520'
    });

    assert.equal(result.created, false);
    // The key already belongs to another canonical game: that is a merge
    // decision, so it is surfaced rather than silently applied.
    assert.equal(result.conflict, true);
    assert.equal(result.identity.catalogGameId, CATALOG_GAME_B);
  } finally {
    restore();
  }
});

test('the best-effort legacy dual write never throws into the caller', async () => {
  const restore = stubPrisma({
    gameExternalIdentity: {
      findUnique: async () => {
        throw new Error('database unavailable');
      }
    }
  });

  try {
    const result = await catalogIdentityService.resolveCanonicalGameIdForLegacyWrite({
      gameSource: 'STEAM',
      externalGameId: '367520',
      title: 'Hollow Knight'
    });

    // A catalog failure must degrade to null so the legacy write path is unaffected.
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('losing the create race drops the duplicate row and returns the winner', async () => {
  const { Prisma } = require('@prisma/client');
  const deleted = [];
  let identityLookups = 0;
  const restore = stubPrisma({
    gameExternalIdentity: {
      findUnique: async () => {
        identityLookups += 1;
        // First lookup (pre-create) finds nothing; the post-conflict lookup finds
        // the winner.
        return identityLookups === 1 ? null : { id: 'identity-1', catalogGameId: CATALOG_GAME_B };
      },
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['provider', 'external_id', 'region_key'] }
        });
      }
    },
    catalogGame: {
      create: async () => ({ id: CATALOG_GAME_A }),
      delete: async ({ where }) => {
        deleted.push(where.id);
        return { id: where.id };
      },
      findUnique: async ({ where }) => ({ id: where.id, mergedIntoCatalogGameId: null })
    }
  });

  try {
    const result = await catalogIdentityService.ensureCanonicalGameForIdentity({
      provider: 'STEAM',
      externalId: '367520',
      title: 'Hollow Knight'
    });

    assert.equal(result.created, false);
    assert.equal(result.catalogGameId, CATALOG_GAME_B);
    assert.deepEqual(deleted, [CATALOG_GAME_A], 'the losing row must not be left behind');
  } finally {
    restore();
  }
});

test('a provider key with no title falls back to an UNKNOWN title provenance', async () => {
  let createdData = null;
  const restore = stubPrisma({
    gameExternalIdentity: {
      findUnique: async () => null,
      create: async () => ({ id: 'identity-1', catalogGameId: CATALOG_GAME_A })
    },
    catalogGame: {
      create: async ({ data }) => {
        createdData = data;
        return { id: CATALOG_GAME_A };
      }
    }
  });

  try {
    await catalogIdentityService.ensureCanonicalGameForIdentity({
      provider: 'IGDB',
      externalId: '7777',
      title: null
    });

    assert.equal(createdData.originalTitle, 'IGDB:7777');
    assert.equal(createdData.titleProvenance, 'UNKNOWN');
    assert.equal(createdData.normalizedTitle, 'igdb 7777');
  } finally {
    restore();
  }
});

test('prisma delegates used by the catalog exist on the generated client', () => {
  for (const delegate of [
    'catalogGame',
    'gameLocalization',
    'regionalRelease',
    'gameExternalIdentity',
    'gameAsset',
    'gameFieldEvidence',
    'gameSubmission',
    'catalogMergeAudit',
    'gameFollow',
    'playSession',
    'clientMutationReceipt',
    'playCompassEvent',
    'editorialArticle',
    'articleRevision',
    'articleSource',
    'articleGameLink',
    'articleAsset',
    'productEvent',
    'productFeatureFlag',
    'userRoleAssignment'
  ]) {
    assert.ok(prisma[delegate], `prisma.${delegate} must exist`);
  }
});
