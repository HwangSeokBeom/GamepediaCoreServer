const test = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const {
  CATALOG_GAME_A,
  CATALOG_GAME_B,
  USER_A,
  USER_B,
  captureLogs,
  prisma,
  stubArticleLock,
  stubPrisma,
  stubQueryRaw,
  stubTransaction
} = require('./helpers/test-env');

// Regressions for the defects found by the independent review. Every test in this
// file fails against the pre-fix implementation.

const todayService = require('../../src/modules/feed/today.service');
const playCompassService = require('../../src/modules/play/play-compass.service');
const playlogService = require('../../src/modules/play/playlog.service');
const articleService = require('../../src/modules/feed/article.service');
const catalogDualWriteService = require('../../src/modules/catalog/catalog-dual-write.service');
const { buildFriendActivityVisibilityClauses } = require('../../src/modules/user/user-activity.service');

const NOW = new Date('2026-07-30T12:00:00.000Z');
const FRIEND_PUBLIC = '00000000-0000-4000-8000-0000000000f1';
const FRIEND_NO_RECENT = '00000000-0000-4000-8000-0000000000f2';
const FRIEND_NO_LIKED = '00000000-0000-4000-8000-0000000000f3';
const FRIEND_NO_REVIEWS = '00000000-0000-4000-8000-0000000000f4';
const FRIEND_ALL_FALSE = '00000000-0000-4000-8000-0000000000f5';
const FRIEND_NO_ROW = '00000000-0000-4000-8000-0000000000f6';

// ===========================================================================
// A. Today friend-activity privacy
// ===========================================================================

const PRIVACY_ROWS = [
  { userId: FRIEND_PUBLIC, showLikedGames: true, showRecentlyPlayed: true, showReviews: true },
  { userId: FRIEND_NO_RECENT, showLikedGames: true, showRecentlyPlayed: false, showReviews: true },
  { userId: FRIEND_NO_LIKED, showLikedGames: false, showRecentlyPlayed: true, showReviews: true },
  { userId: FRIEND_NO_REVIEWS, showLikedGames: true, showRecentlyPlayed: true, showReviews: false },
  { userId: FRIEND_ALL_FALSE, showLikedGames: false, showRecentlyPlayed: false, showReviews: false }
  // FRIEND_NO_ROW deliberately has no settings row at all.
];

const ALL_FRIENDS = [
  FRIEND_PUBLIC, FRIEND_NO_RECENT, FRIEND_NO_LIKED, FRIEND_NO_REVIEWS, FRIEND_ALL_FALSE, FRIEND_NO_ROW
];

function stubFriendActivity({ events = [], friendIds = ALL_FRIENDS, privacyRows = PRIVACY_ROWS } = {}) {
  const captured = {};

  return {
    captured,
    restore: stubPrisma({
      friendship: {
        findMany: async () => friendIds.map((friendUserId) => ({ friendUserId }))
      },
      userPrivacySettings: {
        findMany: async (args) => {
          captured.privacyWhere = args.where;
          captured.privacySelect = args.select;
          return privacyRows.filter((row) => friendIds.includes(row.userId));
        }
      },
      userActivityEvent: {
        findMany: async (args) => {
          captured.activityWhere = args.where;
          return events;
        }
      }
    })
  };
}

/// Evaluates the clause set the section will send to the database, so a test can
/// assert exactly which (friend, activityType) pairs are permitted.
function isPermitted(clauses, actorUserId, activityType) {
  return clauses.some((clause) => {
    if (!clause.actorUserId.in.includes(actorUserId)) {
      return false;
    }

    return clause.activityType === undefined || clause.activityType.in.includes(activityType);
  });
}

test('the Today privacy query reads every settings row, not only the visible ones', async () => {
  const stub = stubFriendActivity();

  try {
    await todayService.getTodayFeed({ userId: USER_A, timezone: 'UTC', now: NOW, limit: 8 });
  } finally {
    stub.restore();
  }

  // The pre-fix query filtered on showRecentlyPlayed = true and then derived
  // "has a settings row" from that same filtered result, which made an explicit
  // false indistinguishable from an absent row.
  assert.deepEqual(Object.keys(stub.captured.privacyWhere), ['userId']);
  assert.equal(stub.captured.privacyWhere.showRecentlyPlayed, undefined);
  assert.equal(stub.captured.privacySelect.showLikedGames, true);
  assert.equal(stub.captured.privacySelect.showRecentlyPlayed, true);
  assert.equal(stub.captured.privacySelect.showReviews, true);
});

