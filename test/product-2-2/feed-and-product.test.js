const test = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const {
  CATALOG_GAME_A,
  CATALOG_GAME_B,
  USER_A,
  USER_B,
  captureLogs,
  stubPrisma,
  stubTransaction
} = require('./helpers/test-env');

const articleService = require('../../src/modules/feed/article.service');
const todayService = require('../../src/modules/feed/today.service');
const productEventService = require('../../src/modules/product/product-event.service');
const featureFlagService = require('../../src/modules/product/feature-flag.service');
const userRoleService = require('../../src/modules/product/user-role.service');
const { getProductConfig } = require('../../src/modules/product/product-config.service');
const safeFetch = require('../../src/modules/feed/safe-fetch');
const sourceAdapter = require('../../src/modules/feed/source-adapter');
const rssAdapter = require('../../src/modules/feed/source-adapter/rss.adapter');
const steamNewsAdapter = require('../../src/modules/feed/source-adapter/steam-news.adapter');
const { FEATURE_FLAG_KEYS, PRODUCT_EVENT_CODES } = require('../../src/modules/product/product.constants');

const NOW = new Date('2026-07-30T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

test('a database override wins over the environment default', async () => {
  const restore = stubPrisma({
    productFeatureFlag: {
      findMany: async () => [{ key: 'aiQuickAdd', enabled: false }]
    }
  });

  try {
    const { flags, source } = await featureFlagService.resolveFeatureFlags();

    assert.equal(source, 'database');
    assert.equal(flags.aiQuickAdd, false);
    // Every other switch is independent and stays on its default.
    assert.equal(flags.playlog, true);
    assert.equal(flags.openCatalog, true);
    assert.equal(await featureFlagService.isFeatureEnabled('aiQuickAdd'), false);
    assert.equal(await featureFlagService.isFeatureEnabled('playlog'), true);
  } finally {
    restore();
  }
});

test('a flag lookup failure falls back to environment defaults instead of failing', async () => {
  const logs = captureLogs();
  const restore = stubPrisma({
    productFeatureFlag: {
      findMany: async () => {
        throw new Error('database unavailable');
      }
    }
  });

  try {
    const { flags, source } = await featureFlagService.resolveFeatureFlags();

    assert.equal(source, 'environment_defaults');
    assert.deepEqual(Object.keys(flags).sort(), [...FEATURE_FLAG_KEYS].sort());
    assert.equal(Object.values(flags).every((value) => value === true), true);
    assert.match(logs.serialize(), /product-feature-flag-lookup-failed/);
  } finally {
    logs.restore();
    restore();
  }
});

test('an unknown flag key is a programming error, not a silent false', async () => {
  await assert.rejects(
    featureFlagService.isFeatureEnabled('notARealFlag'),
    (error) => error.statusCode === 500 && error.code === 'UNKNOWN_FEATURE_FLAG'
  );
});

test('the product config DTO is versioned and lists every kill switch', async () => {
  const restore = stubPrisma({ productFeatureFlag: { findMany: async () => [] } });

  try {
    const config = await getProductConfig({ now: NOW });

    assert.equal(config.dtoVersion, 1);
    assert.equal(typeof config.productVersion, 'string');
    assert.equal(config.generatedAt, NOW.toISOString());
    assert.deepEqual(Object.keys(config.features).sort(), [...FEATURE_FLAG_KEYS].sort());
    assert.equal(config.limits.playCompassMaxResults, 3);
    assert.equal(config.limits.quickAddPreviewMaxCandidates, 3);
    assert.equal(config.limits.quickAddPreviewMaxQuestions, 1);
    assert.deepEqual(config.allowlists.productEventCodes.sort(), [...PRODUCT_EVENT_CODES].sort());
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Database-backed roles
// ---------------------------------------------------------------------------

test('only unrevoked role rows grant capability', async () => {
  const restore = stubPrisma({
    userRoleAssignment: {
      findMany: async ({ where }) => {
        assert.equal(where.revokedAt, null, 'revoked rows must be excluded by the query itself');
        return where.userId === USER_A ? [{ role: 'EDITOR' }] : [];
      }
    }
  });

  try {
    assert.deepEqual(await userRoleService.listActiveRoles(USER_A), ['EDITOR']);
    assert.equal(await userRoleService.hasAnyRole(USER_A, ['EDITOR', 'ADMIN']), true);
    assert.equal(await userRoleService.hasAnyRole(USER_B, ['EDITOR', 'ADMIN']), false);
    // A plain user role never satisfies an editor requirement.
    assert.equal(await userRoleService.hasAnyRole(USER_A, ['ADMIN']), false);
  } finally {
    restore();
  }
});

test('the role middleware rejects a request with no active role', async () => {
  const restore = stubPrisma({
    userRoleAssignment: { findMany: async () => [] }
  });
  const middleware = userRoleService.requireRole('EDITOR', 'ADMIN');

  try {
    const error = await new Promise((resolve) => {
      middleware({ auth: { userId: USER_B } }, {}, resolve);
    });

    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'FORBIDDEN_ROLE');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Editorial workflow
// ---------------------------------------------------------------------------

test('the article state machine allows only the documented transitions', () => {
  const allowed = [
    ['DRAFT', 'FACT_CHECK'],
    ['FACT_CHECK', 'RIGHTS_REVIEW'],
    ['RIGHTS_REVIEW', 'SCHEDULED'],
    ['SCHEDULED', 'PUBLISHED'],
    ['PUBLISHED', 'CORRECTED'],
    ['PUBLISHED', 'RETRACTED'],
    ['CORRECTED', 'RETRACTED']
  ];

  for (const [from, to] of allowed) {
    assert.doesNotThrow(() => articleService.assertTransitionAllowed(from, to), `${from} -> ${to} must be allowed`);
  }

  const forbidden = [
    ['DRAFT', 'PUBLISHED'],
    ['DRAFT', 'SCHEDULED'],
    ['FACT_CHECK', 'PUBLISHED'],
    ['RIGHTS_REVIEW', 'PUBLISHED'],
    ['RETRACTED', 'PUBLISHED'],
    ['RETRACTED', 'DRAFT'],
    ['PUBLISHED', 'DRAFT']
  ];

  for (const [from, to] of forbidden) {
    assert.throws(
      () => articleService.assertTransitionAllowed(from, to),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_TRANSITION_NOT_ALLOWED',
      `${from} -> ${to} must be refused`
    );
  }
});

test('publishing re-checks the role in the database and refuses without one', async () => {
  let roleLookups = 0;
  const restore = stubPrisma({
    userRoleAssignment: {
      findMany: async () => {
        roleLookups += 1;
        return [];
      }
    },
    editorialArticle: { findUnique: async () => ({ id: 'a-1', status: 'SCHEDULED', assets: [], revisions: [] }) }
  });

  try {
    await assert.rejects(
      articleService.publishArticle({ actorUserId: USER_B, slug: 'some-article' }),
      (error) => error.statusCode === 403 && error.code === 'FORBIDDEN_ROLE'
    );

    assert.equal(roleLookups, 1, 'the role must be read from the database at publish time');
  } finally {
    restore();
  }
});

test('an unresolved hero image rights status blocks publication', async () => {
  for (const rightsStatus of ['UNKNOWN', 'USER_SUBMITTED', 'RESTRICTED']) {
    const restore = stubPrisma({
      userRoleAssignment: { findMany: async () => [{ role: 'EDITOR' }] },
      editorialArticle: {
        findUnique: async () => ({
          id: 'a-1',
          status: 'SCHEDULED',
          aiDraftUsed: false,
          assets: [{ rightsStatus, isHero: true }],
          revisions: []
        })
      }
    });

    try {
      await assert.rejects(
        articleService.publishArticle({ actorUserId: USER_A, slug: 'some-article' }),
        (error) => error.statusCode === 409 && error.code === 'ARTICLE_HERO_RIGHTS_UNRESOLVED',
        `${rightsStatus} must block publication`
      );
    } finally {
      restore();
    }
  }
});

test('a cleared hero image publishes and an unresolved one is withheld from the DTO', async () => {
  const restoreTransaction = stubTransaction();
  let articleReads = 0;
  const restore = stubPrisma({
    userRoleAssignment: { findMany: async () => [{ role: 'EDITOR' }] },
    editorialArticle: {
      findUnique: async () => ({
        id: 'a-1',
        slug: 'ok-article',
        // The first read is the pre-publish state; later reads see the result.
        status: (articleReads += 1) === 1 ? 'SCHEDULED' : 'PUBLISHED',
        locale: 'ko',
        headline: 'H',
        excerpt: 'E',
        authorUserId: USER_A,
        scheduledFor: null,
        publishedAt: NOW,
        correctedAt: null,
        retractedAt: null,
        aiDraftUsed: false,
        createdAt: NOW,
        updatedAt: NOW,
        sources: [],
        gameLinks: [],
        assets: [{ kind: 'HERO', url: 'https://cdn.example.test/hero.png', rightsStatus: 'OFFICIAL_PRESS_KIT', attribution: 'Press kit', isHero: true }],
        revisions: []
      }),
      update: async () => ({ id: 'a-1' })
    },
    articleRevision: {
      findFirst: async () => ({ revisionNumber: 3, headline: 'H', excerpt: 'E' }),
      create: async () => ({ id: 'rev-4' })
    }
  });

  try {
    const published = await articleService.publishArticle({ actorUserId: USER_A, slug: 'ok-article', now: NOW });

    assert.equal(published.status, 'PUBLISHED');
    assert.equal(published.heroImage.url, 'https://cdn.example.test/hero.png');
    assert.equal(published.heroImageWithheldReason, null);
  } finally {
    restore();
    restoreTransaction();
  }

  const withheld = articleService.mapArticle({
    slug: 's',
    status: 'PUBLISHED',
    locale: 'ko',
    headline: 'H',
    excerpt: 'E',
    publishedAt: NOW,
    correctedAt: null,
    retractedAt: null,
    sources: [],
    gameLinks: [],
    assets: [{ kind: 'HERO', url: 'https://cdn.example.test/unknown.png', rightsStatus: 'UNKNOWN', attribution: null, isHero: true }]
  });

  assert.equal(withheld.heroImage, null, 'an unresolved rights status must never be served as a hero image');
  assert.equal(withheld.heroImageWithheldReason, 'rights_status_unresolved');
});

test('an article is created as DRAFT even when the client asks for more', async () => {
  const created = [];
  const restoreTransaction = stubTransaction();
  const restore = stubPrisma({
    editorialArticle: {
      create: async ({ data }) => {
        created.push(data);
        return { id: 'a-1' };
      },
      findUnique: async () => ({
        id: 'a-1',
        slug: 'new-article',
        status: 'DRAFT',
        locale: 'ko',
        headline: 'H',
        excerpt: 'E',
        authorUserId: USER_A,
        scheduledFor: null,
        publishedAt: null,
        correctedAt: null,
        retractedAt: null,
        aiDraftUsed: true,
        createdAt: NOW,
        updatedAt: NOW,
        sources: [],
        gameLinks: [],
        assets: []
      })
    },
    articleRevision: { create: async () => ({ id: 'rev-1' }) }
  });

  try {
    const article = await articleService.createArticle({
      actorUserId: USER_A,
      input: { slug: 'new-article', locale: 'ko', headline: 'H', excerpt: 'E', aiDraftUsed: true },
      now: NOW
    });

    // An AI-assisted draft can only ever be DRAFT.
    assert.equal(created[0].status, 'DRAFT');
    assert.equal(created[0].aiDraftUsed, true);
    assert.equal(article.status, 'DRAFT');
  } finally {
    restore();
    restoreTransaction();
  }
});

test('a duplicate slug is a conflict, not a silent overwrite', async () => {
  const restoreTransaction = stubTransaction();
  const restore = stubPrisma({
    editorialArticle: {
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['slug'] }
        });
      }
    }
  });

  try {
    await assert.rejects(
      articleService.createArticle({
        actorUserId: USER_A,
        input: { slug: 'taken', locale: 'ko', headline: 'H', excerpt: 'E' }
      }),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_SLUG_TAKEN'
    );
  } finally {
    restore();
    restoreTransaction();
  }
});

test('only PUBLISHED and CORRECTED articles are publicly readable', async () => {
  let capturedWhere = null;
  const restore = stubPrisma({
    editorialArticle: {
      findFirst: async (args) => {
        capturedWhere = args.where;
        return null;
      }
    }
  });

  try {
    await assert.rejects(
      articleService.getPublishedArticleBySlug({ slug: 'draft-article' }),
      (error) => error.statusCode === 404 && error.code === 'ARTICLE_NOT_FOUND'
    );

    assert.deepEqual(capturedWhere.status, { in: ['PUBLISHED', 'CORRECTED'] });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Source adapters, allowlist and SSRF
// ---------------------------------------------------------------------------

test('non-allowlisted hosts, literal IPs and non-https schemes are refused', () => {
  const allowlist = ['news.example.test', 'store.steampowered.com'];

  assert.doesNotThrow(() => safeFetch.assertAllowedSourceUrl('https://news.example.test/feed.xml', { allowlist }));
  // A subdomain of an allowlisted host is allowed; a lookalike suffix is not.
  assert.doesNotThrow(() => safeFetch.assertAllowedSourceUrl('https://a.news.example.test/feed.xml', { allowlist }));

  const refusals = [
    ['http://news.example.test/feed.xml', 'SOURCE_SCHEME_NOT_ALLOWED'],
    ['ftp://news.example.test/feed.xml', 'SOURCE_SCHEME_NOT_ALLOWED'],
    ['https://news.example.test.evil.test/feed.xml', 'SOURCE_HOST_NOT_ALLOWED'],
    ['https://evil.test/feed.xml', 'SOURCE_HOST_NOT_ALLOWED'],
    ['https://newsxexample.test/feed.xml', 'SOURCE_HOST_NOT_ALLOWED'],
    ['https://127.0.0.1/feed.xml', 'SOURCE_HOST_NOT_ALLOWED'],
    ['https://169.254.169.254/latest/meta-data/', 'SOURCE_HOST_NOT_ALLOWED'],
    ['https://[::1]/feed.xml', 'SOURCE_HOST_NOT_ALLOWED'],
    ['https://user:pass@news.example.test/feed.xml', 'SOURCE_URL_INVALID'],
    ['not a url', 'SOURCE_URL_INVALID']
  ];

  for (const [url, expectedCode] of refusals) {
    assert.throws(
      () => safeFetch.assertAllowedSourceUrl(url, { allowlist }),
      (error) => error.code === expectedCode,
      `${url} must be refused with ${expectedCode}`
    );
  }
});

test('an empty allowlist means nothing is fetchable', () => {
  assert.throws(
    () => safeFetch.assertAllowedSourceUrl('https://news.example.test/feed.xml', { allowlist: [] }),
    (error) => error.code === 'SOURCE_HOST_NOT_ALLOWED'
  );
});

test('every private, loopback, link-local and unique-local address is blocked', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '239.1.1.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    'not-an-address'
  ];

  for (const address of blocked) {
    assert.equal(safeFetch.isBlockedAddress(address), true, `${address} must be blocked`);
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111'];

  for (const address of allowed) {
    assert.equal(safeFetch.isBlockedAddress(address), false, `${address} must be allowed`);
  }
});

test('a host that resolves to any private address is refused', async () => {
  await assert.rejects(
    safeFetch.assertResolvesToPublicAddress('news.example.test', {
      // A split-horizon answer with one private address is enough to refuse.
      lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]
    }),
    (error) => error.code === 'SOURCE_ADDRESS_BLOCKED'
  );

  await assert.doesNotReject(safeFetch.assertResolvesToPublicAddress('news.example.test', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  }));

  await assert.rejects(
    safeFetch.assertResolvesToPublicAddress('news.example.test', { lookup: async () => [] }),
    (error) => error.code === 'SOURCE_DNS_FAILED'
  );
});

test('a redirect is never followed and an oversized body is aborted', async () => {
  const allowlist = ['news.example.test'];
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];

  await assert.rejects(
    safeFetch.fetchAllowlistedSource('https://news.example.test/feed.xml', {
      allowlist,
      lookupImpl,
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, 'manual', 'redirects must never be followed automatically');
        return { status: 302, ok: false, headers: new Map([['location', 'https://evil.test/']]), body: null };
      }
    }),
    (error) => error.code === 'SOURCE_REDIRECT_BLOCKED'
  );

  await assert.rejects(
    safeFetch.fetchAllowlistedSource('https://news.example.test/feed.xml', {
      allowlist,
      lookupImpl,
      maxBytes: 16,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: new Map([['content-length', '1048576']]),
        body: null
      })
    }),
    (error) => error.code === 'SOURCE_RESPONSE_TOO_LARGE'
  );
});

