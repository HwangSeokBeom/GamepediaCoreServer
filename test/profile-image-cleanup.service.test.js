process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
process.env.ACCESS_TOKEN_EXPIRES_IN ??= '900';
process.env.REFRESH_TOKEN_EXPIRES_IN ??= '1209600';
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@localhost:5499/placeholder_unit_only';
// Pin the API origin so same-host vs foreign-host URL tests are deterministic.
process.env.API_PUBLIC_BASE_URL ??= 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../src/config/prisma');
const {
  DELETE_STATUS,
  deleteOwnedProfileImage,
  resolveOwnedProfileImageReference,
  profileImagesDirectory,
  uploadsRootDirectory
} = require('../src/modules/user/profile-image.storage');
const {
  captureProfileImageCleanupTask,
  processProfileImageCleanupTask
} = require('../src/modules/user/profile-image-cleanup.service');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

let fileCounter = 0;

// A canonical server-generated name for `owner`: <uuid>-<epochMillis>-<16 hex>.
function ownedFileName(owner = OWNER_ID) {
  fileCounter += 1;
  const hex = fileCounter.toString(16).padStart(16, '0');
  return `${owner}-1700000000000-${hex}.jpg`;
}

function ownedPathname(fileName) {
  return `/uploads/profile-images/${fileName}`;
}

function createOwnedTestFile(fileName) {
  fs.mkdirSync(profileImagesDirectory, { recursive: true });
  const filePath = path.join(profileImagesDirectory, fileName);
  fs.writeFileSync(filePath, 'test-image-bytes');
  return filePath;
}

function stubCleanupTaskTable(overrides = {}) {
  const original = {
    create: prisma.profileImageCleanupTask.create,
    findUnique: prisma.profileImageCleanupTask.findUnique,
    deleteMany: prisma.profileImageCleanupTask.deleteMany,
    updateMany: prisma.profileImageCleanupTask.updateMany
  };

  Object.assign(prisma.profileImageCleanupTask, overrides);

  return () => Object.assign(prisma.profileImageCleanupTask, original);
}

// ---------------------------------------------------------------------------
// Canonical ownership resolution (URL/path shape + ownership, no filesystem).
// ---------------------------------------------------------------------------