test('explicit privacy false is honoured for every activity type', () => {
  const privacyMap = new Map(PRIVACY_ROWS.map((row) => [row.userId, row]));
  const clauses = buildFriendActivityVisibilityClauses(ALL_FRIENDS, privacyMap);

  // Table-driven over every activity type the enum defines.
  const expectations = [
    // friend, activityType, permitted
    [FRIEND_PUBLIC, 'PLAY_STATUS_CHANGED', true],
    [FRIEND_PUBLIC, 'STEAM_RECENTLY_PLAYED_SYNC', true],
    [FRIEND_PUBLIC, 'LIKED_GAME_ADDED', true],
    [FRIEND_PUBLIC, 'REVIEW_CREATED', true],

    // showRecentlyPlayed = false: play activity hidden, the rest still visible.
    [FRIEND_NO_RECENT, 'PLAY_STATUS_CHANGED', false],
    [FRIEND_NO_RECENT, 'STEAM_RECENTLY_PLAYED_SYNC', false],
    [FRIEND_NO_RECENT, 'LIKED_GAME_ADDED', true],
    [FRIEND_NO_RECENT, 'REVIEW_CREATED', true],

    // showLikedGames = false but recent = true.
    [FRIEND_NO_LIKED, 'LIKED_GAME_ADDED', false],
    [FRIEND_NO_LIKED, 'LIKED_GAME_REMOVED', false],
    [FRIEND_NO_LIKED, 'PLAY_STATUS_CHANGED', true],
    [FRIEND_NO_LIKED, 'REVIEW_CREATED', true],

    // showReviews = false but liked = true.
    [FRIEND_NO_REVIEWS, 'REVIEW_CREATED', false],
    [FRIEND_NO_REVIEWS, 'REVIEW_UPDATED', false],
    [FRIEND_NO_REVIEWS, 'RATING_CHANGED', false],
    [FRIEND_NO_REVIEWS, 'LIKED_GAME_ADDED', true],

    // Everything false: no clause at all.
    [FRIEND_ALL_FALSE, 'PLAY_STATUS_CHANGED', false],
    [FRIEND_ALL_FALSE, 'LIKED_GAME_ADDED', false],
    [FRIEND_ALL_FALSE, 'REVIEW_CREATED', false],

    // No settings row: the shipped default is visible.
    [FRIEND_NO_ROW, 'PLAY_STATUS_CHANGED', true],
    [FRIEND_NO_ROW, 'LIKED_GAME_ADDED', true],
    [FRIEND_NO_ROW, 'REVIEW_CREATED', true]
  ];

  for (const [friendUserId, activityType, permitted] of expectations) {
    assert.equal(
      isPermitted(clauses, friendUserId, activityType),
      permitted,
      `${friendUserId} / ${activityType} should be ${permitted ? 'visible' : 'hidden'}`
    );
  }

  // A friend whose settings hide everything produces no clause at all.
  assert.equal(
    clauses.some((clause) => clause.actorUserId.in.includes(FRIEND_ALL_FALSE)),
    false,
    'a fully private friend must not appear in any clause'
  );
});

test('the Today section applies the privacy clauses in the database query', async () => {
  const stub = stubFriendActivity();

  try {
    await todayService.getTodayFeed({ userId: USER_A, timezone: 'UTC', now: NOW, limit: 8 });
  } finally {
    stub.restore();
  }

  const where = stub.captured.activityWhere;

  assert.ok(Array.isArray(where.OR), 'privacy must be enforced by the query, not after a bounded page');
  assert.equal(where.isVisible, true, 'hidden events must stay hidden');
  // The fully private friend must not be reachable through any clause.
  assert.equal(
    where.OR.some((clause) => clause.actorUserId.in.includes(FRIEND_ALL_FALSE)),
    false
  );
  // A partially restricted friend appears with an explicit activityType filter.
  const restricted = where.OR.find((clause) => clause.actorUserId.in.includes(FRIEND_NO_RECENT));
  assert.ok(restricted.activityType, 'a partially restricted friend needs an activityType filter');
  assert.equal(restricted.activityType.in.includes('PLAY_STATUS_CHANGED'), false);
});

test('a page emptied by privacy is reported distinctly from no activity', async () => {
  const allPrivate = stubFriendActivity({
    friendIds: [FRIEND_ALL_FALSE],
    privacyRows: [{ userId: FRIEND_ALL_FALSE, showLikedGames: false, showRecentlyPlayed: false, showReviews: false }]
  });
  let feed;

  try {
    feed = await todayService.getTodayFeed({ userId: USER_A, timezone: 'UTC', now: NOW, limit: 8 });
  } finally {
    allPrivate.restore();
  }

  const section = feed.sections.find((entry) => entry.key === 'friendActivity');
  assert.equal(section.status, 'ok');
  assert.equal(section.data.emptyReason, 'friend_activity_hidden_by_privacy');

  const partial = stubFriendActivity({ events: [] });
  let partialFeed;

  try {
    partialFeed = await todayService.getTodayFeed({ userId: USER_A, timezone: 'UTC', now: NOW, limit: 8 });
  } finally {
    partial.restore();
  }

  const partialSection = partialFeed.sections.find((entry) => entry.key === 'friendActivity');
  assert.equal(
    partialSection.data.emptyReason,
    'friend_activity_partially_hidden_by_privacy',
    'some friends were restricted, so the empty page is explained precisely'
  );
});

// ===========================================================================
// B. New Steam sync rows are canonically usable
// ===========================================================================

test('a trusted Steam sync links every row and reports a linked status', async () => {
  const libraryUpdates = [];
  const restoreTransaction = stubTransaction();
  const restoreQueryRaw = stubQueryRaw(() => [{ id: 'identity-1' }]);
  const restore = stubPrisma({
    gameExternalIdentity: { findUnique: async () => null },
    gameLocalization: { create: async () => ({ id: 'localization-1' }) },
    catalogGame: { create: async () => ({ id: CATALOG_GAME_A }) },
    userGameLibrary: {
      update: async ({ where, data }) => {
        libraryUpdates.push({ id: where.id, ...data });
        return { id: where.id };
      }
    }
  });

  try {
    const result = await catalogDualWriteService.linkVerifiedSteamOwnership({
      entries: [
        { libraryEntryId: 'row-1', externalGameId: '367520', gameName: 'Hollow Knight' },
        { libraryEntryId: 'row-2', externalGameId: '620', gameName: 'Portal 2' }
      ],
      now: NOW
    });

    assert.equal(result.canonicalLinkStatus, 'linked');
    assert.equal(result.canonicalLinkedCount, 2);
    assert.equal(result.canonicalPendingCount, 0);
    // Every synced row is immediately usable by Play Compass and Today.
    assert.equal(libraryUpdates.length, 2);
    assert.equal(libraryUpdates[0].catalogGameId, CATALOG_GAME_A);
    // Only a real provider response may claim PROVIDER_VERIFIED ownership.
    assert.equal(libraryUpdates[0].ownershipProvenance, 'PROVIDER_VERIFIED');
  } finally {
    restore();
    restoreQueryRaw();
    restoreTransaction();
  }
});