test('a source fetch timeout is reported as a timeout, not a generic failure', async () => {
  await assert.rejects(
    safeFetch.fetchAllowlistedSource('https://news.example.test/feed.xml', {
      allowlist: ['news.example.test'],
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    }),
    (error) => error.statusCode === 504 && error.code === 'SOURCE_FETCH_TIMEOUT'
  );
});

test('the RSS adapter extracts only policy-permitted fields from a fixture', () => {
  const fixture = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    '<title>Official Studio News</title>',
    '<item>',
    '<title>A Fixture Update Ships</title>',
    '<link>https://news.example.test/posts/one</link>',
    '<pubDate>Tue, 14 Jul 2026 09:00:00 GMT</pubDate>',
    '<description><![CDATA[<p>A short summary with <b>markup</b>.</p>]]></description>',
    '<content:encoded>THE ENTIRE ORIGINAL ARTICLE BODY THAT MUST NOT BE COPIED</content:encoded>',
    '</item>',
    '<item>',
    '<title>Relative links are skipped</title>',
    '<link>/posts/two</link>',
    '</item>',
    '</channel></rss>'
  ].join('\n');

  const items = sourceAdapter.parseSourceDocument({
    sourceType: 'OFFICIAL_RSS',
    publisherKey: 'official-studio',
    body: fixture,
    fetchedAt: NOW
  });

  assert.equal(items.length, 1, 'a non-https/relative link is skipped');
  const [item] = items;

  assert.equal(item.headline, 'A Fixture Update Ships');
  assert.equal(item.sourceUrl, 'https://news.example.test/posts/one');
  assert.equal(item.publishedAt.toISOString(), '2026-07-14T09:00:00.000Z');
  assert.equal(item.fetchedAt, NOW);
  assert.match(item.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(item.provenance, 'OFFICIAL_SOURCE');
  // Tags are stripped; exact inter-word spacing is not part of the contract.
  assert.match(item.excerpt, /^A short summary with markup\s*\.$/);
  assert.equal(/<[^>]+>/.test(item.excerpt), false, 'markup must be stripped');
  // The full original body must never be reproduced.
  assert.equal(item.excerpt.includes('ENTIRE ORIGINAL ARTICLE BODY'), false);
  assert.equal(JSON.stringify(item).includes('ENTIRE ORIGINAL ARTICLE BODY'), false);
});

