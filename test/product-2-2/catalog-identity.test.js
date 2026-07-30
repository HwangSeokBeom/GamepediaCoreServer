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

test('title normalization is Unicode-safe and keeps every script searchable', () => {
  assert.equal(normalizeTitle('Portal 2'), 'portal 2');
  assert.equal(normalizeTitle('PORTAL  2'), 'portal 2');
  assert.equal(normalizeTitle('Hollow Knight™'), 'hollow knight');
  assert.equal(normalizeTitle('  \t 뱀파이어 서바이버즈 '), '뱀파이어 서바이버즈');
  assert.equal(normalizeTitle('ゼルダの伝説'), 'ゼルダの伝説');
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(12), '');
  // The migration clamps to 300 characters; so must the API.
  assert.equal(normalizeTitle('a'.repeat(400)).length, 300);

  // Diacritics are letters, not separators: the old rule produced 'pok mon',
  // which split one word into two tokens and lost the accent entirely.
  assert.equal(normalizeTitle("Pokémon: Let's Go!"), 'pokémon let s go');
  assert.equal(normalizeTitle('Café Racer'), 'café racer');

  // The prolonged sound mark is a modifier letter, so it must not split a word.
  assert.equal(normalizeTitle('ゲーム'), 'ゲーム');
  assert.equal(normalizeTitle('ポケモン ソード'), 'ポケモン ソード');

  // NFKC folds compatibility forms before anything is stripped.
  assert.equal(normalizeTitle('Ｐｏｒｔａｌ ２'), 'portal 2');
  assert.equal(normalizeTitle('FINAL FANTASY Ⅷ'), 'final fantasy viii');
});

test('every required script normalizes to a non-empty searchable value', () => {
  // Each of these normalized to '' before the fix, which made the title
  // impossible to store meaningfully and made search return instantly empty.
  const fixtures = [
    ['Thai', 'เกมออนไลน์', 'เกมออนไลน์'],
    ['Thai with vowel sign', 'กิน', 'กิน'],
    ['Arabic', 'العاب اونلاين', 'العاب اونلاين'],
    ['Cyrillic', 'Онлайн игра', 'онлайн игра'],
    ['Greek', 'Ελληνικό παιχνίδι', 'ελληνικό παιχνίδι'],
    ['Hebrew', 'משחק עברי', 'משחק עברי'],
    ['Vietnamese', 'Việt Nam Game', 'việt nam game'],
    ['Turkish', 'Türkçe Oyun', 'türkçe oyun'],
    ['Korean', '오버워치 2', '오버워치 2'],
    ['Hiragana/Katakana', 'モンスターハンター：ワールド', 'モンスターハンター ワールド'],
    ['Simplified Chinese', '崩坏：星穹铁道', '崩坏 星穹铁道'],
    ['Traditional Chinese', '傳說對決', '傳說對決'],
    ['mixed numerals', 'Angry Birds 2', 'angry birds 2']
  ];

  for (const [label, input, expected] of fixtures) {
    const normalized = normalizeTitle(input);

    assert.notEqual(normalized, '', `${label} must not normalize to empty`);
    assert.equal(normalized, expected, `${label} normalization`);
  }

  // Punctuation-only and whitespace-only input is still legitimately empty.
  assert.equal(normalizeTitle('!!!'), '');
  assert.equal(normalizeTitle('   '), '');
  // An emoji is a symbol, not a letter, so it is a separator.
  assert.equal(normalizeTitle('👾 emoji 🎮'), 'emoji');
});

