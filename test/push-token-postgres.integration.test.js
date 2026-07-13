const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function cleanupPostgresTest({ prisma, server, users }) {
  let cleanupError;

  try {
    await closeServer(server);
  } catch (error) {
    cleanupError = error;
  }

  try {
    if (users.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    }
  } catch (error) {
    cleanupError ??= error;
  }

  try {
    await prisma.$disconnect();
  } catch (error) {
    cleanupError ??= error;
  }

  if (cleanupError) throw cleanupError;
}

test('PostgreSQL test cleanup always disconnects after listener and fixture cleanup failures', async () => {
  const calls = [];
  const server = {
    close(callback) {
      calls.push('close');
      callback(new Error('fixture close failure'));
    },
    closeAllConnections() {
      calls.push('closeAllConnections');
    }
  };
  const prisma = {
    user: {
      async deleteMany() {
        calls.push('deleteMany');
        throw new Error('fixture delete failure');
      }
    },
    async $disconnect() {
      calls.push('$disconnect');
    }
  };

  await assert.rejects(
    cleanupPostgresTest({ prisma, server, users: [{ id: 'fixture-user' }] }),
    /fixture close failure/
  );
  assert.deepEqual(calls, ['close', 'closeAllConnections', 'deleteMany', '$disconnect']);
});

test('PostgreSQL keeps exactly one owner during concurrent push-token registration', { skip: !enabled }, async () => {
  const crypto = require('node:crypto');
  const express = require('express');
  const { prisma } = require('../src/config/prisma');
  const pushTokenController = require('../src/modules/push/push-token.controller');
  const { validate } = require('../src/middlewares/validate.middleware');
  const { errorHandler } = require('../src/middlewares/error.middleware');
  const { buildUserValidationError, pushTokenRegistrationSchema } = require('../src/modules/user/user.validator');
  const nonce = crypto.randomUUID();
  const users = [];
  const token = `integration-push-token-${nonce}`;
  const app = express();
  app.use(express.json());
  app.put('/users/me/push-token', (req, res, next) => {
    req.auth = { userId: req.get('x-test-user-id') };
    next();
  }, validate({ body: pushTokenRegistrationSchema, errorMapper: buildUserValidationError }), pushTokenController.registerMyPushToken);
  app.use(errorHandler);
  let server;

  try {
    for (const index of [1, 2]) {
      users.push(await prisma.user.create({
        data: {
          email: `push-owner-${index}-${nonce}@example.invalid`,
          nickname: `push-${index}-${nonce}`.slice(0, 50),
          passwordHash: 'integration-test-not-a-real-password-hash'
        }
      }));
    }
    server = await new Promise((resolve, reject) => {
      const candidate = app.listen(0, '127.0.0.1');
      candidate.once('error', reject);
      candidate.once('listening', () => resolve(candidate));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const responses = await Promise.all(users.map((user, index) => fetch(`${baseUrl}/users/me/push-token`, {
      method: 'PUT',
      headers: { connection: 'close', 'content-type': 'application/json', 'x-test-user-id': user.id },
      body: JSON.stringify({
        token,
        platform: 'ios',
        deviceId: `device-${index}-${nonce}`,
        environment: 'test'
      })
    })));
    await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.ok(responses.every((response) => response.status < 500));
    const owners = await prisma.userPushToken.findMany({ where: { token, isActive: true } });
    assert.equal(owners.length, 1);
    assert.ok(users.some((user) => user.id === owners[0].userId));
    assert.equal(await prisma.userPushToken.count({ where: { token } }), 1);
  } finally {
    await cleanupPostgresTest({ prisma, server, users });
  }
});

test('PostgreSQL stores and reassigns a 4096-character push token by fixed-size hash', { skip: !enabled }, async () => {
  const crypto = require('node:crypto');
  const express = require('express');
  const { prisma } = require('../src/config/prisma');
  const pushTokenController = require('../src/modules/push/push-token.controller');
  const { validate } = require('../src/middlewares/validate.middleware');
  const { errorHandler } = require('../src/middlewares/error.middleware');
  const { buildUserValidationError, pushTokenRegistrationSchema } = require('../src/modules/user/user.validator');
  const { hashPushToken } = require('../src/modules/push/push-token.utils');
  const nonce = crypto.randomUUID();
  const users = [];
  const token = '한'.repeat(4096);
  const app = express();
  app.use(express.json());
  app.put('/users/me/push-token', (req, res, next) => {
    req.auth = { userId: req.get('x-test-user-id') };
    next();
  }, validate({ body: pushTokenRegistrationSchema, errorMapper: buildUserValidationError }), pushTokenController.registerMyPushToken);
  app.use(errorHandler);
  let server;
  let baseUrl;

  async function register(userId, candidateToken, deviceId) {
    const response = await fetch(`${baseUrl}/users/me/push-token`, {
      method: 'PUT',
      headers: {
        connection: 'close',
        'content-type': 'application/json',
        'x-test-user-id': userId
      },
      body: JSON.stringify({
        token: candidateToken,
        platform: 'android',
        deviceId,
        environment: 'test'
      })
    });
    return { status: response.status, payload: await response.json() };
  }

  try {
    for (const index of [1, 2]) {
      users.push(await prisma.user.create({
        data: {
          email: `push-boundary-${index}-${nonce}@example.invalid`,
          nickname: `boundary-${index}-${nonce}`.slice(0, 50),
          passwordHash: 'integration-test-not-a-real-password-hash'
        }
      }));
    }
    server = await new Promise((resolve, reject) => {
      const candidate = app.listen(0, '127.0.0.1');
      candidate.once('error', reject);
      candidate.once('listening', () => resolve(candidate));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    for (const [index, user] of users.entries()) {
      const result = await register(user.id, token, `boundary-device-${index}-${nonce}`);
      assert.equal(result.status, 200);
      assert.equal(result.payload.success, true);
    }

    const rows = await prisma.userPushToken.findMany({ where: { tokenHash: hashPushToken(token) } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, users[1].id);
    assert.equal(rows[0].token, token);
    assert.equal(rows[0].tokenHash.length, 64);

    const rowCountBeforeOversizedRequest = await prisma.userPushToken.count({
      where: { userId: { in: users.map((user) => user.id) } }
    });
    const oversized = await register(users[1].id, '한'.repeat(4097), `oversized-device-${nonce}`);
    assert.equal(oversized.status, 400);
    assert.equal(oversized.payload.success, false);
    assert.equal(oversized.payload.error.code, 'PUSH_TOKEN_INVALID');
    assert.equal(await prisma.userPushToken.count({
      where: { userId: { in: users.map((user) => user.id) } }
    }), rowCountBeforeOversizedRequest);
  } finally {
    await cleanupPostgresTest({ prisma, server, users });
  }
});
