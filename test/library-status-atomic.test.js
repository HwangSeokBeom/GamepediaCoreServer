process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
process.env.ACCESS_TOKEN_EXPIRES_IN ??= '900';
process.env.REFRESH_TOKEN_EXPIRES_IN ??= '1209600';
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@localhost:5499/placeholder_unit_only';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../src/config/prisma');
const libraryService = require('../src/modules/library/library.service');
const userActivityService = require('../src/modules/user/user-activity.service');
const userPresenceService = require('../src/modules/user/user-presence.service');
const { runWithLibraryRequestContext } = require('../src/modules/library/library-request-context');

const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function compoundConflictError(target) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target }
  });
}

function stubLibraryTable(overrides) {
  const original = {
    findUnique: prisma.userGameLibrary.findUnique,
    create: prisma.userGameLibrary.create,
    update: prisma.userGameLibrary.update
  };

  Object.assign(prisma.userGameLibrary, overrides);
  return () => Object.assign(prisma.userGameLibrary, original);
}

function stubSideEffects() {
  const originalPresence = userPresenceService.updatePresenceFromLibraryEntry;
  const originalActivity = userActivityService.recordPlayStatusChangedActivity;

  userPresenceService.updatePresenceFromLibraryEntry = async () => null;
  userActivityService.recordPlayStatusChangedActivity = async () => null;

  return () => {
    userPresenceService.updatePresenceFromLibraryEntry = originalPresence;
    userActivityService.recordPlayStatusChangedActivity = originalActivity;
  };
}

test('isLibraryEntryKeyConflictError only matches the compound library key', () => {
  const { isLibraryEntryKeyConflictError } = libraryService;

  assert.equal(isLibraryEntryKeyConflictError(compoundConflictError(['userId', 'gameSource', 'externalGameId'])), true);
  assert.equal(isLibraryEntryKeyConflictError(compoundConflictError(['user_id', 'game_source', 'external_game_id'])), true);
  assert.equal(isLibraryEntryKeyConflictError(compoundConflictError('user_game_library_user_id_game_source_external_game_id_key')), true);

  assert.equal(isLibraryEntryKeyConflictError(compoundConflictError(['user_id', 'token'])), false, 'unrelated unique keys must not match');
  assert.equal(isLibraryEntryKeyConflictError(compoundConflictError('refresh_tokens_token_hash_key')), false);
  assert.equal(isLibraryEntryKeyConflictError(compoundConflictError(undefined)), false, 'missing target must stay an error');
  assert.equal(isLibraryEntryKeyConflictError(new Prisma.PrismaClientKnownRequestError('not found', {
    code: 'P2025',
    clientVersion: 'test'
  })), false);
  assert.equal(isLibraryEntryKeyConflictError(new Error('generic')), false);
});

test('losing a concurrent first write converges to an update instead of a 409', async () => {
  const committedRow = {
    id: 'row-1',
    userId: USER_ID,
    gameSource: 'IGDB',
    externalGameId: '4242',
    gameName: 'Race Game',
    coverUrl: null,
    status: 'PLAYING',
    startedAt: new Date(),
    completedAt: null,
    lastPlayedAt: null,
    playtimeMinutes: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const calls = { findUnique: 0, create: 0, update: 0 };
  const restoreTable = stubLibraryTable({
    async findUnique() {
      calls.findUnique += 1;
      // First read observes no row (the concurrent winner has not committed
      // yet); the retry read observes the winner's committed row.
      return calls.findUnique === 1 ? null : committedRow;
    },
    async create() {
      calls.create += 1;
      throw compoundConflictError(['userId', 'gameSource', 'externalGameId']);
    },
    async update({ where, data }) {
      calls.update += 1;
      assert.equal(where.id, 'row-1');
      return { ...committedRow, ...data };
    }
  });
  const restoreSideEffects = stubSideEffects();

  try {
    const result = await runWithLibraryRequestContext(() => libraryService.updateLibraryStatus({
      userId: USER_ID,
      source: 'igdb',
      externalGameId: '4242',
      title: 'Race Game',
      coverUrl: null,
      status: 'completed'
    }));

    assert.equal(calls.create, 1);
    assert.equal(calls.update, 1);
    assert.equal(result.libraryEntry.status, 'completed');
  } finally {
    restoreTable();
    restoreSideEffects();
  }
});

test('unrelated unique constraint failures are not converted into success', async () => {
  const restoreTable = stubLibraryTable({
    async findUnique() {
      return null;
    },
    async create() {
      throw compoundConflictError(['some_other_column']);
    },
    async update() {
      throw new Error('update must not run');
    }
  });
  const restoreSideEffects = stubSideEffects();

  try {
    await assert.rejects(
      runWithLibraryRequestContext(() => libraryService.updateLibraryStatus({
        userId: USER_ID,
        source: 'igdb',
        externalGameId: '4242',
        title: 'Race Game',
        coverUrl: null,
        status: 'playing'
      })),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );
  } finally {
    restoreTable();
    restoreSideEffects();
  }
});

test('a row deleted between read and update is retried as a create', async () => {
  const existingRow = {
    id: 'row-9',
    userId: USER_ID,
    gameSource: 'IGDB',
    externalGameId: '77',
    gameName: 'Vanishing Game',
    coverUrl: null,
    status: 'PLAYING',
    startedAt: null,
    completedAt: null,
    lastPlayedAt: null,
    playtimeMinutes: null
  };
  const calls = { findUnique: 0, create: 0, update: 0 };
  const restoreTable = stubLibraryTable({
    async findUnique() {
      calls.findUnique += 1;
      return calls.findUnique === 1 ? existingRow : null;
    },
    async update() {
      calls.update += 1;
      throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
        code: 'P2025',
        clientVersion: 'test'
      });
    },
    async create({ data }) {
      calls.create += 1;
      return {
        id: 'row-10',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data
      };
    }
  });
  const restoreSideEffects = stubSideEffects();

  try {
    const result = await runWithLibraryRequestContext(() => libraryService.updateLibraryStatus({
      userId: USER_ID,
      source: 'igdb',
      externalGameId: '77',
      title: 'Vanishing Game',
      coverUrl: null,
      status: 'dropped'
    }));

    assert.equal(calls.update, 1);
    assert.equal(calls.create, 1);
    assert.equal(result.libraryEntry.status, 'dropped');
  } finally {
    restoreTable();
    restoreSideEffects();
  }
});

test('repeated conflicts exhaust the bounded retries and surface the conflict', async () => {
  const calls = { create: 0 };
  const restoreTable = stubLibraryTable({
    async findUnique() {
      return null;
    },
    async create() {
      calls.create += 1;
      throw compoundConflictError(['userId', 'gameSource', 'externalGameId']);
    },
    async update() {
      throw new Error('update must not run');
    }
  });
  const restoreSideEffects = stubSideEffects();

  try {
    await assert.rejects(
      runWithLibraryRequestContext(() => libraryService.updateLibraryStatus({
        userId: USER_ID,
        source: 'igdb',
        externalGameId: '4242',
        title: 'Race Game',
        coverUrl: null,
        status: 'playing'
      })),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );
    assert.equal(calls.create, 3, 'bounded retry must stop after the configured attempts');
  } finally {
    restoreTable();
    restoreSideEffects();
  }
});
