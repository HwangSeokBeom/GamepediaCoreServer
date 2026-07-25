'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';

function boundedWait(promise, label, timeoutMs = 10_000) {
  let timeout;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)), timeoutMs);
    timeout.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

async function closeServer(server) {
  if (!server) return;

  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

test('concurrent HTTP signup maps the email uniqueness race to EMAIL_ALREADY_IN_USE', { skip: !enabled }, async () => {
  const { app } = require('../src/app');
  const { prisma } = require('../src/config/prisma');
  const nonce = crypto.randomUUID();
  const normalizedEmail = `signup-race-${nonce}@example.invalid`;
  const originalFindUnique = prisma.user.findUnique.bind(prisma.user);
  let arrivals = 0;
  let releasePrecheck;
  let signalBothArrived;
  let server;
  const bothArrived = new Promise((resolve) => {
    signalBothArrived = resolve;
  });
  const precheckRelease = new Promise((resolve) => {
    releasePrecheck = resolve;
  });

  prisma.user.findUnique = async (args) => {
    const result = await originalFindUnique(args);
    const requestedEmail = args?.where?.email;

    if (requestedEmail === normalizedEmail && result === null) {
      arrivals += 1;

      if (arrivals === 2) {
        signalBothArrived();
      }

      await boundedWait(precheckRelease, 'signup precheck release');
    }

    return result;
  };

  try {
    server = await new Promise((resolve, reject) => {
      const candidate = app.listen(0, '127.0.0.1');
      candidate.once('error', reject);
      candidate.once('listening', () => resolve(candidate));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const submit = (nickname) => fetch(`${baseUrl}/auth/signup`, {
      method: 'POST',
      headers: {
        connection: 'close',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        email: normalizedEmail.toUpperCase(),
        password: 'integration-password-1',
        nickname
      })
    });
    const responsesPromise = Promise.all([
      submit(`signup-a-${nonce}`.slice(0, 30)),
      submit(`signup-b-${nonce}`.slice(0, 30))
    ]);

    await boundedWait(bothArrived, 'both signup email prechecks');
    assert.equal(arrivals, 2);
    releasePrecheck();

    const responses = await boundedWait(responsesPromise, 'concurrent signup responses');
    const results = await Promise.all(responses.map(async (response) => ({
      status: response.status,
      body: await response.json()
    })));
    const success = results.filter((result) => result.status === 201);
    const conflict = results.filter((result) => result.status === 409);

    assert.equal(success.length, 1);
    assert.equal(conflict.length, 1);
    assert.equal(conflict[0].body.success, false);
    assert.equal(conflict[0].body.error.code, 'EMAIL_ALREADY_IN_USE');
    assert.doesNotMatch(JSON.stringify(conflict[0].body), /P2002|Prisma|Unique constraint/i);
    assert.equal(await prisma.user.count({ where: { email: normalizedEmail } }), 1);
  } finally {
    releasePrecheck?.();
    prisma.user.findUnique = originalFindUnique;
    await closeServer(server).catch(() => {});
    await prisma.user.deleteMany({ where: { email: normalizedEmail } }).catch(() => {});
    await prisma.$disconnect();
  }
});
