process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
process.env.ACCESS_TOKEN_EXPIRES_IN ??= '900';
process.env.REFRESH_TOKEN_EXPIRES_IN ??= '1209600';
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@localhost:5499/placeholder_unit_only';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UserActivityType } = require('@prisma/client');
const { buildFriendActivityVisibilityClauses } = require('../src/modules/user/user-activity.service');

const ALL_TYPES = Object.values(UserActivityType);

function privacy({ showLikedGames = true, showRecentlyPlayed = true, showReviews = true } = {}) {
  return { showLikedGames, showRecentlyPlayed, showReviews };
}

test('friends without settings rows collapse into one unfiltered clause', () => {
  const clauses = buildFriendActivityVisibilityClauses(['friend-a', 'friend-b'], new Map());

  assert.equal(clauses.length, 1);
  assert.deepEqual(clauses[0].actorUserId.in.sort(), ['friend-a', 'friend-b']);
  assert.equal(clauses[0].activityType, undefined);
});

test('fully hidden friends produce no clause at all', () => {
  const settings = new Map([
    ['friend-hidden', privacy({ showLikedGames: false, showRecentlyPlayed: false, showReviews: false })]
  ]);
  const clauses = buildFriendActivityVisibilityClauses(['friend-hidden'], settings);

  assert.deepEqual(clauses, []);
});

test('partially hidden friends get an activityType filter matching shouldExposeActivityByPrivacy', () => {
  const settings = new Map([
    ['friend-partial', privacy({ showLikedGames: false })]
  ]);
  const clauses = buildFriendActivityVisibilityClauses(['friend-partial'], settings);

  assert.equal(clauses.length, 1);
  assert.deepEqual(clauses[0].actorUserId.in, ['friend-partial']);

  const allowed = clauses[0].activityType.in;
  assert.ok(!allowed.includes(UserActivityType.LIKED_GAME_ADDED));
  assert.ok(!allowed.includes(UserActivityType.LIKED_GAME_REMOVED));
  assert.ok(allowed.includes(UserActivityType.REVIEW_CREATED));
  assert.ok(allowed.includes(UserActivityType.PLAY_STATUS_CHANGED));
  assert.equal(allowed.length, ALL_TYPES.length - 2);
});

test('friends sharing the same privacy profile are grouped into one clause', () => {
  const settings = new Map([
    ['friend-a', privacy({ showReviews: false })],
    ['friend-b', privacy({ showReviews: false })],
    ['friend-c', privacy()]
  ]);
  const clauses = buildFriendActivityVisibilityClauses(['friend-a', 'friend-b', 'friend-c'], settings);

  assert.equal(clauses.length, 2);

  const restricted = clauses.find((clause) => clause.activityType);
  const open = clauses.find((clause) => !clause.activityType);

  assert.deepEqual(restricted.actorUserId.in.sort(), ['friend-a', 'friend-b']);
  assert.deepEqual(open.actorUserId.in, ['friend-c']);
  assert.ok(!restricted.activityType.in.includes(UserActivityType.REVIEW_CREATED));
  assert.ok(!restricted.activityType.in.includes(UserActivityType.RATING_CHANGED));
});