test('a Steam sync entry is atomic: an identity failure leaves no linked library row', async () => {
  // Round-2 finding B. The catalog game create and the identity insert used to be
  // independent statements, so a non-P2002 identity failure left a published orphan
  // game behind and the retry created a second one. They are one transaction now,
  // and the library update joins it.
  const libraryUpdates = [];
  let transactionRollbacks = 0;
  const original = prisma.$transaction;

  // A transaction stand-in that actually discards the writes of a failed callback.
  prisma.$transaction = async (arg) => {
    if (typeof arg !== 'function') {
      return Promise.all(arg);
    }

    const staged = [];

    try {
      return await arg(new Proxy(prisma, {
        get(target, property) {
          if (property === 'userGameLibrary') {
            return {
              update: async ({ where, data }) => {
                staged.push({ id: where.id, ...data });
                return { id: where.id };
              }
            };
          }

          return target[property];
        }
      }));
    } catch (error) {
      transactionRollbacks += 1;
      throw error;
    } finally {
      if (transactionRollbacks === 0) {
        libraryUpdates.push(...staged);
      }
    }
  };

  const restoreQueryRaw = stubQueryRaw(() => {
    throw new Error('identity insert failed for a reason that is not a unique violation');
  });
  const restore = stubPrisma({
    gameExternalIdentity: { findUnique: async () => null },
    gameLocalization: { create: async () => ({ id: 'localization-1' }) },
    catalogGame: { create: async () => ({ id: CATALOG_GAME_A }) }
  });

  try {
    const result = await catalogDualWriteService.linkVerifiedSteamOwnership({
      entries: [{ libraryEntryId: 'row-1', externalGameId: '367520', gameName: 'Hollow Knight' }],
      now: NOW
    });

    assert.equal(result.canonicalLinkStatus, 'unavailable');
    assert.equal(result.canonicalPendingCount, 1);
    assert.equal(transactionRollbacks, 1, 'the failure must abort the whole entry, not part of it');
    assert.deepEqual(libraryUpdates, [],
      'a rolled-back entry must not leave a library row pointing at an orphan game');
  } finally {
    restore();
    restoreQueryRaw();
    prisma.$transaction = original;
  }
});

test('a Steam sync that cannot link reports degraded instead of a silent success', async () => {
  const logs = captureLogs();
  const restore = stubPrisma({
    gameExternalIdentity: {
      findUnique: async () => {
        throw new Error('catalog unavailable');
      }
    }
  });

  try {
    const result = await catalogDualWriteService.linkVerifiedSteamOwnership({
      entries: [{ libraryEntryId: 'row-1', externalGameId: '367520', gameName: 'Hollow Knight' }],
      now: NOW
    });

    // The pre-fix behavior swallowed the failure and reported success, leaving the
    // row invisible to every Product 2.2 feature with no signal at all.
    assert.equal(result.canonicalLinkStatus, 'unavailable');
    assert.equal(result.canonicalLinkedCount, 0);
    assert.equal(result.canonicalPendingCount, 1);
    assert.ok(result.canonicalFailureReasonCodes.length > 0);
    assert.match(logs.serialize(), /catalog-steam-ownership-link/);
    // Reason codes only, never a raw error string.
    assert.equal(logs.serialize().includes('catalog unavailable'), false);
  } finally {
    logs.restore();
    restore();
  }
});

test('a partially linked Steam sync is reported as partial', async () => {
  let calls = 0;
  const restoreTransaction = stubTransaction();
  const restoreQueryRaw = stubQueryRaw(() => [{ id: 'identity-1' }]);
  const restore = stubPrisma({
    gameExternalIdentity: {
      findUnique: async () => {
        calls += 1;

        if (calls === 2) {
          throw new Error('transient');
        }

        return null;
      }
    },
    gameLocalization: { create: async () => ({ id: 'localization-1' }) },
    catalogGame: { create: async () => ({ id: CATALOG_GAME_A }) },
    userGameLibrary: { update: async ({ where }) => ({ id: where.id }) }
  });

  try {
    const result = await catalogDualWriteService.linkVerifiedSteamOwnership({
      entries: [
        { libraryEntryId: 'row-1', externalGameId: '367520', gameName: 'A' },
        { libraryEntryId: 'row-2', externalGameId: '620', gameName: 'B' }
      ],
      now: NOW
    });

    assert.equal(result.canonicalLinkStatus, 'partial');
    assert.equal(result.canonicalLinkedCount, 1);
    assert.equal(result.canonicalPendingCount, 1);
  } finally {
    restore();
    restoreQueryRaw();
    restoreTransaction();
  }
});

test('the Steam sync response carries the canonical link outcome', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/library/library.service.js'), 'utf8');

  // The sync must not be able to return a success that hides an unlinked row.
  assert.match(source, /canonicalLinkStatus: canonicalLink\.canonicalLinkStatus/);
  assert.match(source, /canonicalPendingCount: canonicalLink\.canonicalPendingCount/);
  assert.match(source, /linkVerifiedSteamOwnership\(\{/);
});

// ===========================================================================
// C. User input is never promoted to public / provider verified
// ===========================================================================

test('a manual library write records USER_CONFIRMED ownership, whatever gameSource says', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/library/library.service.js'), 'utf8');
  const writeData = source.slice(source.indexOf('function buildLibraryEntryWriteData('));

  // A client can put gameSource: 'STEAM' on a manual write, so the manual path
  // must never mint PROVIDER_VERIFIED ownership.
  assert.match(writeData, /ownershipProvenance: existingEntry\?\.ownershipProvenance === OWNERSHIP_PROVENANCE\.PROVIDER_VERIFIED/);
  assert.match(writeData, /: OWNERSHIP_PROVENANCE\.USER_CONFIRMED/);
});