test('the RSS adapter also reads Atom entries', () => {
  const fixture = [
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '<entry>',
    '<title>An Atom Entry</title>',
    '<link rel="alternate" href="https://news.example.test/atom/one"/>',
    '<updated>2026-07-15T10:00:00Z</updated>',
    '<summary>Short summary.</summary>',
    '</entry>',
    '</feed>'
  ].join('\n');

  const items = sourceAdapter.parseSourceDocument({
    sourceType: 'OFFICIAL_RSS',
    publisherKey: 'official-studio',
    body: fixture,
    fetchedAt: NOW
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].headline, 'An Atom Entry');
  assert.equal(items[0].sourceUrl, 'https://news.example.test/atom/one');
  assert.equal(items[0].publishedAt.toISOString(), '2026-07-15T10:00:00.000Z');
});

test('an excerpt is always clamped to the configured maximum', () => {
  const longSummary = 'word '.repeat(400);
  const items = sourceAdapter.parseSourceDocument({
    sourceType: 'OFFICIAL_RSS',
    publisherKey: 'official-studio',
    body: `<rss><channel><item><title>T</title><link>https://news.example.test/x</link><description>${longSummary}</description></item></channel></rss>`,
    fetchedAt: NOW
  });

  assert.ok(items[0].excerpt.length <= sourceAdapter.MAX_EXCERPT_LENGTH);
  assert.equal(sourceAdapter.truncateExcerpt('   '), null);
  assert.equal(sourceAdapter.truncateExcerpt(null), null);
});