test('the retained mark class is the single source shared with the successor migration', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const {
    RETAINED_MARK_CLASS,
    buildRetainedMarkClass
  } = require('../../src/modules/catalog/catalog-title.util');

  assert.equal(RETAINED_MARK_CLASS, buildRetainedMarkClass());
  assert.ok(RETAINED_MARK_CLASS.length > 40);

  // The migration must embed the identical class, otherwise JS-created rows and
  // migration-recomputed rows would normalize differently and search would miss.
  const migration = fs.readFileSync(path.resolve(
    process.cwd(),
    'prisma/migrations/20260730130000_product_2_2_review_fixes/migration.sql'
  ), 'utf8');

  assert.ok(
    migration.includes(`'[^[:alnum:]${RETAINED_MARK_CLASS}]+'`),
    'the successor migration must embed the shared retained-mark class verbatim'
  );
  // And it must apply the same pre-strip and NFKC on the SQL side.
  const { STRIPPED_LEGAL_SYMBOLS } = require('../../src/modules/catalog/catalog-title.util');

  assert.ok(migration.includes(`translate("original_title", '${STRIPPED_LEGAL_SYMBOLS}', '')`));
  assert.ok(migration.includes(`translate("title", '${STRIPPED_LEGAL_SYMBOLS}', '')`));
  assert.match(migration, /normalize\(translate\("original_title".*NFKC\)/);
  assert.match(migration, /normalize\(translate\("title".*NFKC\)/);
});

test('a trademark symbol does not leak letters into the normalized title', () => {
  // NFKC folds U+2122 to "TM", so stripping it first is what keeps the title
  // findable by its real name.
  assert.equal(normalizeTitle('Hollow Knight™'), 'hollow knight');
  assert.equal(normalizeTitle('Portal 2®'), 'portal 2');
  assert.equal(normalizeTitle('Ori™ and the Will®'), 'ori and the will');
});

test('slug and compact title stay deterministic under Unicode', () => {
  assert.equal(buildSlug('Онлайн игра'), 'онлайн-игра');
  assert.equal(buildSlug('เกมออนไลน์'), 'เกมออนไลน์');
  assert.equal(buildSlug('Pokémon: Let\'s Go!'), 'pokémon-let-s-go');
  assert.equal(compactTitle('Онлайн игра'), 'онлайнигра');
  assert.equal(compactTitle('ゲ ー ム'), 'ゲーム');
  // Same input, same output, every time.
  assert.equal(buildSlug('เกมออนไลน์'), buildSlug('เกมออนไลน์'));
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
        return {
          catalogGameId: CATALOG_GAME_A,
          provenance: 'PROVIDER_VERIFIED',
          confidence: 1,
          verifiedAt: new Date('2026-07-01T00:00:00.000Z'),
          verificationSource: 'steam_owned_games_sync'
        };
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

test('a verified identity attachment requires verified provenance and a real source', async () => {
  // The trust boundary is enforced by the function itself, not by its callers.
  await assert.rejects(
    catalogIdentityService.attachVerifiedIdentity({
      catalogGameId: CATALOG_GAME_A,
      provider: 'STEAM',
      externalId: '367520',
      provenance: 'USER_CONFIRMED',
      verificationSource: 'steam_owned_games_sync'
    }),
    (error) => error.code === 'IDENTITY_PROVENANCE_NOT_VERIFIABLE'
  );

  await assert.rejects(
    catalogIdentityService.attachVerifiedIdentity({
      catalogGameId: CATALOG_GAME_A,
      provider: 'STEAM',
      externalId: '367520',
      provenance: 'PROVIDER_VERIFIED',
      verificationSource: 'quick_add_syntax_parse'
    }),
    (error) => error.code === 'IDENTITY_VERIFICATION_SOURCE_INVALID'
  );
});

test('attachVerifiedIdentity reports a cross-game conflict instead of repointing a key', async () => {
  const { Prisma } = require('@prisma/client');
  const restore = stubPrisma({
    gameExternalIdentity: {
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['provider', 'external_id', 'region_key'] }
        });
      },
      findUnique: async () => ({
        id: 'identity-1',
        catalogGameId: CATALOG_GAME_B,
        verifiedAt: new Date('2026-07-01T00:00:00.000Z'),
        provenance: 'PROVIDER_VERIFIED'
      })
    }
  });

  try {
    const result = await catalogIdentityService.attachVerifiedIdentity({
      catalogGameId: CATALOG_GAME_A,
      provider: 'STEAM',
      externalId: '367520',
      provenance: 'PROVIDER_VERIFIED',
      verificationSource: 'steam_owned_games_sync'
    });

    assert.equal(result.created, false);
    assert.equal(result.promoted, false);
    // The key already belongs to another canonical game: that is a merge
    // decision, so it is surfaced rather than silently applied.
    assert.equal(result.conflict, true);
    assert.equal(result.identity.catalogGameId, CATALOG_GAME_B);
  } finally {
    restore();
  }
});