test('ownership evidence reads stored provenance instead of inferring it from gameSource', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/play/play-compass.service.js'), 'utf8');

  assert.match(source, /provenance: entry\.ownershipProvenance \?\? 'UNKNOWN'/);
  // The pre-fix inference is gone.
  assert.equal(
    source.includes("entry.gameSource === 'STEAM' ? 'PROVIDER_VERIFIED' : 'USER_CONFIRMED'"),
    false,
    'ownership provenance must not be inferred from gameSource'
  );

  const today = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/feed/today.service.js'), 'utf8');
  assert.match(today, /ownershipProvenance: entry\.ownershipProvenance \?\? 'UNKNOWN'/);
  assert.equal(
    today.includes("entry.gameSource === 'STEAM' ? 'PROVIDER_VERIFIED' : 'USER_CONFIRMED'"),
    false
  );
});

test('an UNKNOWN ownership row is not presented as provider verified', () => {
  const evidence = playCompassService.buildOwnershipEvidence({
    gameSource: 'STEAM',
    externalGameId: '367520',
    status: 'PLAYING',
    ownershipProvenance: 'UNKNOWN',
    playtimeMinutes: 100,
    lastPlayedAt: NOW
  });

  assert.equal(evidence.provenance, 'UNKNOWN');
  assert.equal(evidence.ownershipVerified, false);

  const verified = playCompassService.buildOwnershipEvidence({
    gameSource: 'STEAM',
    externalGameId: '367520',
    status: 'PLAYING',
    ownershipProvenance: 'PROVIDER_VERIFIED',
    playtimeMinutes: 100,
    lastPlayedAt: NOW
  });

  assert.equal(verified.ownershipVerified, true);
});

// ===========================================================================
// D. Cross-account PRIVATE catalog metadata must not leak
// ===========================================================================

test('Play Compass never reads another account PRIVATE catalog game', async () => {
  let capturedWhere = null;
  const restore = stubPrisma({
    userGameLibrary: {
      findMany: async () => [{
        catalogGameId: CATALOG_GAME_A,
        status: 'PLAYING',
        gameSource: 'STEAM',
        externalGameId: '367520',
        ownershipProvenance: 'PROVIDER_VERIFIED',
        playtimeMinutes: 100,
        lastPlayedAt: NOW,
        updatedAt: NOW
      }]
    },
    catalogGame: {
      findMany: async (args) => {
        capturedWhere = args.where;
        return [];
      }
    },
    playSession: { findMany: async () => [] },
    playCompassEvent: { findMany: async () => [] }
  });

  try {
    await playCompassService.recommend({
      userId: USER_B,
      request: {
        availableMinutes: 60,
        mood: null,
        energy: 'MEDIUM',
        soloOrParty: 'EITHER',
        continueOrStart: 'EITHER',
        availablePlatforms: [],
        friendUserIds: []
      },
      now: NOW
    });

    // Without this filter, a quick-add claim could bind one account's library row
    // to another account's PRIVATE game and leak its title and metadata.
    assert.equal(capturedWhere.mergedIntoCatalogGameId, null);
    assert.deepEqual(capturedWhere.OR, [
      { publicationStatus: 'PUBLISHED' },
      { createdByUserId: USER_B }
    ]);
  } finally {
    restore();
  }
});

test('the Today briefing and start guide also scope catalog reads by visibility', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/feed/today.service.js'), 'utf8');
  const visibilityClauses = source.match(/OR: \[\{ publicationStatus: 'PUBLISHED' \}, \{ createdByUserId: userId \}\]/g) ?? [];

  // The briefing section and the start-guide section both read catalog metadata.
  assert.ok(visibilityClauses.length >= 2, `expected at least 2 visibility clauses, found ${visibilityClauses.length}`);
});

// ===========================================================================
// F. Playlog canonical resolution, release coherence, atomic receipts
// ===========================================================================

function stubPlaylogUpdate({ existing, catalogGames, releases = [], receipt = null }) {
  const captured = {};

  return {
    captured,
    restore: stubPrisma({
      playSession: {
        findFirst: async () => existing,
        update: async ({ data }) => {
          captured.updateData = data;
          return { ...existing, ...data, ...{
            playedAt: existing.playedAt ?? NOW,
            createdAt: NOW,
            updatedAt: NOW,
            outcome: data.outcome ?? 'CONTINUE',
            visibility: data.visibility ?? 'PRIVATE',
            provenance: 'USER_CONFIRMED',
            clientMutationId: 'x'.repeat(10),
            durationMinutes: null,
            progressPercent: null,
            mood: null,
            note: null
          } };
        }
      },
      catalogGame: {
        findUnique: async ({ where }) => catalogGames[where.id] ?? null,
        findFirst: async ({ where }) => (catalogGames[where.id] ? { id: where.id } : null)
      },
      regionalRelease: {
        findFirst: async ({ where }) => releases.find(
          (release) => release.id === where.id && release.catalogGameId === where.catalogGameId
        ) ?? null
      },
      ...(receipt ? { clientMutationReceipt: receipt } : {})
    })
  };
}

test('an update with a tombstone id stores the canonical survivor id', async () => {
  const restoreTransaction = stubTransaction();
  const stub = stubPlaylogUpdate({
    existing: { id: 'session-1', catalogGameId: CATALOG_GAME_A, regionalReleaseId: null, playedAt: NOW },
    catalogGames: {
      // CATALOG_GAME_B is a tombstone pointing at CATALOG_GAME_A.
      [CATALOG_GAME_B]: { id: CATALOG_GAME_B, mergedIntoCatalogGameId: CATALOG_GAME_A },
      [CATALOG_GAME_A]: { id: CATALOG_GAME_A, mergedIntoCatalogGameId: null }
    }
  });

  try {
    await playlogService.updatePlaySession({
      userId: USER_A,
      sessionId: 'session-1',
      patch: { catalogGameId: CATALOG_GAME_B }
    });

    // The pre-fix code discarded the resolved canonical id and stored the requested
    // one, leaving a session pointing at a merge tombstone.
    assert.equal(stub.captured.updateData.catalogGameId, undefined,
      'resolving the tombstone lands on the existing canonical id, so no change is written');
  } finally {
    stub.restore();
    restoreTransaction();
  }
});