test('the Steam news adapter strips markup and truncates from a fixture', () => {
  const fixture = JSON.stringify({
    appnews: {
      appid: 367520,
      newsitems: [
        {
          gid: '1',
          title: 'A Fixture Patch',
          url: 'https://store.steampowered.com/news/app/367520/view/1',
          date: 1784000000,
          contents: '[b]Patch notes[/b] <i>with markup</i> and a very long body. ' + 'x'.repeat(2000)
        },
        { gid: '2', title: 'No URL', url: '', date: 1784000000, contents: 'x' }
      ]
    }
  });

  const items = sourceAdapter.parseSourceDocument({
    sourceType: 'STEAM_NEWS',
    publisherKey: 'steam-news',
    body: fixture,
    fetchedAt: NOW
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].headline, 'A Fixture Patch');
  assert.equal(items[0].excerpt.includes('[b]'), false);
  assert.equal(items[0].excerpt.includes('<i>'), false);
  assert.ok(items[0].excerpt.length <= sourceAdapter.MAX_EXCERPT_LENGTH);
  assert.deepEqual(steamNewsAdapter.parse('not json'), []);
  assert.deepEqual(steamNewsAdapter.parse('{}'), []);
});

test('an unknown adapter is refused and both adapters are registered', () => {
  assert.deepEqual(sourceAdapter.listSourceTypes(), ['OFFICIAL_RSS', 'STEAM_NEWS']);
  assert.throws(
    () => sourceAdapter.parseSourceDocument({ sourceType: 'RANDOM_BLOG', publisherKey: 'x', body: '' }),
    (error) => error.code === 'UNKNOWN_SOURCE_ADAPTER'
  );
  assert.deepEqual(rssAdapter.parse(''), []);
  assert.deepEqual(rssAdapter.parse(null), []);
});

