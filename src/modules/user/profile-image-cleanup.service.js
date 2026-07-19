const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const {
  DELETE_STATUS,
  deleteOwnedProfileImage,
  resolveOwnedProfileImageReference
} = require('./profile-image.storage');

// Tasks that exceed PROFILE_IMAGE_CLEANUP_MAX_ATTEMPTS stay in the table so a
// failure is never silently forgotten; the sweep stops retrying them and logs
// at error level so operators can repair the filesystem and re-arm the task by
// resetting attempt_count.
const PROFILE_IMAGE_CLEANUP_MAX_ATTEMPTS = 10;
const PROFILE_IMAGE_CLEANUP_SWEEP_BATCH_SIZE = 20;
const PROFILE_IMAGE_CLEANUP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let sweepTimer = null;

// Records the owned local profile-image file for later removal. Must run in
// the same transaction that deletes the user so the reference survives the
// user row. Externally hosted URLs resolve to null and create no task.
async function captureProfileImageCleanupTask(dbClient, { userId, profileImageUrl }) {
  // Only a provably app-owned image belonging to this exact user becomes a
  // task. Foreign hosts, other users' files, traversal, and noncanonical names
  // all resolve to a rejection and create nothing. The stored reference is the
  // normalized canonical pathname, never the raw user-controlled URL.
  const resolved = resolveOwnedProfileImageReference({ profileImageUrl, userId });

  if (!resolved.ok) {
    return null;
  }

  const { storedPathname } = resolved;

  try {
    return await dbClient.profileImageCleanupTask.create({
      data: {
        userId,
        storedPathname
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return dbClient.profileImageCleanupTask.findUnique({
        where: { storedPathname }
      });
    }

    throw error;
  }
}

async function settleCleanupTask(task) {
  await prisma.profileImageCleanupTask.deleteMany({
    where: { id: task.id }
  });

  return { completed: true };
}

// Attempts one cleanup and settles the task row. Never throws: a filesystem or
// database failure leaves the task in place for the bounded sweep to retry.
async function processProfileImageCleanupTask(task) {
  if (!task) {
    return { completed: true };
  }

  try {
    // Revalidate ownership and containment against the task's own userId every
    // time the worker runs — the validation done when the task was created is
    // never trusted, so a forged or tampered row cannot delete a foreign file.
    const outcome = await deleteOwnedProfileImage({
      storedPathname: task.storedPathname,
      userId: task.userId
    });

    if (outcome.status === DELETE_STATUS.REJECTED) {
      // Permanently unsafe: settle the row so it is not retried forever, and
      // record a sanitized security event (reason code + task/user ids only).
      logger.error('profile-image-cleanup-rejected', {
        taskId: task.id,
        userId: task.userId,
        reason: outcome.reason
      });

      return settleCleanupTask(task);
    }

    if (outcome.status === DELETE_STATUS.RETRY) {
      throw new Error('profile-image-cleanup-transient-failure');
    }

    // DELETED or MISSING: the owned file is gone, settle the task.
    return await settleCleanupTask(task);
  } catch (error) {
    const attemptCount = (task.attemptCount ?? 0) + 1;

    try {
      await prisma.profileImageCleanupTask.updateMany({
        where: { id: task.id },
        data: {
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
          lastError: String(error?.message ?? error).slice(0, 1000)
        }
      });
    } catch (persistError) {
      logger.warn('profile-image-cleanup-attempt-persist-failed', {
        taskId: task.id,
        code: persistError?.code ?? null,
        message: persistError?.message ?? 'Could not persist cleanup attempt'
      });
    }

    logger[attemptCount >= PROFILE_IMAGE_CLEANUP_MAX_ATTEMPTS ? 'error' : 'warn']('profile-image-cleanup-failed', {
      taskId: task.id,
      userId: task.userId,
      attemptCount,
      exhausted: attemptCount >= PROFILE_IMAGE_CLEANUP_MAX_ATTEMPTS,
      code: error?.code ?? null,
      message: error?.message ?? 'Profile image cleanup failed'
    });

    return { completed: false };
  }
}

async function runProfileImageCleanupSweep({
  batchSize = PROFILE_IMAGE_CLEANUP_SWEEP_BATCH_SIZE,
  maxAttempts = PROFILE_IMAGE_CLEANUP_MAX_ATTEMPTS
} = {}) {
  const tasks = await prisma.profileImageCleanupTask.findMany({
    where: {
      attemptCount: { lt: maxAttempts }
    },
    orderBy: [{ createdAt: 'asc' }],
    take: batchSize
  });
  let completedCount = 0;
  let failedCount = 0;

  for (const task of tasks) {
    const { completed } = await processProfileImageCleanupTask(task);

    if (completed) {
      completedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  if (tasks.length > 0) {
    logger.info('profile-image-cleanup-sweep', {
      scannedCount: tasks.length,
      completedCount,
      failedCount
    });
  }

  return {
    scannedCount: tasks.length,
    completedCount,
    failedCount
  };
}

function startProfileImageCleanupWorker({ intervalMs = PROFILE_IMAGE_CLEANUP_SWEEP_INTERVAL_MS } = {}) {
  if (sweepTimer) {
    return;
  }

  sweepTimer = setInterval(() => {
    runProfileImageCleanupSweep().catch((error) => {
      logger.warn('profile-image-cleanup-sweep-failed', {
        code: error?.code ?? null,
        message: error?.message ?? 'Profile image cleanup sweep failed'
      });
    });
  }, intervalMs);
  sweepTimer.unref?.();
}

function stopProfileImageCleanupWorker() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  PROFILE_IMAGE_CLEANUP_MAX_ATTEMPTS,
  captureProfileImageCleanupTask,
  processProfileImageCleanupTask,
  runProfileImageCleanupSweep,
  startProfileImageCleanupWorker,
  stopProfileImageCleanupWorker
};
