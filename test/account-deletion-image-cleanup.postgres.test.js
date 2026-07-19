const assert = require('node:assert');
const { test } = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Builds a canonical server-generated filename owned by `userId`, matching the
// generator in profile-image.storage.js (`<uuid>-<epochMillis>-<16 hex><ext>`).
// Ownership is proven from this embedded user id, so cleanup only ever touches
// files whose name carries the deleting user's id.
function ownedFileName(userId) {
  return `${userId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.jpg`;
}

// PostgreSQL integration tests for profile-image cleanup on account deletion.
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
  const { UserStatus } = require('@prisma/client');
  const { prisma } = require('../src/config/prisma');
  const authService = require('../src/services/auth.service');
  const { uploadsRootDirectory } = require('../src/modules/user/profile-image.storage');
  const { runProfileImageCleanupSweep } = require('../src/modules/user/profile-image-cleanup.service');

  return { UserStatus, prisma, authService, uploadsRootDirectory, runProfileImageCleanupSweep };
}

async function signUpUser(authService, label) {
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const session = await authService.signUp({
    email: `${label}-${marker}@cleanup.postgres.test`,
    password: 'cleanup-test-password',
    nickname: `${label.slice(0, 6)}_${marker.slice(-9)}`,
    deviceName: 'postgres-test-device'
  });

  return session.user;
}

function ownedImagePath(uploadsRootDirectory, fileName) {
  return path.join(uploadsRootDirectory, 'profile-images', fileName);
}

function createOwnedImage(uploadsRootDirectory, fileName) {
  const filePath = ownedImagePath(uploadsRootDirectory, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'image-bytes');
  return filePath;
}

