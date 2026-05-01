const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../src/config/prisma');
const pushTokenService = require('../src/modules/push/push-token.service');

function createPushTokenTableStub(rows) {
  return {
    async updateMany({ where, data }) {
      let count = 0;

      for (const row of rows) {
        const tokenMatches = where.token === undefined || row.token === where.token;
        const userMatches = where.userId?.not ? row.userId !== where.userId.not : row.userId === where.userId;
        const activeMatches = where.isActive === undefined || row.isActive === where.isActive;
        const orMatches = !where.OR || where.OR.some((filter) => (
          (filter.deviceId && row.deviceId === filter.deviceId) ||
          (filter.token && row.token === filter.token)
        ));

        if (tokenMatches && userMatches && activeMatches && orMatches) {
          Object.assign(row, data);
          count += 1;
        }
      }

      return { count };
    },
    async findFirst({ where }) {
      return rows.find((row) => (
        (!where.userId || row.userId === where.userId) &&
        (!where.token || row.token === where.token) &&
        (!where.deviceId || row.deviceId === where.deviceId) &&
        (!where.platform || row.platform === where.platform) &&
        (where.environment === undefined || row.environment === where.environment)
      )) ?? null;
    },
    async update({ where, data }) {
      const row = rows.find((item) => item.id === where.id);
      Object.assign(row, data);
      return row;
    },
    async create({ data }) {
      const row = {
        id: `row-${rows.length + 1}`,
        ...data
      };
      rows.push(row);
      return row;
    }
  };
}

async function withPushTokenServiceStubs(rows, callback) {
  const originalTransaction = prisma.$transaction;
  const originalTable = {
    updateMany: prisma.userPushToken.updateMany,
    findFirst: prisma.userPushToken.findFirst,
    update: prisma.userPushToken.update,
    create: prisma.userPushToken.create
  };
  const tableStub = createPushTokenTableStub(rows);

  prisma.$transaction = async (handler) => handler({
    userPushToken: tableStub
  });
  prisma.userPushToken.updateMany = tableStub.updateMany;
  prisma.userPushToken.findFirst = tableStub.findFirst;
  prisma.userPushToken.update = tableStub.update;
  prisma.userPushToken.create = tableStub.create;

  try {
    return await callback();
  } finally {
    prisma.$transaction = originalTransaction;
    prisma.userPushToken.updateMany = originalTable.updateMany;
    prisma.userPushToken.findFirst = originalTable.findFirst;
    prisma.userPushToken.update = originalTable.update;
    prisma.userPushToken.create = originalTable.create;
  }
}

test('push token registration creates a new active device token', async () => {
  const rows = [];

  await withPushTokenServiceStubs(rows, async () => {
    const result = await pushTokenService.registerPushToken({
      userId: 'user-1',
      token: '12345678901234567890',
      platform: 'ios',
      deviceId: 'device-1',
      appVersion: '1.1.1',
      buildNumber: '5',
      environment: 'dev'
    });

    assert.equal(result.registered, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].isActive, true);
    assert.equal(rows[0].deviceId, 'device-1');
  });
});

test('push token registration deactivates the same active token on another user', async () => {
  const rows = [{
    id: 'old-row',
    userId: 'user-1',
    token: '12345678901234567890',
    platform: 'ios',
    deviceId: 'device-old',
    environment: 'dev',
    isActive: true
  }];

  await withPushTokenServiceStubs(rows, async () => {
    await pushTokenService.registerPushToken({
      userId: 'user-2',
      token: '12345678901234567890',
      platform: 'ios',
      deviceId: 'device-2',
      environment: 'dev'
    });

    assert.equal(rows[0].isActive, false);
    assert.equal(rows[1].userId, 'user-2');
    assert.equal(rows[1].isActive, true);
  });
});

test('push token delete is idempotent', async () => {
  const rows = [{
    id: 'row-1',
    userId: 'user-1',
    token: '12345678901234567890',
    platform: 'ios',
    deviceId: 'device-1',
    isActive: false
  }];

  await withPushTokenServiceStubs(rows, async () => {
    const result = await pushTokenService.deletePushToken({
      userId: 'user-1',
      deviceId: 'device-1'
    });

    assert.equal(result.deactivated, true);
    assert.equal(rows[0].isActive, false);
  });
});