// ---------------------------------------------------------------------------
// Today feed
// ---------------------------------------------------------------------------

function stubTodaySections() {
  return stubPrisma({
    productFeatureFlag: { findMany: async () => [] },
    userGameLibrary: { findMany: async () => [] },
    catalogGame: { findMany: async () => [] },
    playSession: { findMany: async () => [] },
    playCompassEvent: { findMany: async () => [] },
    gameFollow: { findMany: async () => [] },
    review: { findMany: async () => [] },
    editorialArticle: { findMany: async () => [] },
    friendship: { findMany: async () => [] },
    userPrivacySettings: { findMany: async () => [] },
    userActivityEvent: { findMany: async () => [] }
  });
}

test('the Today feed returns sections in a fixed deterministic order', async () => {
  const restore = stubTodaySections();

  try {
    const first = await todayService.getTodayFeed({ userId: USER_A, timezone: 'Asia/Seoul', now: NOW });
    const second = await todayService.getTodayFeed({ userId: USER_A, timezone: 'Asia/Seoul', now: NOW });

    assert.deepEqual(
      first.sections.map((section) => section.key),
      [...todayService.SECTION_ORDER],
      'section order must be fixed'
    );
    assert.deepEqual(
      second.sections.map((section) => section.key),
      first.sections.map((section) => section.key),
      'repeated requests must return the same order'
    );
    assert.equal(first.meta.partialFailure, false);
    assert.equal(first.meta.nextCursor, null);
  } finally {
    restore();
  }
});