test('valid server-generated image owned by the deleting user resolves and deletes', async () => {
  const fileName = ownedFileName();
  const filePath = createOwnedTestFile(fileName);

  try {
    const resolved = resolveOwnedProfileImageReference({
      profileImageUrl: ownedPathname(fileName),
      userId: OWNER_ID
    });

    assert.equal(resolved.ok, true);
    assert.equal(resolved.storedPathname, ownedPathname(fileName));

    const outcome = await deleteOwnedProfileImage({
      storedPathname: ownedPathname(fileName),
      userId: OWNER_ID
    });

    assert.equal(outcome.status, DELETE_STATUS.DELETED);
    assert.ok(!fs.existsSync(filePath), 'owned file must be removed');
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("another user's canonical image path is rejected", async () => {
  const fileName = ownedFileName(OTHER_ID);
  const filePath = createOwnedTestFile(fileName);

  try {
    const resolved = resolveOwnedProfileImageReference({
      profileImageUrl: ownedPathname(fileName),
      userId: OWNER_ID
    });

    assert.equal(resolved.ok, false);
    assert.equal(resolved.reason, 'OWNERSHIP_MISMATCH');

    const outcome = await deleteOwnedProfileImage({
      storedPathname: ownedPathname(fileName),
      userId: OWNER_ID
    });

    assert.equal(outcome.status, DELETE_STATUS.REJECTED);
    assert.ok(fs.existsSync(filePath), "another user's file must never be touched");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("a copied same-host profile-image URL from another user is rejected", () => {
  const fileName = ownedFileName(OTHER_ID);
  const resolved = resolveOwnedProfileImageReference({
    profileImageUrl: `http://localhost:3000/uploads/profile-images/${fileName}`,
    userId: OWNER_ID
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'OWNERSHIP_MISMATCH');
});

test('a foreign-host URL with a local-shaped pathname is never treated as owned', async () => {
  const fileName = ownedFileName();
  const foreign = `https://evil.example.com/uploads/profile-images/${fileName}`;

  const resolved = resolveOwnedProfileImageReference({ profileImageUrl: foreign, userId: OWNER_ID });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'FOREIGN_HOST');

  const outcome = await deleteOwnedProfileImage({ storedPathname: foreign, userId: OWNER_ID });
  assert.equal(outcome.status, DELETE_STATUS.REJECTED);
});

test('a same-host URL with a noncanonical filename is rejected', () => {
  const resolved = resolveOwnedProfileImageReference({
    profileImageUrl: 'http://localhost:3000/uploads/profile-images/user-1.jpg',
    userId: OWNER_ID
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'NONCANONICAL_FILENAME');
});

test('relative traversal out of profile-images is rejected without touching disk', async () => {
  const victimDir = path.join(uploadsRootDirectory, 'other-dir');
  fs.mkdirSync(victimDir, { recursive: true });
  const victim = path.join(victimDir, `victim-${fileCounter}.bin`);
  fs.writeFileSync(victim, 'secret');

  try {
    const outcome = await deleteOwnedProfileImage({
      storedPathname: `/uploads/profile-images/../other-dir/${path.basename(victim)}`,
      userId: OWNER_ID
    });

    assert.equal(outcome.status, DELETE_STATUS.REJECTED);
    assert.ok(fs.existsSync(victim), 'file outside profile-images must survive');
  } finally {
    fs.rmSync(victimDir, { recursive: true, force: true });
  }
});

test('encoded traversal (%2e%2e) is rejected', () => {
  const resolved = resolveOwnedProfileImageReference({
    profileImageUrl: 'http://localhost:3000/uploads/profile-images/%2e%2e/other-file',
    userId: OWNER_ID
  });

  assert.equal(resolved.ok, false);
  assert.ok(['ENCODED_CHARACTER', 'OUTSIDE_PREFIX', 'TRAVERSAL', 'NESTED_PATH'].includes(resolved.reason));
});

test('double-encoded traversal (%252e%252e) is rejected as an encoded character', () => {
  const resolved = resolveOwnedProfileImageReference({
    profileImageUrl: '/uploads/profile-images/%252e%252e/other-file',
    userId: OWNER_ID
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'ENCODED_CHARACTER');
});

test('traversal that stays in uploads but escapes profile-images is rejected', () => {
  const resolved = resolveOwnedProfileImageReference({
    profileImageUrl: '/uploads/profile-images/../secrets/data.bin',
    userId: OWNER_ID
  });

  assert.equal(resolved.ok, false);
  assert.ok(['NESTED_PATH', 'TRAVERSAL'].includes(resolved.reason));
});

test('alternate and repeated separators are rejected', () => {
  const fileName = ownedFileName();

  assert.equal(
    resolveOwnedProfileImageReference({ profileImageUrl: `/uploads/profile-images//${fileName}`, userId: OWNER_ID }).reason,
    'REPEATED_SEPARATOR'
  );
  assert.equal(
    resolveOwnedProfileImageReference({ profileImageUrl: '/uploads/profile-images/..\\other', userId: OWNER_ID }).reason,
    'ALTERNATE_SEPARATOR'
  );
});

test('query and fragment ambiguity are rejected', () => {
  const fileName = ownedFileName();

  assert.equal(
    resolveOwnedProfileImageReference({ profileImageUrl: `http://localhost:3000/uploads/profile-images/${fileName}?x=1`, userId: OWNER_ID }).reason,
    'QUERY_OR_FRAGMENT'
  );
  assert.equal(
    resolveOwnedProfileImageReference({ profileImageUrl: `/uploads/profile-images/${fileName}#frag`, userId: OWNER_ID }).reason,
    'QUERY_OR_FRAGMENT'
  );
});

test('null bytes are rejected', () => {
  const fileName = ownedFileName();
  const resolved = resolveOwnedProfileImageReference({
    profileImageUrl: '/uploads/profile-images/' + fileName + '\u0000.jpg',
    userId: OWNER_ID
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'NULL_BYTE');
});

test('a missing owned file is idempotently successful', async () => {
  const outcome = await deleteOwnedProfileImage({
    storedPathname: ownedPathname(ownedFileName()),
    userId: OWNER_ID
  });

  assert.equal(outcome.status, DELETE_STATUS.MISSING);
});

test('an external provider profile image is left untouched', () => {
  const resolved = resolveOwnedProfileImageReference({
    profileImageUrl: 'https://cdn.example.com/avatars/user.png',
    userId: OWNER_ID
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'FOREIGN_HOST');
});

// Symlink escape: create profile-images/<owned> as a symlink to a file outside
// the directory and assert deletion refuses to follow it. Symlink creation can
// fail on some filesystems (e.g. restricted Windows), so state the limitation.
test('a symlinked owned filename pointing outside is rejected', async (t) => {
  const fileName = ownedFileName();
  const linkPath = path.join(profileImagesDirectory, fileName);
  const outsideTarget = path.join(os.tmpdir(), `symlink-target-${fileCounter}.bin`);

  fs.mkdirSync(profileImagesDirectory, { recursive: true });
  fs.writeFileSync(outsideTarget, 'outside');

  try {
    fs.symlinkSync(outsideTarget, linkPath);
  } catch (error) {
    fs.rmSync(outsideTarget, { force: true });
    t.skip(`symlink unsupported on this filesystem: ${error.code}`);
    return;
  }

  try {
    const outcome = await deleteOwnedProfileImage({ storedPathname: ownedPathname(fileName), userId: OWNER_ID });

    assert.equal(outcome.status, DELETE_STATUS.REJECTED);
    assert.equal(outcome.reason, 'SYMLINK');
    assert.ok(fs.existsSync(outsideTarget), 'symlink target must never be deleted');
  } finally {
    fs.rmSync(linkPath, { force: true });
    fs.rmSync(outsideTarget, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Cleanup-task capture and worker processing.
// ---------------------------------------------------------------------------

test('externally hosted URLs create no cleanup task', async () => {
  const calls = [];
  const dbClient = {
    profileImageCleanupTask: {
      async create(args) {
        calls.push(args);
      }
    }
  };

  const task = await captureProfileImageCleanupTask(dbClient, {
    userId: OWNER_ID,
    profileImageUrl: 'https://cdn.example.com/avatars/user.png'
  });

  assert.equal(task, null);
  assert.equal(calls.length, 0);
});

test('an owned local image is captured as its canonical relative pathname', async () => {
  const fileName = ownedFileName();
  const dbCalls = [];
  const dbClient = {
    profileImageCleanupTask: {
      async create({ data }) {
        dbCalls.push(data);
        return { id: 'task-1', ...data, attemptCount: 0 };
      }
    }
  };

  const task = await captureProfileImageCleanupTask(dbClient, {
    userId: OWNER_ID,
    profileImageUrl: `http://localhost:3000/uploads/profile-images/${fileName}`
  });

  assert.equal(task.storedPathname, ownedPathname(fileName));
  assert.equal(dbCalls.length, 1);
  assert.equal(dbCalls[0].userId, OWNER_ID);
});

test('a cleanup task cannot be forged from an unvalidated foreign/other-user URL', async () => {
  const calls = [];
  const dbClient = {
    profileImageCleanupTask: {
      async create(args) {
        calls.push(args);
        return { id: 'x' };
      }
    }
  };

  const forgedInputs = [
    'https://evil.example.com/uploads/profile-images/' + ownedFileName(),
    ownedPathname(ownedFileName(OTHER_ID)),
    '/uploads/profile-images/../other-dir/file.bin',
    '/uploads/profile-images/user-1.jpg'
  ];

  for (const profileImageUrl of forgedInputs) {
    const task = await captureProfileImageCleanupTask(dbClient, { userId: OWNER_ID, profileImageUrl });
    assert.equal(task, null, `must refuse to capture ${profileImageUrl}`);
  }

  assert.equal(calls.length, 0);
});

test('capturing the same stored pathname twice is idempotent via the unique key', async () => {
  const fileName = ownedFileName();
  const storedPathname = ownedPathname(fileName);
  const existing = { id: 'task-dup', storedPathname, attemptCount: 0 };
  const dbClient = {
    profileImageCleanupTask: {
      async create() {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['stored_pathname'] }
        });
      },
      async findUnique({ where }) {
        assert.equal(where.storedPathname, storedPathname);
        return existing;
      }
    }
  };

  const task = await captureProfileImageCleanupTask(dbClient, { userId: OWNER_ID, profileImageUrl: storedPathname });

  assert.equal(task, existing);
});

test('the worker revalidates and permanently settles a previously inserted unsafe task', async () => {
  // Simulate a row that bypassed capture validation (forged/tampered). The
  // worker must refuse to delete and settle the row without touching disk.
  const victimDir = path.join(uploadsRootDirectory, 'other-dir');
  fs.mkdirSync(victimDir, { recursive: true });
  const victim = path.join(victimDir, `worker-victim-${fileCounter}.bin`);
  fs.writeFileSync(victim, 'secret');

  const deleteManyCalls = [];
  const restore = stubCleanupTaskTable({
    async deleteMany(args) {
      deleteManyCalls.push(args);
      return { count: 1 };
    },
    async updateMany() {
      throw new Error('unsafe task must not be retried');
    }
  });

  try {
    const result = await processProfileImageCleanupTask({
      id: 'forged-task',
      userId: OWNER_ID,
      storedPathname: `/uploads/profile-images/../other-dir/${path.basename(victim)}`,
      attemptCount: 0
    });

    assert.equal(result.completed, true, 'unsafe task is permanently settled, not retried forever');
    assert.deepEqual(deleteManyCalls, [{ where: { id: 'forged-task' } }]);
    assert.ok(fs.existsSync(victim), 'worker must never delete a file outside profile-images');
  } finally {
    restore();
    fs.rmSync(victimDir, { recursive: true, force: true });
  }
});

test('successful cleanup removes the file and settles the task row', async () => {
  const fileName = ownedFileName();
  const filePath = createOwnedTestFile(fileName);
  const deleteManyCalls = [];
  const restore = stubCleanupTaskTable({
    async deleteMany(args) {
      deleteManyCalls.push(args);
      return { count: 1 };
    }
  });

  try {
    const result = await processProfileImageCleanupTask({
      id: 'task-success',
      userId: OWNER_ID,
      storedPathname: ownedPathname(fileName),
      attemptCount: 0
    });

    assert.equal(result.completed, true);
    assert.ok(!fs.existsSync(filePath), 'owned file must be removed');
    assert.deepEqual(deleteManyCalls, [{ where: { id: 'task-success' } }]);
  } finally {
    restore();
    fs.rmSync(filePath, { force: true });
  }
});

test('a transient filesystem failure retains the task with an incremented attempt count and never throws', async () => {
  const fileName = ownedFileName();
  const directoryPath = path.join(profileImagesDirectory, fileName);
  fs.mkdirSync(directoryPath, { recursive: true });

  const updateManyCalls = [];
  const restore = stubCleanupTaskTable({
    async deleteMany() {
      throw new Error('deleteMany must not run when the unlink failed');
    },
    async updateMany(args) {
      updateManyCalls.push(args);
      return { count: 1 };
    }
  });

  try {
    const result = await processProfileImageCleanupTask({
      id: 'task-retry',
      userId: OWNER_ID,
      storedPathname: ownedPathname(fileName),
      attemptCount: 0
    });

    assert.equal(result.completed, false);
    assert.equal(updateManyCalls.length, 1);
    assert.deepEqual(updateManyCalls[0].where, { id: 'task-retry' });
    assert.deepEqual(updateManyCalls[0].data.attemptCount, { increment: 1 });
    assert.ok(updateManyCalls[0].data.lastError.length > 0);
    assert.ok(!/uploads|profile-images/.test(updateManyCalls[0].data.lastError), 'recorded error must not leak the path');
  } finally {
    restore();
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
});

test('cleanup never throws even when persisting the failed attempt also fails', async () => {
  const fileName = ownedFileName();
  const directoryPath = path.join(profileImagesDirectory, fileName);
  fs.mkdirSync(directoryPath, { recursive: true });

  const restore = stubCleanupTaskTable({
    async deleteMany() {
      throw new Error('unexpected deleteMany');
    },
    async updateMany() {
      throw new Error('database unavailable');
    }
  });

  try {
    const result = await processProfileImageCleanupTask({
      id: 'task-double-failure',
      userId: OWNER_ID,
      storedPathname: ownedPathname(fileName),
      attemptCount: 0
    });

    assert.equal(result.completed, false);
  } finally {
    restore();
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
});