test('moving a session to another game clears a release that belonged to the old game', async () => {
  const restoreTransaction = stubTransaction();
  const stub = stubPlaylogUpdate({
    existing: {
      id: 'session-1',
      catalogGameId: CATALOG_GAME_A,
      regionalReleaseId: 'release-a',
      playedAt: NOW
    },
    catalogGames: {
      [CATALOG_GAME_A]: { id: CATALOG_GAME_A, mergedIntoCatalogGameId: null },
      [CATALOG_GAME_B]: { id: CATALOG_GAME_B, mergedIntoCatalogGameId: null }
    },
    releases: [{ id: 'release-a', catalogGameId: CATALOG_GAME_A }]
  });

  try {
    await playlogService.updatePlaySession({
      userId: USER_A,
      sessionId: 'session-1',
      // Game changes, release omitted.
      patch: { catalogGameId: CATALOG_GAME_B }
    });

    assert.equal(stub.captured.updateData.catalogGameId, CATALOG_GAME_B);
    // Previously the old release survived, leaving a session whose release belonged
    // to a different canonical game.
    assert.equal(stub.captured.updateData.regionalReleaseId, null);
  } finally {
    stub.restore();
    restoreTransaction();
  }
});

test('a release from a different game is rejected on update', async () => {
  const restoreTransaction = stubTransaction();
  const stub = stubPlaylogUpdate({
    existing: { id: 'session-1', catalogGameId: CATALOG_GAME_A, regionalReleaseId: null, playedAt: NOW },
    catalogGames: {
      [CATALOG_GAME_A]: { id: CATALOG_GAME_A, mergedIntoCatalogGameId: null },
      [CATALOG_GAME_B]: { id: CATALOG_GAME_B, mergedIntoCatalogGameId: null }
    },
    releases: [{ id: 'release-a', catalogGameId: CATALOG_GAME_A }]
  });

  try {
    await assert.rejects(
      playlogService.updatePlaySession({
        userId: USER_A,
        sessionId: 'session-1',
        patch: { catalogGameId: CATALOG_GAME_B, regionalReleaseId: 'release-a' }
      }),
      (error) => error.statusCode === 400 && error.code === 'REGIONAL_RELEASE_MISMATCH'
    );
  } finally {
    stub.restore();
    restoreTransaction();
  }
});

test('a failed mutation rolls the idempotency receipt back with it', async () => {
  // The receipt and the mutation now share one transaction, so a receipt can only
  // survive if the mutation it describes committed.
  const receiptWrites = [];
  const restoreQueryRaw = stubQueryRaw((sql) => {
    if (sql.includes('client_mutation_receipts')) {
      receiptWrites.push(sql);
      // The claim insert wins.
      return [{ id: 'receipt-1' }];
    }

    return [];
  });
  const restore = stubPrisma({
    playSession: { deleteMany: async () => ({ count: 0 }) }
  });
  const { prisma } = require('./helpers/test-env');
  const originalTransaction = prisma.$transaction;
  let rolledBack = false;

  prisma.$transaction = async (callback) => {
    const before = receiptWrites.length;

    try {
      return await callback(prisma);
    } catch (error) {
      // Simulate the rollback the real transaction performs.
      receiptWrites.length = before;
      rolledBack = true;
      throw error;
    }
  };

  try {
    await assert.rejects(
      playlogService.deletePlaySession({
        userId: USER_A,
        sessionId: 'missing-session',
        clientMutationId: 'mutation-abcdefgh'
      }),
      (error) => error.statusCode === 404
    );

    assert.equal(rolledBack, true);
    assert.equal(receiptWrites.length, 0,
      'a receipt must not outlive the mutation it claims to describe');
  } finally {
    prisma.$transaction = originalTransaction;
    restore();
    restoreQueryRaw();
  }
});

test('the receipt claim uses ON CONFLICT so a transaction is never aborted', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/play/playlog.service.js'), 'utf8');

  // Catching a unique violation inside a PostgreSQL transaction aborts the whole
  // transaction (SQLSTATE 25P02), so the follow-up read could never run and every
  // concurrent retry failed opaquely.
  assert.match(source, /ON CONFLICT \("user_id", "scope", "client_mutation_id"\) DO NOTHING/);

  const identity = fs.readFileSync(
    path.resolve(process.cwd(), 'src/modules/catalog/catalog-identity.service.js'),
    'utf8'
  );
  assert.match(identity, /ON CONFLICT \("catalog_game_id", "provider", "external_id", "region_key"\) DO NOTHING/);
});

test('reusing one clientMutationId for a different session is a conflict, not a silent success', async () => {
  const restoreTransaction = stubTransaction();
  // The claim insert conflicts, so zero rows come back.
  const restoreQueryRaw = stubQueryRaw(() => []);
  const restore = stubPrisma({
    clientMutationReceipt: {
      // The key was first used for a different session.
      findUnique: async () => ({ resourceId: 'session-other' })
    },
    playSession: { deleteMany: async () => ({ count: 1 }) }
  });

  try {
    await assert.rejects(
      playlogService.deletePlaySession({
        userId: USER_A,
        sessionId: 'session-1',
        clientMutationId: 'mutation-abcdefgh'
      }),
      (error) => error.statusCode === 409 && error.code === 'CLIENT_MUTATION_ID_REUSED'
    );
  } finally {
    restore();
    restoreQueryRaw();
    restoreTransaction();
  }
});