test('one failing section degrades only that section', async () => {
  const restore = stubPrisma({
    productFeatureFlag: { findMany: async () => [] },
    // Play Compass and the backlog/start-guide sections read the library.
    userGameLibrary: {
      findMany: async () => {
        throw new Error('library query exploded');
      }
    },
    catalogGame: { findMany: async () => [] },
    playSession: { findMany: async () => [] },
    playCompassEvent: { findMany: async () => [] },
    gameFollow: { findMany: async () => [] },
    review: { findMany: async () => [] },
    editorialArticle: { findMany: async () => [] },
    friendship: { findMany: async () => [] },
    userPrivacySettings: { findMany: async () => [] },
    userActivityEvent: { findMany: async () => [] }
  });
  const logs = captureLogs();

  try {
    const feed = await todayService.getTodayFeed({ userId: USER_A, timezone: 'UTC', now: NOW });

    const failed = feed.sections.filter((section) => section.status === 'unavailable');
    const ok = feed.sections.filter((section) => section.status === 'ok');

    assert.ok(failed.length > 0, 'the broken sections must be reported as unavailable');
    assert.ok(ok.length > 0, 'the healthy sections must still render');
    assert.equal(failed.every((section) => section.reasonCode === 'section_build_failed'), true);
    assert.equal(failed.every((section) => section.data === null), true);
    assert.equal(feed.meta.partialFailure, true);
    assert.match(logs.serialize(), /today-feed-section-failed/);
    // The whole request still succeeds.
    assert.equal(feed.sections.length, todayService.SECTION_ORDER.length);
  } finally {
    logs.restore();
    restore();
  }
});

