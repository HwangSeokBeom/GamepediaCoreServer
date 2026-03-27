const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');

async function assertReportTargetExists({ targetType, targetId }) {
  if (targetType === 'review') {
    const review = await prisma.review.findUnique({
      where: { id: targetId },
      select: { id: true }
    });

    if (!review) {
      throw new AppError(404, 'REPORT_TARGET_NOT_FOUND', 'Review report target could not be found');
    }

    return;
  }

  if (targetType === 'user') {
    const user = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true }
    });

    if (!user) {
      throw new AppError(404, 'REPORT_TARGET_NOT_FOUND', 'User report target could not be found');
    }
  }
}

async function submitReport({ reporterUserId, targetType, targetId, reason, detail }) {
  await assertReportTargetExists({ targetType, targetId });

  const report = await prisma.report.create({
    data: {
      reporterUserId,
      targetType,
      targetId,
      reason,
      detail: detail ?? null
    }
  });

  console.info(
    `[moderation:report] reporterUserId=${reporterUserId} reportId=${report.id} targetType=${targetType} targetId=${targetId} reason=${reason}`
  );

  return {
    reportSubmitted: true,
    reportId: report.id,
    targetType: report.targetType,
    targetId: report.targetId
  };
}

async function blockUser({ userId, blockedUserId }) {
  if (userId === blockedUserId) {
    throw new AppError(400, 'CANNOT_BLOCK_SELF', 'You cannot block your own account');
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: blockedUserId },
    select: { id: true }
  });

  if (!targetUser) {
    throw new AppError(404, 'BLOCK_TARGET_NOT_FOUND', 'User to block could not be found');
  }

  const existingBlock = await prisma.userBlock.findUnique({
    where: {
      userId_blockedUserId: {
        userId,
        blockedUserId
      }
    },
    select: { id: true }
  });

  if (!existingBlock) {
    await prisma.userBlock.create({
      data: {
        userId,
        blockedUserId
      }
    });
  }

  console.info(
    `[moderation:block] userId=${userId} blockedUserId=${blockedUserId} created=${!existingBlock}`
  );

  return {
    blocked: true,
    userId: blockedUserId
  };
}

async function unblockUser({ userId, blockedUserId }) {
  const result = await prisma.userBlock.deleteMany({
    where: {
      userId,
      blockedUserId
    }
  });

  console.info(
    `[moderation:unblock] userId=${userId} blockedUserId=${blockedUserId} removed=${result.count > 0}`
  );

  return {
    blocked: false,
    userId: blockedUserId
  };
}

async function getHiddenUserIds(currentUserId) {
  const userBlocks = await prisma.userBlock.findMany({
    where: {
      OR: [
        { userId: currentUserId },
        { blockedUserId: currentUserId }
      ]
    },
    select: {
      userId: true,
      blockedUserId: true
    }
  });

  return [...new Set(userBlocks.map((userBlock) => (
    userBlock.userId === currentUserId ? userBlock.blockedUserId : userBlock.userId
  )))];
}

module.exports = {
  blockUser,
  getHiddenUserIds,
  submitReport,
  unblockUser
};