test('a genuine replay of the same session returns the committed outcome', async () => {
  const restoreTransaction = stubTransaction();
  const restoreQueryRaw = stubQueryRaw(() => []);
  let deleteCalls = 0;
  const restore = stubPrisma({
    clientMutationReceipt: {
      findUnique: async () => ({ resourceId: 'session-1' })
    },
    playSession: {
      deleteMany: async () => {
        deleteCalls += 1;
        return { count: 1 };
      }
    }
  });

  try {
    const result = await playlogService.deletePlaySession({
      userId: USER_A,
      sessionId: 'session-1',
      clientMutationId: 'mutation-abcdefgh'
    });

    assert.equal(result.idempotentReplay, true);
    assert.equal(result.deleted, false);
    assert.equal(deleteCalls, 0, 'a replay must not reach the delete again');
  } finally {
    restore();
    restoreQueryRaw();
    restoreTransaction();
  }
});

// ===========================================================================
// H. Magazine body and correction audit
// ===========================================================================

/// Stubs everything one editorial mutation touches, including the row lock and the
/// in-transaction role read that round-2 finding C added.
function stubArticle({ existing, previousRevision, captured = {}, roles = [{ role: 'EDITOR' }] }) {
  const lock = stubArticleLock(existing?.id ?? 'a-1');
  const restorePrisma = stubPrisma({
      userRoleAssignment: { findMany: async () => roles },
      editorialArticle: {
        findUnique: async () => existing,
        update: async ({ data }) => {
          captured.articleUpdates = [...(captured.articleUpdates ?? []), data];
          return { id: 'a-1' };
        },
        findFirst: async () => existing
      },
      articleRevision: {
        findFirst: async () => previousRevision,
        create: async ({ data }) => {
          captured.revisionData = data;
          return { id: 'rev-new', revisionNumber: data.revisionNumber };
        }
      },
      articleSource: { upsert: async () => ({ id: 's-1' }) },
      articleGameLink: { upsert: async () => ({ id: 'l-1' }) },
      articleAsset: { upsert: async () => ({ id: 'as-1' }) }
  });

  return {
    captured,
    lock,
    restore() {
      restorePrisma();
      lock.restore();
    }
  };
}

test('an update that omits the body carries the previous body forward', async () => {
  const restoreTransaction = stubTransaction();
  const stub = stubArticle({
    existing: {
      id: 'a-1',
      status: 'DRAFT',
      headline: 'H',
      excerpt: 'E',
      slug: 's',
      locale: 'ko',
      publishedAt: null,
      correctedAt: null,
      retractedAt: null,
      authorUserId: USER_A,
      scheduledFor: null,
      aiDraftUsed: false,
      createdAt: NOW,
      updatedAt: NOW,
      currentRevision: null,
      sources: [],
      gameLinks: [],
      assets: []
    },
    previousRevision: { revisionNumber: 2, headline: 'H', excerpt: 'E', bodyMarkdown: '# Original body' }
  });

  try {
    await articleService.updateArticle({
      actorUserId: USER_A,
      slug: 's',
      input: { headline: 'New headline', sources: [], relatedGames: [], assets: [] },
      now: NOW
    });

    // The pre-fix code wrote bodyMarkdown: null whenever the input omitted it,
    // silently discarding the article text.
    assert.equal(stub.captured.revisionData.bodyMarkdown, '# Original body');
    assert.equal(stub.captured.revisionData.revisionNumber, 3);
    // The new revision becomes the current one.
    assert.ok(stub.captured.articleUpdates.some((update) => update.currentRevisionId === 'rev-new'));
  } finally {
    stub.restore();
    restoreTransaction();
  }
});

test('an explicit null body clears it, so omission and clearing stay distinguishable', async () => {
  const restoreTransaction = stubTransaction();
  const stub = stubArticle({
    existing: {
      id: 'a-1', status: 'DRAFT', headline: 'H', excerpt: 'E', slug: 's', locale: 'ko',
      publishedAt: null, correctedAt: null, retractedAt: null, authorUserId: USER_A,
      scheduledFor: null, aiDraftUsed: false, createdAt: NOW, updatedAt: NOW,
      currentRevision: null, sources: [], gameLinks: [], assets: []
    },
    previousRevision: { revisionNumber: 1, headline: 'H', excerpt: 'E', bodyMarkdown: '# Original body' }
  });

  try {
    await articleService.updateArticle({
      actorUserId: USER_A,
      slug: 's',
      input: { bodyMarkdown: null, sources: [], relatedGames: [], assets: [] },
      now: NOW
    });

    assert.equal(stub.captured.revisionData.bodyMarkdown, null);
  } finally {
    stub.restore();
    restoreTransaction();
  }
});

test('publishing carries the reviewed body into the published revision', async () => {
  const restoreTransaction = stubTransaction();
  const lock = stubArticleLock('a-1');
  const captured = {};
  const restore = stubPrisma({
    userRoleAssignment: { findMany: async () => [{ role: 'EDITOR' }] },
    editorialArticle: {
      findUnique: async () => ({
        id: 'a-1', slug: 's', status: 'SCHEDULED', locale: 'ko', headline: 'H', excerpt: 'E',
        publishedAt: null, correctedAt: null, retractedAt: null, authorUserId: USER_A,
        scheduledFor: null, aiDraftUsed: false, createdAt: NOW, updatedAt: NOW,
        // The reviewed body lives on the current revision, which is what publish
        // re-validates before it commits.
        currentRevision: {
          revisionNumber: 3,
          status: 'SCHEDULED',
          bodyMarkdown: '# Reviewed body',
          changeNote: null,
          aiDraft: false,
          createdAt: NOW
        },
        sources: [], gameLinks: [], assets: []
      }),
      update: async () => ({ id: 'a-1' })
    },
    articleRevision: {
      findFirst: async () => ({ revisionNumber: 3, headline: 'H', excerpt: 'E', bodyMarkdown: '# Reviewed body' }),
      create: async ({ data }) => {
        captured.revisionData = data;
        return { id: 'rev-4', revisionNumber: 4 };
      }
    }
  });

  try {
    await articleService.publishArticle({ actorUserId: USER_A, slug: 's', now: NOW });

    // The published revision used to be created with no body at all.
    assert.equal(captured.revisionData.bodyMarkdown, '# Reviewed body');
    assert.equal(captured.revisionData.status, 'PUBLISHED');
  } finally {
    restore();
    lock.restore();
    restoreTransaction();
  }
});

