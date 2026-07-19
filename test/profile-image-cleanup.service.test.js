process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
process.env.ACCESS_TOKEN_EXPIRES_IN ??= '900';
process.env.REFRESH_TOKEN_EXPIRES_IN ??= '1209600';
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@localhost:5499/placeholder_unit_only';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../src/config/prisma');
const {
  deleteStoredProfileImage,
  extractStoredProfileImagePathname,
  uploadsRootDirectory
} = require('../src/modules/user/profile-image.storage');
const {
  captureProfileImageCleanupTask,
  processProfileImageCleanupTask
} = require('../src/modules/user/profile-image-cleanup.service');

const profileImagesDirectory = path.join(uploadsRootDirectory, 'profile-images');

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

test('externally hosted profile image URLs are never treated as owned files', async () => {
  assert.equal(extractStoredProfileImagePathname('https://cdn.example.com/avatars/user.png'), null);

  const calls = [];
  const dbClient = {
    profileImageCleanupTask: {
      async create(args) {
        calls.push(args);
      }
    }
  };

  const task = await captureProfileImageCleanupTask(dbClient, {
    userId: '00000000-0000-0000-0000-000000000001',
    profileImageUrl: 'https://cdn.example.com/avatars/user.png'
  });

  assert.equal(task, null);
  assert.equal(calls.length, 0);
});

test('owned local profile image paths are captured, including absolute URLs', async () => {
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
    userId: '00000000-0000-0000-0000-000000000001',
    profileImageUrl: 'http://localhost:3000/uploads/profile-images/user-1.jpg'
  });

  assert.equal(task.storedPathname, '/uploads/profile-images/user-1.jpg');
  assert.equal(dbCalls.length, 1);
});

test('capturing the same stored pathname twice is idempotent via the unique key', async () => {
  const existing = { id: 'task-1', storedPathname: '/uploads/profile-images/dup.jpg', attemptCount: 0 };
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
        assert.equal(where.storedPathname, '/uploads/profile-images/dup.jpg');
        return existing;
      }
    }
  };

  const task = await captureProfileImageCleanupTask(dbClient, {
    userId: '00000000-0000-0000-0000-000000000001',
    profileImageUrl: '/uploads/profile-images/dup.jpg'
  });

  assert.equal(task, existing);
});

test('path traversal outside the uploads root is refused without touching the filesystem', async () => {
  const deleted = await deleteStoredProfileImage('/uploads/profile-images/../../../etc/passwd');

  assert.equal(deleted, false);
  assert.ok(fs.existsSync('/etc/passwd'), 'traversal target must be untouched');
});

test('deleting an already-missing owned file is idempotent', async () => {
  const deleted = await deleteStoredProfileImage('/uploads/profile-images/never-existed-a1b2c3.jpg');

  assert.equal(deleted, false);
});

test('successful cleanup removes the file and settles the task row', async () => {
  const fileName = `test-cleanup-success-${Date.now()}.jpg`;
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
      id: 'task-1',
      userId: '00000000-0000-0000-0000-000000000001',
      storedPathname: `/uploads/profile-images/${fileName}`,
      attemptCount: 0
    });

    assert.equal(result.completed, true);
    assert.ok(!fs.existsSync(filePath), 'owned file must be removed');
    assert.deepEqual(deleteManyCalls, [{ where: { id: 'task-1' } }]);
  } finally {
    restore();
    fs.rmSync(filePath, { force: true });
  }
});

test('a filesystem failure retains the task with an incremented attempt count and never throws', async () => {
  const directoryName = `test-cleanup-failure-${Date.now()}.jpg`;
  const directoryPath = path.join(profileImagesDirectory, directoryName);
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
      id: 'task-2',
      userId: '00000000-0000-0000-0000-000000000001',
      storedPathname: `/uploads/profile-images/${directoryName}`,
      attemptCount: 0
    });

    assert.equal(result.completed, false);
    assert.equal(updateManyCalls.length, 1);
    assert.deepEqual(updateManyCalls[0].where, { id: 'task-2' });
    assert.deepEqual(updateManyCalls[0].data.attemptCount, { increment: 1 });
    assert.ok(updateManyCalls[0].data.lastError.length > 0);
  } finally {
    restore();
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
});

test('cleanup never throws even when persisting the failed attempt also fails', async () => {
  const directoryName = `test-cleanup-double-failure-${Date.now()}.jpg`;
  const directoryPath = path.join(profileImagesDirectory, directoryName);
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
      id: 'task-3',
      userId: '00000000-0000-0000-0000-000000000001',
      storedPathname: `/uploads/profile-images/${directoryName}`,
      attemptCount: 0
    });

    assert.equal(result.completed, false);
  } finally {
    restore();
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
});
