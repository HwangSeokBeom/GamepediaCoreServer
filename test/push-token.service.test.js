const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../src/config/prisma');
const pushTokenService = require('../src/modules/push/push-token.service');
const { hashPushToken } = require('../src/modules/push/push-token.utils');

function createPushTokenTableStub(rows) {
  return {
    async deleteMany({ where }) {
      let count = 0;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        const matches = row.userId === where.userId && row.deviceId === where.deviceId &&
          row.platform === where.platform && row.environment === where.environment &&
          row.tokenHash !== where.tokenHash.not;
        if (matches) {
          rows.splice(index, 1);
          count += 1;
        }
      }
      return { count };
    },
    async upsert({ where, update, create }) {
      const row = rows.find((item) => item.tokenHash === where.tokenHash);
      if (row) {
        Object.assign(row, update);
        return row;
      }
      const created = { id: `row-${rows.length + 1}`, ...create };
      rows.push(created);
      return created;
    },
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
    deleteMany: prisma.userPushToken.deleteMany,
    upsert: prisma.userPushToken.upsert,
    updateMany: prisma.userPushToken.updateMany,
    findFirst: prisma.userPushToken.findFirst,
    update: prisma.userPushToken.update,
    create: prisma.userPushToken.create
  };
  const tableStub = createPushTokenTableStub(rows);

  prisma.$transaction = async (handler) => handler({
    userPushToken: tableStub
  });
  prisma.userPushToken.deleteMany = tableStub.deleteMany;
  prisma.userPushToken.upsert = tableStub.upsert;
  prisma.userPushToken.updateMany = tableStub.updateMany;
  prisma.userPushToken.findFirst = tableStub.findFirst;
  prisma.userPushToken.update = tableStub.update;
  prisma.userPushToken.create = tableStub.create;

  try {
    return await callback();
  } finally {
    prisma.$transaction = originalTransaction;
    prisma.userPushToken.deleteMany = originalTable.deleteMany;
    prisma.userPushToken.upsert = originalTable.upsert;
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

test('push token registration atomically transfers the same token to another user', async () => {
  const rows = [{
    id: 'old-row',
    userId: 'user-1',
    token: '12345678901234567890',
    tokenHash: hashPushToken('12345678901234567890'),
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

    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, 'user-2');
    assert.equal(rows[0].isActive, true);
  });
});

test('push token registration preserves and hashes the 4096-character boundary token', async () => {
  const rows = [];
  const token = 'x'.repeat(4096);

  await withPushTokenServiceStubs(rows, async () => {
    await pushTokenService.registerPushToken({
      userId: 'user-1',
      token,
      platform: 'android'
    });

    assert.equal(rows[0].token, token);
    assert.equal(rows[0].tokenHash, hashPushToken(token));
    assert.equal(rows[0].tokenHash.length, 64);
  });
});

test('push token hashing preserves a 4096-character multibyte token', async () => {
  const rows = [];
  const token = '한'.repeat(4096);

  await withPushTokenServiceStubs(rows, async () => {
    await pushTokenService.registerPushToken({ userId: 'user-1', token, platform: 'ios' });
    assert.equal(rows[0].token, token);
    assert.equal(rows[0].tokenHash, hashPushToken(token));
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