test('a real provider response promotes an unverified legacy identity in place', async () => {
  const { Prisma } = require('@prisma/client');
  const updates = [];
  const restore = stubPrisma({
    gameExternalIdentity: {
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['provider', 'external_id', 'region_key'] }
        });
      },
      // Same canonical game, but never verified: a legacy backfill row.
      findUnique: async () => ({
        id: 'identity-1',
        catalogGameId: CATALOG_GAME_A,
        verifiedAt: null,
        provenance: 'UNKNOWN'
      }),
      update: async ({ data }) => {
        updates.push(data);
        return { id: 'identity-1', catalogGameId: CATALOG_GAME_A, verifiedAt: data.verifiedAt };
      }
    }
  });

  try {
    const result = await catalogIdentityService.attachVerifiedIdentity({
      catalogGameId: CATALOG_GAME_A,
      provider: 'STEAM',
      externalId: '367520',
      provenance: 'PROVIDER_VERIFIED',
      verificationSource: 'steam_owned_games_sync'
    });

    // An unverified row must never block legitimate verification.
    assert.equal(result.promoted, true);
    assert.equal(result.conflict, false);
    assert.equal(updates[0].provenance, 'PROVIDER_VERIFIED');
    assert.equal(updates[0].verificationSource, 'steam_owned_games_sync');
    assert.ok(updates[0].verifiedAt instanceof Date);
  } finally {
    restore();
  }
});

test('an identity claim can never assert verified provenance', async () => {
  await assert.rejects(
    catalogIdentityService.recordIdentityClaim({
      catalogGameId: CATALOG_GAME_A,
      provider: 'STEAM',
      externalId: '367520',
      provenance: 'PROVIDER_VERIFIED'
    }),
    (error) => error.code === 'IDENTITY_CLAIM_PROVENANCE_INVALID'
  );
});

test('a verified lookup ignores an unverified identity row', async () => {
  const restore = stubPrisma({
    gameExternalIdentity: {
      findUnique: async () => ({
        catalogGameId: CATALOG_GAME_A,
        provenance: 'UNKNOWN',
        confidence: 0,
        verifiedAt: null,
        verificationSource: null
      })
    },
    catalogGame: { findUnique: async ({ where }) => ({ id: where.id, mergedIntoCatalogGameId: null }) }
  });

  try {
    // Verified-only is the default, so an unverified row is invisible to trust.
    assert.equal(
      await catalogIdentityService.findCanonicalGameByIdentity({ provider: 'STEAM', externalId: '367520' }),
      null
    );

    // It is still resolvable when the caller explicitly asks for unverified rows.
    const unverified = await catalogIdentityService.findCanonicalGameByIdentity(
      { provider: 'STEAM', externalId: '367520' },
      { requireVerified: false }
    );

    assert.equal(unverified.catalogGameId, CATALOG_GAME_A);
    assert.equal(unverified.verified, false);
  } finally {
    restore();
  }
});

test('the publication trust invariant blocks publishing unverified information', () => {
  const { assertPublicationTrust } = catalogIdentityService;

  // A verified pair may publish.
  assert.doesNotThrow(() => assertPublicationTrust({
    publicationStatus: 'PUBLISHED',
    titleProvenance: 'PROVIDER_VERIFIED',
    identityProvenance: 'PROVIDER_VERIFIED'
  }));
  assert.doesNotThrow(() => assertPublicationTrust({
    publicationStatus: 'PUBLISHED',
    titleProvenance: 'EDITOR_VERIFIED',
    identityProvenance: 'OFFICIAL_SOURCE'
  }));

  // Anything unverified cannot.
  for (const provenance of ['USER_CONFIRMED', 'COMMUNITY_CONFIRMED', 'AI_INFERRED', 'UNKNOWN', 'DISPUTED']) {
    assert.throws(
      () => assertPublicationTrust({
        publicationStatus: 'PUBLISHED',
        titleProvenance: provenance,
        identityProvenance: 'PROVIDER_VERIFIED'
      }),
      (error) => error.code === 'CATALOG_PUBLICATION_TRUST_VIOLATION',
      `titleProvenance ${provenance} must not publish`
    );
    assert.throws(
      () => assertPublicationTrust({
        publicationStatus: 'PUBLISHED',
        titleProvenance: 'PROVIDER_VERIFIED',
        identityProvenance: provenance
      }),
      (error) => error.code === 'CATALOG_PUBLICATION_TRUST_VIOLATION',
      `identityProvenance ${provenance} must not publish`
    );
  }

  // A PRIVATE or PENDING_REVIEW game may carry any provenance.
  assert.doesNotThrow(() => assertPublicationTrust({
    publicationStatus: 'PRIVATE',
    titleProvenance: 'AI_INFERRED',
    identityProvenance: 'USER_CONFIRMED'
  }));
});