test('a disabled feature marks its section disabled without failing the feed', async () => {
  const restore = stubPrisma({
    productFeatureFlag: { findMany: async () => [{ key: 'magazine', enabled: false }, { key: 'gameDNA', enabled: false }] },
    userGameLibrary: { findMany: async () => [] },
    catalogGame: { findMany: async () => [] },
    playSession: { findMany: async () => [] },
    playCompassEvent: { findMany: async () => [] },
    gameFollow: { findMany: async () => [] },
    review: { findMany: async () => [] },
    friendship: { findMany: async () => [] },
    userPrivacySettings: { findMany: async () => [] },
    userActivityEvent: { findMany: async () => [] }
  });

  try {
    const feed = await todayService.getTodayFeed({ userId: USER_A, timezone: 'UTC', now: NOW });
    const byKey = new Map(feed.sections.map((section) => [section.key, section]));

    assert.equal(byKey.get('editorialCuration').status, 'disabled');
    assert.equal(byKey.get('editorialCuration').reasonCode, 'feature_disabled:magazine');
    assert.equal(byKey.get('gameDNA').status, 'disabled');
    assert.equal(byKey.get('playCompass').status, 'ok', 'an unrelated section stays enabled');
    assert.equal(feed.meta.partialFailure, false, 'a disabled section is not a failure');
  } finally {
    restore();
  }
});

test('the Today cursor walks the section list deterministically', async () => {
  const restore = stubTodaySections();

  try {
    const page1 = await todayService.getTodayFeed({ userId: USER_A, timezone: 'UTC', limit: 3, now: NOW });

    assert.deepEqual(page1.sections.map((section) => section.key), todayService.SECTION_ORDER.slice(0, 3));
    assert.ok(page1.meta.nextCursor);

    const page2 = await todayService.getTodayFeed({
      userId: USER_A,
      timezone: 'UTC',
      limit: 3,
      cursor: page1.meta.nextCursor,
      now: NOW
    });

    assert.deepEqual(page2.sections.map((section) => section.key), todayService.SECTION_ORDER.slice(3, 6));
  } finally {
    restore();
  }
});

test('a malformed Today cursor is rejected', () => {
  assert.equal(todayService.decodeCursor(null), 0);
  assert.equal(todayService.decodeCursor(''), 0);
  assert.throws(() => todayService.decodeCursor('!!!not-base64'), (error) => error.code === 'INVALID_CURSOR');
  assert.throws(
    () => todayService.decodeCursor(Buffer.from('{"v":9,"s":1}', 'utf8').toString('base64url')),
    (error) => error.code === 'INVALID_CURSOR'
  );
});

// ---------------------------------------------------------------------------
// Product events
// ---------------------------------------------------------------------------

test('every required product event code is allowlisted', () => {
  for (const code of [
    'quick_add_preview',
    'quick_add_confirm',
    'play_compass_submit',
    'play_compass_select',
    'play_session_create',
    'game_dna_view',
    'replay_view',
    'replay_share',
    'article_impression',
    'article_action'
  ]) {
    assert.ok(PRODUCT_EVENT_CODES.includes(code), `${code} must be allowlisted`);
  }
});

test('an unknown event code is refused', () => {
  assert.throws(
    () => productEventService.sanitizeEventProperties('not_a_real_code', {}),
    (error) => error.statusCode === 400 && error.code === 'UNKNOWN_PRODUCT_EVENT_CODE'
  );
});

test('raw queries, notes, URLs, provider bodies and prompts are dropped from event properties', () => {
  const hostile = {
    // Every one of these is an undeclared key and must be dropped.
    rawQuery: 'hollow knight like games but cheaper',
    note: 'the final boss lore twist ruined my evening',
    searchQuery: 'my private search',
    url: 'https://store.steampowered.com/app/367520/?utm_source=secret',
    providerBody: '{"api_key":"sk-live-abc"}',
    prompt: 'ignore previous instructions',
    email: 'someone@example.invalid',
    // Declared keys with the wrong shape must also be dropped.
    candidateCount: 'three',
    aiUsed: 'yes',
    // A declared, well-shaped key survives.
    inputType: 'TEXT'
  };

  const { accepted, rejectedKeys } = productEventService.sanitizeEventProperties('quick_add_preview', hostile);

  assert.deepEqual(accepted, { inputType: 'TEXT' });

  for (const key of ['rawQuery', 'note', 'searchQuery', 'url', 'providerBody', 'prompt', 'email', 'candidateCount', 'aiUsed']) {
    assert.ok(rejectedKeys.includes(key), `${key} must be rejected`);
  }

  const serialized = JSON.stringify(accepted);
  assert.equal(serialized.includes('hollow knight'), false);
  assert.equal(serialized.includes('final boss'), false);
  assert.equal(serialized.includes('sk-live-abc'), false);
  assert.equal(serialized.includes('utm_source'), false);
});