test('account deletion removes the owned local profile image and settles cleanup state', { skip: skipReason }, async () => {
  const { prisma, authService, uploadsRootDirectory } = requireHarness();
  const user = await signUpUser(authService, 'owned');
  const fileName = ownedFileName(user.id);
  const filePath = createOwnedImage(uploadsRootDirectory, fileName);
  const storedPathname = `/uploads/profile-images/${fileName}`;

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { profileImageUrl: storedPathname }
    });

    const result = await authService.deleteCurrentUser(user.id);

    assert.strictEqual(result.deleted, true, 'response shape must stay backward compatible');
    assert.ok(result.deletedAt instanceof Date);
    assert.ok(!fs.existsSync(filePath), 'owned local image must be removed');
    assert.strictEqual(await prisma.user.findUnique({ where: { id: user.id } }), null);
    assert.strictEqual(
      await prisma.profileImageCleanupTask.count({ where: { storedPathname } }),
      0,
      'cleanup state must be settled after successful removal'
    );

    await assert.rejects(
      authService.deleteCurrentUser(user.id),
      (error) => error?.code === 'ACCOUNT_NOT_FOUND',
      'repeating the deletion must stay safe and idempotent'
    );
  } finally {
    fs.rmSync(filePath, { force: true });
    await prisma.profileImageCleanupTask.deleteMany({ where: { storedPathname } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('externally hosted profile images are never deleted and create no cleanup state', { skip: skipReason }, async () => {
  const { prisma, authService } = requireHarness();
  const user = await signUpUser(authService, 'external');

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { profileImageUrl: 'https://cdn.example.com/avatars/keep-me.png' }
    });

    const result = await authService.deleteCurrentUser(user.id);

    assert.strictEqual(result.deleted, true);
    assert.strictEqual(
      await prisma.profileImageCleanupTask.count({ where: { userId: user.id } }),
      0,
      'external URLs must not produce cleanup tasks'
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('an already-missing owned image is treated as successfully cleaned up', { skip: skipReason }, async () => {
  const { prisma, authService } = requireHarness();
  const user = await signUpUser(authService, 'missing');
  const storedPathname = `/uploads/profile-images/${ownedFileName(user.id)}`;

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { profileImageUrl: storedPathname }
    });

    const result = await authService.deleteCurrentUser(user.id);

    assert.strictEqual(result.deleted, true);
    assert.strictEqual(
      await prisma.profileImageCleanupTask.count({ where: { storedPathname } }),
      0,
      'missing files must settle idempotently'
    );
  } finally {
    await prisma.profileImageCleanupTask.deleteMany({ where: { storedPathname } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('filesystem failure retains a durable cleanup task and the sweep retries it to completion', { skip: skipReason }, async () => {
  const { prisma, authService, uploadsRootDirectory, runProfileImageCleanupSweep } = requireHarness();
  const user = await signUpUser(authService, 'retry');
  const fileName = ownedFileName(user.id);
  const blockedPath = ownedImagePath(uploadsRootDirectory, fileName);
  const storedPathname = `/uploads/profile-images/${fileName}`;

  try {
    // A directory at the stored pathname makes unlink fail with a
    // non-ENOENT error, simulating a temporarily broken filesystem.
    fs.mkdirSync(blockedPath, { recursive: true });
    await prisma.user.update({
      where: { id: user.id },
      data: { profileImageUrl: storedPathname }
    });

    const result = await authService.deleteCurrentUser(user.id);

    assert.strictEqual(result.deleted, true, 'deletion must succeed even when cleanup fails');

    const retainedTask = await prisma.profileImageCleanupTask.findUnique({ where: { storedPathname } });

    assert.ok(retainedTask, 'failed cleanup must be durably retained for retry');
    assert.strictEqual(retainedTask.attemptCount, 1);
    assert.ok(retainedTask.lastError, 'failure reason must be recorded');

    // Repair the filesystem, then let the bounded sweep retry.
    fs.rmSync(blockedPath, { recursive: true, force: true });
    fs.writeFileSync(blockedPath, 'image-bytes');

    const sweepResult = await runProfileImageCleanupSweep();

    assert.ok(sweepResult.completedCount >= 1);
    assert.ok(!fs.existsSync(blockedPath), 'retry must eventually remove the file');
    assert.strictEqual(await prisma.profileImageCleanupTask.count({ where: { storedPathname } }), 0);
  } finally {
    fs.rmSync(blockedPath, { recursive: true, force: true });
    await prisma.profileImageCleanupTask.deleteMany({ where: { storedPathname } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('a rolled-back deletion touches neither the image nor cleanup state', { skip: skipReason }, async () => {
  const { UserStatus, prisma, authService, uploadsRootDirectory } = requireHarness();
  const user = await signUpUser(authService, 'rollback');
  const fileName = ownedFileName(user.id);
  const filePath = createOwnedImage(uploadsRootDirectory, fileName);
  const storedPathname = `/uploads/profile-images/${fileName}`;

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        profileImageUrl: storedPathname,
        status: UserStatus.SUSPENDED
      }
    });

    await assert.rejects(
      authService.deleteCurrentUser(user.id),
      (error) => Number(error?.statusCode) >= 400
    );

    assert.ok(fs.existsSync(filePath), 'image must never be deleted before the transaction commits');
    assert.strictEqual(
      await prisma.profileImageCleanupTask.count({ where: { storedPathname } }),
      0,
      'no cleanup state may survive a rolled-back deletion'
    );
    assert.ok(await prisma.user.findUnique({ where: { id: user.id } }), 'user must survive the rollback');
  } finally {
    fs.rmSync(filePath, { force: true });
    await prisma.profileImageCleanupTask.deleteMany({ where: { storedPathname } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('deleting an account that copied another user\'s image path never removes the victim file', { skip: skipReason }, async () => {
  const { prisma, authService, uploadsRootDirectory } = requireHarness();
  const victim = await signUpUser(authService, 'victim');
  const attacker = await signUpUser(authService, 'attacker');

  // A real, canonical image owned by the victim.
  const victimFileName = ownedFileName(victim.id);
  const victimFilePath = createOwnedImage(uploadsRootDirectory, victimFileName);
  const victimStoredPathname = `/uploads/profile-images/${victimFileName}`;

  try {
    await prisma.user.update({ where: { id: victim.id }, data: { profileImageUrl: victimStoredPathname } });
    // The attacker points their own profile at the victim's stored path.
    await prisma.user.update({ where: { id: attacker.id }, data: { profileImageUrl: victimStoredPathname } });

    const result = await authService.deleteCurrentUser(attacker.id);

    assert.strictEqual(result.deleted, true);
    assert.ok(fs.existsSync(victimFilePath), "victim's file must never be deleted by the attacker's account deletion");
    assert.strictEqual(
      await prisma.profileImageCleanupTask.count({ where: { userId: attacker.id } }),
      0,
      'a foreign-owned path must never become a cleanup task'
    );
    assert.ok(await prisma.user.findUnique({ where: { id: victim.id } }), 'victim account is untouched');
  } finally {
    fs.rmSync(victimFilePath, { force: true });
    await prisma.profileImageCleanupTask.deleteMany({ where: { storedPathname: victimStoredPathname } });
    await prisma.user.deleteMany({ where: { id: { in: [victim.id, attacker.id] } } });
  }
});
