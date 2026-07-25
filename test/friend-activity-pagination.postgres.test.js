const assert = require('node:assert');
const { test } = require('node:test');

// PostgreSQL integration tests for privacy-aware friend-activity pagination.
// Requires a disposable database whose name contains "test" or "audit"; skips
// otherwise so the default `npm test` run stays green without a database.
function resolveTestDatabaseName() {
  const rawUrl = process.env.DATABASE_URL;

  if (!rawUrl) {
    return null;
  }

  try {
    const databaseName = new URL(rawUrl).pathname.replace(/^\//, '');
    return /test|audit/i.test(databaseName) ? databaseName : null;
  } catch (error) {
    return null;
  }
}

const REQUIRED_ENV = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ACCESS_TOKEN_EXPIRES_IN',
  'REFRESH_TOKEN_EXPIRES_IN'
];

const testDatabaseName = resolveTestDatabaseName();
const hasRequiredEnv = REQUIRED_ENV.every((name) => typeof process.env[name] === 'string' && process.env[name].trim());
const skipReason = !testDatabaseName || !hasRequiredEnv
  ? 'requires DATABASE_URL pointing at a dedicated test/audit database plus JWT env vars'
  : false;

function requireHarness() {
  const { UserActivityType, UserStatus } = require('@prisma/client');
  const { prisma } = require('../src/config/prisma');
  const userActivityService = require('../src/modules/user/user-activity.service');
  const userService = require('../src/modules/user/user.service');

  return { UserActivityType, UserStatus, prisma, userActivityService, userService };
}

async function createUser(prisma, label, overrides = {}) {
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return prisma.user.create({
    data: {
      email: `${label}-${marker}@activity.postgres.test`,
      passwordHash: 'x'.repeat(60),
      nickname: `${label.slice(0, 8)}_${marker.slice(-8)}`,
      ...overrides
    }
  });
}

async function befriend(prisma, userId, friendUserId) {
  await prisma.friendship.create({ data: { userId, friendUserId } });
}

async function createActivity(prisma, { actorUserId, activityType, createdAt }) {
  return prisma.userActivityEvent.create({
    data: {
      actorUserId,
      activityType,
      metadata: {},
      createdAt
    }
  });
}

async function collectAllPages(userActivityService, currentUserId, limit) {
  const pages = [];
  let cursor = null;

  for (let iteration = 0; iteration < 30; iteration += 1) {
    const page = await userActivityService.getFriendActivityFeed({ currentUserId, cursor, limit });
    pages.push(page);

    if (!page.nextCursor) {
      return pages;
    }

    cursor = page.nextCursor;
  }

  throw new Error('pagination did not terminate');
}

test('a fully hidden newest chunk cannot mask older visible activity', { skip: skipReason }, async () => {
  const { UserActivityType, prisma, userActivityService } = requireHarness();
  const viewer = await createUser(prisma, 'viewer');
  const hiddenFriend = await createUser(prisma, 'hidden');
  const publicFriend = await createUser(prisma, 'public');

  try {
    await befriend(prisma, viewer.id, hiddenFriend.id);
    await befriend(prisma, viewer.id, publicFriend.id);
    await prisma.userPrivacySettings.create({
      data: {
        userId: hiddenFriend.id,
        showLikedGames: false,
        showRecentlyPlayed: false,
        showReviews: false
      }
    });

    const base = Date.now();

    // Newest 25 events all come from the fully hidden friend...
    for (let index = 0; index < 25; index += 1) {
      await createActivity(prisma, {
        actorUserId: hiddenFriend.id,
        activityType: UserActivityType.REVIEW_CREATED,
        createdAt: new Date(base - index * 1000)
      });
    }

    // ...while older visible events exist from the public friend.
    for (let index = 0; index < 5; index += 1) {
      await createActivity(prisma, {
        actorUserId: publicFriend.id,
        activityType: UserActivityType.REVIEW_CREATED,
        createdAt: new Date(base - (100 + index) * 1000)
      });
    }

    const page = await userActivityService.getFriendActivityFeed({
      currentUserId: viewer.id,
      limit: 20
    });

    assert.strictEqual(page.activities.length, 5, 'older visible events must not be skipped');
    assert.ok(page.activities.every((activity) => activity.actor.id === publicFriend.id));
    assert.strictEqual(page.nextCursor, null, 'terminal cursor must mean no later visible records');
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [viewer.id, hiddenFriend.id, publicFriend.id] } } });
  }
});

test('mixed hidden and visible activity paginates without gaps or duplicates', { skip: skipReason }, async () => {
  const { UserActivityType, prisma, userActivityService } = requireHarness();
  const viewer = await createUser(prisma, 'viewer');
  const partialFriend = await createUser(prisma, 'partial');
  const publicFriend = await createUser(prisma, 'public');

  try {
    await befriend(prisma, viewer.id, partialFriend.id);
    await befriend(prisma, viewer.id, publicFriend.id);
    await prisma.userPrivacySettings.create({
      data: {
        userId: partialFriend.id,
        showLikedGames: false,
        showRecentlyPlayed: true,
        showReviews: false
      }
    });

    const base = Date.now();
    const visibleIds = [];

    for (let index = 0; index < 30; index += 1) {
      const fromPartial = index % 2 === 0;
      const hidden = fromPartial && index % 4 === 0;
      const event = await createActivity(prisma, {
        actorUserId: fromPartial ? partialFriend.id : publicFriend.id,
        activityType: hidden
          ? UserActivityType.REVIEW_CREATED
          : UserActivityType.PLAY_STATUS_CHANGED,
        createdAt: new Date(base - index * 1000)
      });

      if (!hidden) {
        visibleIds.push(event.id);
      }
    }

    const pages = await collectAllPages(userActivityService, viewer.id, 7);
    const seenIds = pages.flatMap((page) => page.activities.map((activity) => activity.id));

    assert.deepStrictEqual(seenIds, visibleIds, 'pages must cover exactly the visible events, in order, with no gaps or duplicates');
    assert.strictEqual(new Set(seenIds).size, seenIds.length, 'no duplicates across pages');
    assert.strictEqual(pages[pages.length - 1].nextCursor, null);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [viewer.id, partialFriend.id, publicFriend.id] } } });
  }
});

