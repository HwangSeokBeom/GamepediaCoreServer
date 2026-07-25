const assert = require('node:assert/strict');
const { test } = require('node:test');

// Bootstrap-ordering tests: startServer() with fully injected dependencies.
// Nothing here binds a port, opens a database connection, or contacts SMTP.
// node --test isolates each file in its own process, so the placeholder env
// below stays local to this file.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
process.env.JWT_ACCESS_SECRET ??= 'placeholder-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'placeholder-refresh-secret';
process.env.ACCESS_TOKEN_EXPIRES_IN ??= '15m';
process.env.REFRESH_TOKEN_EXPIRES_IN ??= '30d';

const { startServer } = require('../src/server');
const { SmtpVerificationError } = require('../src/services/email.service');

const RAW_TRANSPORT_MESSAGE = 'connect ECONNREFUSED smtp.secret-host.example.test:587 user=secret-user pass=secret-pass';

function makeDeps({ verifyMailStartupReadiness } = {}) {
  const calls = [];
  const logged = [];

  const deps = {
    calls,
    logged,
    connectDatabase: async () => calls.push('connectDatabase'),
    disconnectDatabase: async () => calls.push('disconnectDatabase'),
    probeRedisConnection: async () => calls.push('probeRedisConnection'),
    initializeFirebaseAdmin: () => {
      calls.push('initializeFirebaseAdmin');
      return { enabled: false, reason: 'test' };
    },
    startProfileImageCleanupWorker: () => calls.push('startProfileImageCleanupWorker'),
    verifyMailStartupReadiness:
      verifyMailStartupReadiness ??
      (async () => {
        calls.push('verifyMailStartupReadiness');
        return { mode: 'smtp', verified: true, skipped: false };
      }),
    closeMailTransport: () => calls.push('closeMailTransport'),
    listen: (onListening) => {
      calls.push('listen');

      if (typeof onListening === 'function') {
        onListening();
      }

      return { close: (callback) => callback && callback() };
    },
    exit: (code) => calls.push(`exit(${code})`),
    logger: {
      info: (message, meta) => logged.push({ level: 'info', message, meta }),
      error: (message, meta) => logged.push({ level: 'error', message, meta })
    }
  };

  return deps;
}

test('successful verification: listen is called exactly once, after verification', async () => {
  const deps = makeDeps();

  const server = await startServer(deps);

  assert.ok(server, 'startServer must return the listening server');
  assert.equal(deps.calls.filter((call) => call === 'listen').length, 1, 'listen must run exactly once');
  assert.equal(deps.calls.filter((call) => call === 'verifyMailStartupReadiness').length, 1, 'verification must run exactly once');
  assert.ok(
    deps.calls.indexOf('verifyMailStartupReadiness') < deps.calls.indexOf('listen'),
    `SMTP verification must complete before listen: ${deps.calls.join(' -> ')}`
  );
  assert.ok(!deps.calls.some((call) => call.startsWith('exit(')), 'successful startup must not exit');

  const startedLog = deps.logged.find((entry) => entry.message === 'GamePedia auth server started');
  assert.ok(startedLog, 'startup must log the started event');
  assert.equal(startedLog.meta.mailVerified, true);
});

test('failed SMTP verification: listen is never called and the process exits non-zero', async () => {
  const deps = makeDeps({
    verifyMailStartupReadiness: async () => {
      deps.calls.push('verifyMailStartupReadiness');
      throw new SmtpVerificationError('smtp_connection_failure');
    }
  });

  const server = await startServer(deps);

  assert.equal(server, null);
  assert.ok(!deps.calls.includes('listen'), 'listen must never run after failed verification');
  assert.ok(!deps.calls.includes('startProfileImageCleanupWorker'), 'workers must not start after failed verification');
  assert.ok(deps.calls.includes('exit(1)'), 'failed verification must exit non-zero');
  assert.ok(deps.calls.includes('closeMailTransport'), 'failed startup must release transporter resources');
  assert.ok(deps.calls.includes('disconnectDatabase'), 'failed startup must disconnect the database');

  const failureLog = deps.logged.find((entry) => entry.level === 'error');
  assert.ok(failureLog, 'failed startup must log one clear error');
  assert.equal(failureLog.meta.error.message, 'SMTP verification failed: smtp_connection_failure');
});

test('startup failure logging never contains raw transport error text', async () => {
  // Even if a dependency throws a raw error, the SMTP verification layer
  // wraps transport failures before they reach this path; this asserts the
  // bootstrap does not add raw SMTP details of its own.
  const deps = makeDeps({
    verifyMailStartupReadiness: async () => {
      throw new SmtpVerificationError('smtp_auth_failure');
    }
  });

  await startServer(deps);

  const serialized = JSON.stringify(deps.logged, (key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }

    return value;
  });

  assert.ok(!serialized.includes('secret-host'), 'logs must not contain the SMTP host');
  assert.ok(!serialized.includes('secret-user'), 'logs must not contain the SMTP user');
  assert.ok(!serialized.includes('secret-pass'), 'logs must not contain the SMTP password');
  assert.ok(!serialized.includes(RAW_TRANSPORT_MESSAGE), 'logs must not contain raw transport text');
  assert.ok(serialized.includes('smtp_auth_failure'), 'logs must carry the stable reason code');
});

test('verification ordering: database and redis precede verification', async () => {
  const deps = makeDeps();

  await startServer(deps);

  const order = deps.calls;
  assert.ok(order.indexOf('connectDatabase') < order.indexOf('verifyMailStartupReadiness'));
  assert.ok(order.indexOf('probeRedisConnection') < order.indexOf('verifyMailStartupReadiness'));
});