test('the legacy identity lookup never throws into the caller', async () => {
  const restore = stubPrisma({
    gameExternalIdentity: {
      findUnique: async () => {
        throw new Error('database unavailable');
      }
    }
  });

  try {
    const result = await catalogIdentityService.resolveVerifiedCanonicalGameIdForLegacyWrite({
      gameSource: 'STEAM',
      externalGameId: '367520'
    });

    // A catalog failure must degrade to null so the legacy write path is unaffected.
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('a manual legacy write can only link an already verified identity, never create one', async () => {
  let createCalls = 0;
  const restore = stubPrisma({
    gameExternalIdentity: {
      // The provider key has never been verified.
      findUnique: async () => null,
      create: async () => {
        createCalls += 1;
        return { id: 'identity-1', catalogGameId: CATALOG_GAME_A };
      }
    },
    catalogGame: {
      create: async () => {
        createCalls += 1;
        return { id: CATALOG_GAME_A };
      }
    }
  });

  try {
    const result = await catalogIdentityService.resolveVerifiedCanonicalGameIdForLegacyWrite({
      gameSource: 'STEAM',
      externalGameId: '999999999'
    });

    // Null, not a freshly minted verified identity: the id came from a request body.
    assert.equal(result, null);
    assert.equal(createCalls, 0, 'a manual legacy write must never create a catalog game or identity');
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
        // the winner, already verified and bound to a different game.
        return identityLookups === 1
          ? null
          : {
            id: 'identity-1',
            catalogGameId: CATALOG_GAME_B,
            verifiedAt: new Date('2026-07-01T00:00:00.000Z'),
            provenance: 'PROVIDER_VERIFIED',
            confidence: 1,
            verificationSource: 'steam_owned_games_sync'
          };
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
    const result = await catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
      provider: 'STEAM',
      externalId: '367520',
      title: 'Hollow Knight',
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'PROVIDER_VERIFIED',
      identityProvenance: 'PROVIDER_VERIFIED',
      verificationSource: 'steam_owned_games_sync'
    });

    assert.equal(result.created, false);
    assert.equal(result.catalogGameId, CATALOG_GAME_B);
    assert.deepEqual(deleted, [CATALOG_GAME_A], 'the losing row must not be left behind');
  } finally {
    restore();
  }
});

test('a provider key with no title is never published and keeps UNKNOWN provenance', async () => {
  let createdData = null;
  const restore = stubPrisma({
    gameExternalIdentity: {
      findUnique: async () => null,
      create: async () => ({ id: 'identity-1', catalogGameId: CATALOG_GAME_A, verifiedAt: new Date() })
    },
    catalogGame: {
      create: async ({ data }) => {
        createdData = data;
        return { id: CATALOG_GAME_A };
      }
    }
  });

  try {
    await catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
      provider: 'IGDB',
      externalId: '7777',
      title: null,
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'PROVIDER_VERIFIED',
      identityProvenance: 'PROVIDER_VERIFIED',
      verificationSource: 'igdb_provider_lookup'
    });

    assert.equal(createdData.originalTitle, 'IGDB:7777');
    assert.equal(createdData.titleProvenance, 'UNKNOWN');
    // A synthetic placeholder carries no verified information, so even a verified
    // identity cannot make it publicly searchable.
    assert.equal(createdData.publicationStatus, 'PENDING_REVIEW');
    assert.equal(createdData.normalizedTitle, 'igdb 7777');
  } finally {
    restore();
  }
});

test('creating a canonical game for a provider key demands explicit trust arguments', async () => {
  // The old signature defaulted to PUBLISHED + PROVIDER_VERIFIED, so any caller
  // that forgot to think about trust silently published a verified game.
  await assert.rejects(
    catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
      provider: 'STEAM',
      externalId: '367520',
      title: 'Hollow Knight',
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'USER_CONFIRMED',
      identityProvenance: 'USER_CONFIRMED',
      verificationSource: 'steam_owned_games_sync'
    }),
    (error) => error.code === 'CATALOG_PUBLICATION_TRUST_VIOLATION'
  );

  await assert.rejects(
    catalogIdentityService.ensureVerifiedCanonicalGameForIdentity({
      provider: 'STEAM',
      externalId: '367520',
      title: 'Hollow Knight',
      publicationStatus: 'PUBLISHED',
      titleProvenance: 'PROVIDER_VERIFIED',
      identityProvenance: 'PROVIDER_VERIFIED',
      verificationSource: 'not_a_real_source'
    }),
    (error) => error.code === 'IDENTITY_VERIFICATION_SOURCE_INVALID'
  );
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
    'userRoleAssignment',
    'gameIdentityClaim'
  ]) {
    assert.ok(prisma[delegate], `prisma.${delegate} must exist`);
  }
});
