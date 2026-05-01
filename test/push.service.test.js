const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../src/config/prisma');
const { env } = require('../src/config/env');
const firebaseAdmin = require('../src/config/firebase-admin');
const pushService = require('../src/modules/push/push.service');

function withPushServiceStubs(stubs, callback) {
  const originals = {
    getFirebaseMessaging: firebaseAdmin.getFirebaseMessaging,
    getFirebaseAdminState: firebaseAdmin.getFirebaseAdminState,
    findMany: prisma.userPushToken.findMany,
    updateMany: prisma.userPushToken.updateMany,
    count: prisma.userNotification.count
  };

  firebaseAdmin.getFirebaseMessaging = stubs.getFirebaseMessaging ?? originals.getFirebaseMessaging;
  firebaseAdmin.getFirebaseAdminState = stubs.getFirebaseAdminState ?? originals.getFirebaseAdminState;
  prisma.userPushToken.findMany = stubs.findMany ?? originals.findMany;
  prisma.userPushToken.updateMany = stubs.updateMany ?? originals.updateMany;
  prisma.userNotification.count = stubs.count ?? originals.count;

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      firebaseAdmin.getFirebaseMessaging = originals.getFirebaseMessaging;
      firebaseAdmin.getFirebaseAdminState = originals.getFirebaseAdminState;
      prisma.userPushToken.findMany = originals.findMany;
      prisma.userPushToken.updateMany = originals.updateMany;
      prisma.userNotification.count = originals.count;
    });
}

test('PushService skips when a user has no active tokens', async () => {
  await withPushServiceStubs({
    getFirebaseMessaging: () => ({
      sendEachForMulticast: async () => {
        throw new Error('should not send');
      }
    }),
    findMany: async () => []
  }, async () => {
    const result = await pushService.sendToUser('00000000-0000-0000-0000-000000000000', {
      notification: {
        title: 'title',
        body: 'body'
      },
      data: {
        type: 'test_push'
      }
    });

    assert.equal(result.sent, false);
    assert.equal(result.skippedReason, 'noActiveToken');
    assert.equal(result.tokenCount, 0);
  });
});

test('PushService stringifies data and deactivates invalid tokens', async () => {
  let capturedMessage = null;
  let deactivatedIds = [];

  await withPushServiceStubs({
    getFirebaseMessaging: () => ({
      sendEachForMulticast: async (message) => {
        capturedMessage = message;
        return {
          successCount: 1,
          failureCount: 1,
          responses: [
            { success: true },
            {
              success: false,
              error: {
                code: 'messaging/registration-token-not-registered'
              }
            }
          ]
        };
      }
    }),
    findMany: async () => [
      { id: 'token-1', token: 'fcm-token-1' },
      { id: 'token-2', token: 'fcm-token-2' }
    ],
    updateMany: async ({ where }) => {
      deactivatedIds = where.id.in;
      return { count: deactivatedIds.length };
    },
    count: async () => 7
  }, async () => {
    const result = await pushService.sendToUser('00000000-0000-0000-0000-000000000000', {
      notification: {
        title: 'title',
        body: 'body'
      },
      data: {
        type: 'review_liked',
        notificationId: 123,
        optional: null
      }
    });

    assert.equal(result.successCount, 1);
    assert.equal(result.failureCount, 1);
    assert.equal(result.invalidTokenCount, 1);
    assert.deepEqual(deactivatedIds, ['token-2']);
    assert.equal(capturedMessage.data.notificationId, '123');
    assert.equal(capturedMessage.data.source, 'push');
    assert.equal(capturedMessage.data.optional, undefined);
    assert.equal(capturedMessage.apns.payload.aps.badge, 7);
  });
});

test('test push is disabled in production environments', () => {
  const originalNodeEnv = env.nodeEnv;
  const originalAppEnv = env.appEnv;

  env.nodeEnv = 'production';
  env.appEnv = 'production';

  try {
    assert.equal(pushService.isTestPushAllowed(), false);
  } finally {
    env.nodeEnv = originalNodeEnv;
    env.appEnv = originalAppEnv;
  }
});