test('a silent edit of published content is refused', async () => {
  const publishedArticle = {
    id: 'a-1',
    status: 'PUBLISHED',
    headline: 'H',
    excerpt: 'E',
    currentRevision: { revisionNumber: 4, bodyMarkdown: '# Body', changeNote: 'published' }
  };
  const restoreTransaction = stubTransaction();
  const lock = stubArticleLock('a-1');
  const restore = stubPrisma({
    userRoleAssignment: { findMany: async () => [{ role: 'EDITOR' }] },
    editorialArticle: { findUnique: async () => publishedArticle }
  });

  try {
    // No status: the pre-fix code applied this immediately to the live article.
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: USER_A,
        slug: 's',
        input: { headline: 'Quietly changed', sources: [], relatedGames: [], assets: [] },
        now: NOW
      }),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_CORRECTION_REQUIRED'
    );

    // CORRECTED but with no change note.
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: USER_A,
        slug: 's',
        input: { headline: 'Changed', status: 'CORRECTED', sources: [], relatedGames: [], assets: [] },
        now: NOW
      }),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_CORRECTION_NOTE_REQUIRED'
    );

    // Changing the body counts as changing published content too.
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: USER_A,
        slug: 's',
        input: { bodyMarkdown: '# rewritten', sources: [], relatedGames: [], assets: [] },
        now: NOW
      }),
      (error) => error.code === 'ARTICLE_CORRECTION_REQUIRED'
    );

    // Round-2 finding D: a status-only hop to CORRECTED wrote an audit revision for
    // a change no reader could see, with changeNote null.
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: USER_A,
        slug: 's',
        input: { status: 'CORRECTED', sources: [], relatedGames: [], assets: [] },
        now: NOW
      }),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_CORRECTION_EMPTY'
    );

    // Every rejection happened behind the row lock, not on a read taken before it.
    assert.equal(lock.lockCount, 4);
  } finally {
    restore();
    lock.restore();
    restoreTransaction();
  }
});

test('an edit racing a concurrent publish is refused as a correction, not applied silently', async () => {
  // Round-2 finding C, exactly. The editor read SCHEDULED; between that read and
  // the write another editor published. Because the status is now re-read under the
  // lock, the edit is judged against PUBLISHED and rejected.
  const restoreTransaction = stubTransaction();
  const lock = stubArticleLock('a-1');
  const captured = { revisionData: null, articleUpdates: [] };
  const restore = stubPrisma({
    userRoleAssignment: { findMany: async () => [{ role: 'EDITOR' }] },
    editorialArticle: {
      // What the lock sees: the competing publish already committed.
      findUnique: async () => ({
        id: 'a-1',
        status: 'PUBLISHED',
        headline: 'H',
        excerpt: 'E',
        currentRevision: { revisionNumber: 5, bodyMarkdown: '# Body', changeNote: 'published' }
      }),
      update: async ({ data }) => {
        captured.articleUpdates.push(data);
        return { id: 'a-1' };
      }
    },
    articleRevision: {
      findFirst: async () => ({ revisionNumber: 5, headline: 'H', excerpt: 'E', bodyMarkdown: '# Body' }),
      create: async ({ data }) => {
        captured.revisionData = data;
        return { id: 'rev-6', revisionNumber: 6 };
      }
    }
  });

  try {
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: USER_A,
        slug: 's',
        // A perfectly ordinary draft edit, prepared while the article was SCHEDULED.
        input: { headline: 'Draft-era headline', sources: [], relatedGames: [], assets: [] },
        now: NOW
      }),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_CORRECTION_REQUIRED'
    );

    assert.equal(captured.revisionData, null, 'no revision may be written for a refused edit');
    assert.deepEqual(captured.articleUpdates, [], 'the live article must be untouched');
  } finally {
    restore();
    lock.restore();
    restoreTransaction();
  }
});

test('an edit whose expectedRevisionNumber is stale is a 409, not a lost update', async () => {
  const restoreTransaction = stubTransaction();
  const lock = stubArticleLock('a-1');
  const restore = stubPrisma({
    userRoleAssignment: { findMany: async () => [{ role: 'EDITOR' }] },
    editorialArticle: {
      findUnique: async () => ({
        id: 'a-1',
        status: 'DRAFT',
        headline: 'H',
        excerpt: 'E',
        currentRevision: { revisionNumber: 7, bodyMarkdown: '# Newer body', changeNote: null }
      })
    }
  });

  try {
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: USER_A,
        slug: 's',
        input: { headline: 'Based on revision 6', expectedRevisionNumber: 6, sources: [], relatedGames: [], assets: [] },
        now: NOW
      }),
      (error) => error.statusCode === 409 && error.code === 'ARTICLE_CONCURRENT_MODIFICATION'
    );
  } finally {
    restore();
    lock.restore();
    restoreTransaction();
  }
});

test('an editor whose role was revoked mid-request cannot complete the edit', async () => {
  // The role is read inside the same transaction that holds the lock, so a
  // revocation that commits while the request is in flight takes effect.
  const restoreTransaction = stubTransaction();
  const lock = stubArticleLock('a-1');
  const restore = stubPrisma({
    userRoleAssignment: { findMany: async () => [] },
    editorialArticle: {
      findUnique: async () => ({
        id: 'a-1',
        status: 'DRAFT',
        headline: 'H',
        excerpt: 'E',
        currentRevision: { revisionNumber: 1, bodyMarkdown: '# Body', changeNote: null }
      })
    }
  });

  try {
    await assert.rejects(
      articleService.updateArticle({
        actorUserId: USER_B,
        slug: 's',
        input: { headline: 'Changed', sources: [], relatedGames: [], assets: [] },
        now: NOW
      }),
      (error) => error.statusCode === 403 && error.code === 'FORBIDDEN_ROLE'
    );
  } finally {
    restore();
    lock.restore();
    restoreTransaction();
  }
});