test('exactly limit visible records yields a terminal cursor; limit+1 yields one more page', { skip: skipReason }, async () => {
  const { UserActivityType, prisma, userActivityService } = requireHarness();
  const viewer = await createUser(prisma, 'viewer');
  const friend = await createUser(prisma, 'friend');

  try {
    await befriend(prisma, viewer.id, friend.id);

    const base = Date.now();

    for (let index = 0; index < 10; index += 1) {
      await createActivity(prisma, {
        actorUserId: friend.id,
        activityType: UserActivityType.REVIEW_CREATED,
        createdAt: new Date(base - index * 1000)
      });
    }

    const exactPage = await userActivityService.getFriendActivityFeed({
      currentUserId: viewer.id,
      limit: 10
    });

    assert.strictEqual(exactPage.activities.length, 10);
    assert.strictEqual(exactPage.nextCursor, null, 'exactly limit visible records must terminate');

    const overflowPage = await userActivityService.getFriendActivityFeed({
      currentUserId: viewer.id,
      limit: 9
    });

    assert.strictEqual(overflowPage.activities.length, 9);
    assert.ok(overflowPage.nextCursor, 'limit+1 visible records must continue');

    const finalPage = await userActivityService.getFriendActivityFeed({
      currentUserId: viewer.id,
      cursor: overflowPage.nextCursor,
      limit: 9
    });

    assert.strictEqual(finalPage.activities.length, 1);
    assert.strictEqual(finalPage.nextCursor, null);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [viewer.id, friend.id] } } });
  }
});

test('identical createdAt values paginate deterministically via the id tie-break', { skip: skipReason }, async () => {
  const { UserActivityType, prisma, userActivityService } = requireHarness();
  const viewer = await createUser(prisma, 'viewer');
  const friend = await createUser(prisma, 'friend');

  try {
    await befriend(prisma, viewer.id, friend.id);

    const sharedCreatedAt = new Date();
    const eventIds = [];

    for (let index = 0; index < 9; index += 1) {
      const event = await createActivity(prisma, {
        actorUserId: friend.id,
        activityType: UserActivityType.REVIEW_CREATED,
        createdAt: sharedCreatedAt
      });
      eventIds.push(event.id);
    }

    const expectedOrder = [...eventIds].sort().reverse();
    const pages = await collectAllPages(userActivityService, viewer.id, 4);
    const seenIds = pages.flatMap((page) => page.activities.map((activity) => activity.id));

    assert.deepStrictEqual(seenIds, expectedOrder, 'ties on createdAt must order by id desc across page boundaries');
    assert.deepStrictEqual(pages.map((page) => page.activities.length), [4, 4, 1]);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [viewer.id, friend.id] } } });
  }
});

test('feed only exposes friends, respects privacy, and rejects non-active accounts', { skip: skipReason }, async () => {
  const { UserActivityType, UserStatus, prisma, userActivityService, userService } = requireHarness();
  const viewer = await createUser(prisma, 'viewer');
  const friend = await createUser(prisma, 'friend');
  const stranger = await createUser(prisma, 'stranger');

  try {
    await befriend(prisma, viewer.id, friend.id);
    await prisma.userPrivacySettings.create({
      data: {
        userId: friend.id,
        showLikedGames: false
      }
    });

    const base = Date.now();
    await createActivity(prisma, {
      actorUserId: friend.id,
      activityType: UserActivityType.LIKED_GAME_ADDED,
      createdAt: new Date(base - 1000)
    });
    const visibleEvent = await createActivity(prisma, {
      actorUserId: friend.id,
      activityType: UserActivityType.REVIEW_CREATED,
      createdAt: new Date(base - 2000)
    });
    await createActivity(prisma, {
      actorUserId: stranger.id,
      activityType: UserActivityType.REVIEW_CREATED,
      createdAt: new Date(base)
    });

    const page = await userActivityService.getFriendActivityFeed({
      currentUserId: viewer.id,
      limit: 20
    });

    assert.deepStrictEqual(page.activities.map((activity) => activity.id), [visibleEvent.id], 'non-friend and privacy-hidden events must not appear');

    await prisma.user.update({
      where: { id: viewer.id },
      data: { status: UserStatus.SUSPENDED }
    });

    await assert.rejects(
      userService.getMyFriendsActivity({ currentUserId: viewer.id }),
      (error) => Number(error?.statusCode) >= 400,
      'non-active accounts must not read the feed'
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [viewer.id, friend.id, stranger.id] } } });
  }
});