test('event property shapes enforce ranges, enums and code patterns', () => {
  assert.deepEqual(
    productEventService.sanitizeEventProperties('play_compass_select', {
      rank: 2,
      reasonCode: 'fits_available_time',
      confidence: 'HIGH'
    }).accepted,
    { rank: 2, reasonCode: 'fits_available_time', confidence: 'HIGH' }
  );

  // rank is bounded to the maximum number of recommendations.
  assert.deepEqual(productEventService.sanitizeEventProperties('play_compass_select', { rank: 9 }).rejectedKeys, ['rank']);
  assert.deepEqual(productEventService.sanitizeEventProperties('play_compass_select', { confidence: 'VERY_HIGH' }).rejectedKeys, ['confidence']);
  // A "code" must look like a slug, so a sentence or a URL cannot pass as one.
  assert.deepEqual(
    productEventService.sanitizeEventProperties('play_compass_select', { reasonCode: 'a whole sentence with spaces' }).rejectedKeys,
    ['reasonCode']
  );
  assert.deepEqual(
    productEventService.sanitizeEventProperties('article_action', { articleSlug: 'https://evil.test/?q=secret' }).rejectedKeys,
    ['articleSlug']
  );
  assert.deepEqual(
    productEventService.sanitizeEventProperties('article_action', { articleSlug: 'a-real-slug', action: 'open', placement: 'today_editorial' }).accepted,
    { articleSlug: 'a-real-slug', action: 'open', placement: 'today_editorial' }
  );
});

test('a replayed eventId is reported as a duplicate instead of counted twice', async () => {
  const seen = new Set();
  const logs = captureLogs();
  const restore = stubPrisma({
    productEvent: {
      create: async ({ data }) => {
        if (seen.has(data.eventId)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['event_id'] }
          });
        }

        seen.add(data.eventId);
        return { id: 'row-1' };
      }
    }
  });

  try {
    const events = [
      { eventId: 'evt-0001', eventCode: 'game_dna_view', occurredAt: NOW, properties: { confidence: 'HIGH' } },
      { eventId: 'evt-0001', eventCode: 'game_dna_view', occurredAt: NOW, properties: { confidence: 'HIGH' } },
      { eventId: 'evt-0002', eventCode: 'replay_view', occurredAt: NOW, properties: { isEmpty: false } }
    ];

    const result = await productEventService.recordProductEvents({ userId: USER_A, events });

    assert.equal(result.acceptedCount, 2);
    assert.equal(result.duplicateCount, 1);
    assert.deepEqual(result.results.map((row) => row.status), ['recorded', 'duplicate', 'recorded']);
    // Only counts are logged.
    assert.match(logs.serialize(), /"acceptedCount":2/);
    assert.match(logs.serialize(), /"duplicateCount":1/);
  } finally {
    logs.restore();
    restore();
  }
});

test('a stored event row carries only allowlisted properties', async () => {
  const stored = [];
  const restore = stubPrisma({
    productEvent: {
      create: async ({ data }) => {
        stored.push(data);
        return { id: 'row-1' };
      }
    }
  });

  try {
    await productEventService.recordProductEvents({
      userId: USER_A,
      events: [{
        eventId: 'evt-0003',
        eventCode: 'article_impression',
        occurredAt: NOW,
        properties: { placement: 'today_editorial', position: 2, articleSlug: 'a-slug', secretNote: 'do not store me' }
      }]
    });

    assert.deepEqual(stored[0].properties, { placement: 'today_editorial', position: 2, articleSlug: 'a-slug' });
    assert.equal(JSON.stringify(stored[0]).includes('do not store me'), false);
  } finally {
    restore();
  }
});