test('a proper correction sets correctedAt and records the change note', async () => {
  const restoreTransaction = stubTransaction();
  const stub = stubArticle({
    existing: {
      id: 'a-1', status: 'PUBLISHED', headline: 'H', excerpt: 'E', slug: 's', locale: 'ko',
      publishedAt: NOW, correctedAt: null, retractedAt: null, authorUserId: USER_A,
      scheduledFor: null, aiDraftUsed: false, createdAt: NOW, updatedAt: NOW,
      currentRevision: {
        revisionNumber: 4,
        status: 'PUBLISHED',
        bodyMarkdown: '# Body',
        changeNote: 'published',
        aiDraft: false,
        createdAt: NOW
      },
      sources: [], gameLinks: [], assets: []
    },
    previousRevision: { revisionNumber: 4, headline: 'H', excerpt: 'E', bodyMarkdown: '# Body' }
  });

  try {
    await articleService.updateArticle({
      actorUserId: USER_A,
      slug: 's',
      input: {
        headline: 'Corrected headline',
        status: 'CORRECTED',
        changeNote: 'Fixed the release date',
        sources: [],
        relatedGames: [],
        assets: []
      },
      now: NOW
    });

    const articleUpdate = stub.captured.articleUpdates.find((update) => update.status === 'CORRECTED');
    assert.ok(articleUpdate, 'the article must move to CORRECTED');
    assert.equal(articleUpdate.correctedAt, NOW, 'a correction must be timestamped');
    assert.equal(stub.captured.revisionData.changeNote, 'Fixed the release date');
    assert.equal(stub.captured.revisionData.status, 'CORRECTED');
    // The body survives a headline-only correction.
    assert.equal(stub.captured.revisionData.bodyMarkdown, '# Body');
  } finally {
    stub.restore();
    restoreTransaction();
  }
});

test('a retracted article is not publicly readable and a draft body is not public', () => {
  const draftRow = {
    id: 'a-1',
    slug: 's',
    status: 'DRAFT',
    locale: 'ko',
    headline: 'H',
    excerpt: 'E',
    authorUserId: USER_A,
    scheduledFor: null,
    publishedAt: null,
    correctedAt: null,
    retractedAt: null,
    aiDraftUsed: false,
    createdAt: NOW,
    updatedAt: NOW,
    currentRevision: {
      revisionNumber: 1,
      status: 'DRAFT',
      bodyMarkdown: '# Unpublished body',
      changeNote: null,
      aiDraft: false,
      createdAt: NOW
    },
    sources: [],
    gameLinks: [],
    assets: []
  };

  // Round-2 finding D. The public DTO no longer degrades an unreadable article to a
  // null body: it refuses. A nullable public body is what let OpenAPI promise a
  // non-null field the server could not deliver.
  assert.throws(
    () => articleService.mapPublicArticle(draftRow),
    (error) => error.statusCode === 404 && error.code === 'ARTICLE_NOT_FOUND'
  );

  for (const status of ['RETRACTED', 'FACT_CHECK', 'RIGHTS_REVIEW', 'SCHEDULED']) {
    assert.throws(
      () => articleService.mapPublicArticle({ ...draftRow, status }),
      (error) => error.statusCode === 404 && error.code === 'ARTICLE_NOT_FOUND',
      `${status} must not be publicly readable`
    );
  }

  // A publicly readable row with no body is a data defect, surfaced rather than
  // shipped to every client as bodyMarkdown: null.
  assert.throws(
    () => articleService.mapPublicArticle({
      ...draftRow,
      status: 'PUBLISHED',
      currentRevision: { ...draftRow.currentRevision, status: 'PUBLISHED', bodyMarkdown: null }
    }),
    (error) => error.statusCode === 500 && error.code === 'ARTICLE_PUBLIC_BODY_MISSING'
  );

  // ...and so is a CORRECTED article with no correction note.
  assert.throws(
    () => articleService.mapPublicArticle({
      ...draftRow,
      status: 'CORRECTED',
      correctedAt: NOW,
      currentRevision: { ...draftRow.currentRevision, status: 'CORRECTED', changeNote: null }
    }),
    (error) => error.statusCode === 500 && error.code === 'ARTICLE_PUBLIC_CORRECTION_NOTE_MISSING'
  );

  // An editor sees the draft body and the internal workflow metadata.
  const forEditor = articleService.mapEditorArticle(draftRow);

  assert.equal(forEditor.bodyMarkdown, '# Unpublished body');
  assert.equal(forEditor.bodyFormat, 'commonmark-no-html');
  assert.equal(forEditor.id, 'a-1');
  assert.equal(forEditor.authorUserId, USER_A);

  // A published article serves its body, and every promised field is non-null.
  const published = articleService.mapPublicArticle({
    ...draftRow,
    status: 'PUBLISHED',
    publishedAt: NOW,
    currentRevision: {
      revisionNumber: 5,
      status: 'PUBLISHED',
      bodyMarkdown: '# Published body',
      changeNote: 'published',
      aiDraft: false,
      createdAt: NOW
    }
  });

  assert.equal(published.bodyMarkdown, '# Published body');
  assert.equal(published.revision.revisionNumber, 5);
  assert.equal(published.status, 'PUBLISHED');
  // The public DTO must not leak internal workflow fields.
  for (const internalField of ['id', 'authorUserId', 'scheduledFor', 'retractedAt', 'aiDraftUsed']) {
    assert.equal(internalField in published, false, `${internalField} must not be public`);
  }

  // A Today card carries no body at all.
  const summary = articleService.mapArticleSummary({
    ...draftRow,
    status: 'PUBLISHED',
    publishedAt: NOW
  });

  assert.equal('bodyMarkdown' in summary, false, 'a Today card must not ship a 40 KB body');
  assert.equal(summary.sourceCount, 0);
});
