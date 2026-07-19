const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

// Deterministic unit tests for the pre-listen SMTP verification. Every test
// injects a fake transporter; nothing here opens a network connection.
// node --test runs each file in its own process, so seeding placeholder env
// values does not leak into other test files.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
process.env.JWT_ACCESS_SECRET ??= 'placeholder-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'placeholder-refresh-secret';
process.env.ACCESS_TOKEN_EXPIRES_IN ??= '15m';
process.env.REFRESH_TOKEN_EXPIRES_IN ??= '30d';

const { env } = require('../src/config/env');
const emailService = require('../src/services/email.service');

// Sentinel values that must never appear in any log output.
const SECRET_HOST = 'smtp.secret-host.example.test';
const SECRET_USER = 'secret-user@example.test';
const SECRET_PASSWORD = 'secret-smtp-password-value';
const RAW_TRANSPORT_MESSAGE = `535 auth rejected for ${SECRET_USER} at ${SECRET_HOST}`;

function captureConsole() {
  const lines = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };

  for (const level of Object.keys(originals)) {
    console[level] = (...args) => {
      lines.push(args.map((value) => String(value)).join(' '));
    };
  }

  return {
    lines,
    restore() {
      for (const [level, fn] of Object.entries(originals)) {
        console[level] = fn;
      }
    }
  };
}

function makeFakeTransporter({ verifyError, verifyDelayMs } = {}) {
  const calls = { verify: 0, close: 0, sendMail: 0 };

  return {
    calls,
    verify() {
      calls.verify += 1;

      if (verifyDelayMs === Infinity) {
        return new Promise(() => {});
      }

      if (verifyError) {
        return Promise.reject(verifyError);
      }

      return Promise.resolve(true);
    },
    close() {
      calls.close += 1;
    },
    async sendMail() {
      calls.sendMail += 1;
      return { messageId: '<fake@local>' };
    }
  };
}

function transportError(code, message = RAW_TRANSPORT_MESSAGE) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function expectVerificationFailure(transporter, expectedReason, { timeoutMs } = {}) {
  const capture = captureConsole();

  try {
    await assert.rejects(
      emailService.verifySmtpTransport({ transporter, timeoutMs }),
      (error) => {
        assert.ok(error instanceof emailService.SmtpVerificationError);
        assert.equal(error.reasonCode, expectedReason);
        return true;
      }
    );
  } finally {
    capture.restore();
  }

  const output = capture.lines.join('\n');
  assert.ok(output.includes(`event=smtp_verify_failed reason=${expectedReason}`), `sanitized failure log expected: ${output}`);
  assert.ok(!output.includes(SECRET_HOST), 'log must not contain the SMTP host');
  assert.ok(!output.includes(SECRET_USER), 'log must not contain the SMTP user');
  assert.ok(!output.includes(SECRET_PASSWORD), 'log must not contain the SMTP password');
  assert.ok(!output.includes('535'), 'log must not contain raw transport error text');

  return capture.lines;
}

beforeEach(() => {
  emailService.resetMailStateForTesting();
  env.mailMode = 'smtp';
  env.smtpVerifyOnStartup = true;
  env.mailHost = SECRET_HOST;
  env.mailUser = SECRET_USER;
  env.mailPassword = SECRET_PASSWORD;
});

test('valid SMTP verification permits startup readiness', async () => {
  const transporter = makeFakeTransporter();
  emailService.setTransporterForTesting(transporter);

  const capture = captureConsole();

  try {
    const readiness = await emailService.verifyMailStartupReadiness();

    assert.deepEqual(readiness, { mode: 'smtp', verified: true, skipped: false });
  } finally {
    capture.restore();
  }

  assert.equal(transporter.calls.verify, 1);
  assert.deepEqual(emailService.getMailReadinessState(), { mode: 'smtp', verified: true, skipped: false });
  assert.ok(capture.lines.some((line) => line.includes('event=smtp_verified')));
});

test('invalid credentials reject startup with smtp_auth_failure', async () => {
  await expectVerificationFailure(makeFakeTransporter({ verifyError: transportError('EAUTH') }), 'smtp_auth_failure');
});

test('DNS failure rejects startup with smtp_dns_failure', async () => {
  await expectVerificationFailure(makeFakeTransporter({ verifyError: transportError('EDNS') }), 'smtp_dns_failure');
  await expectVerificationFailure(makeFakeTransporter({ verifyError: transportError('ENOTFOUND') }), 'smtp_dns_failure');
});

test('connection-refused failure rejects startup with smtp_connection_failure', async () => {
  await expectVerificationFailure(
    makeFakeTransporter({ verifyError: transportError('ECONNREFUSED') }),
    'smtp_connection_failure'
  );
  await expectVerificationFailure(
    makeFakeTransporter({ verifyError: transportError('ECONNECTION') }),
    'smtp_connection_failure'
  );
});

test('TLS failure rejects startup with smtp_tls_failure', async () => {
  await expectVerificationFailure(makeFakeTransporter({ verifyError: transportError('ETLS') }), 'smtp_tls_failure');
  await expectVerificationFailure(
    makeFakeTransporter({ verifyError: transportError('CERT_HAS_EXPIRED') }),
    'smtp_tls_failure'
  );
  await expectVerificationFailure(
    makeFakeTransporter({ verifyError: transportError('ERR_TLS_CERT_ALTNAME_INVALID') }),
    'smtp_tls_failure'
  );
});

test('verification timeout rejects startup with smtp_timeout and settles its timer', async () => {
  const activeTimeouts = new Set();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  global.setTimeout = (...args) => {
    const handle = originalSetTimeout(...args);
    activeTimeouts.add(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    activeTimeouts.delete(handle);
    return originalClearTimeout(handle);
  };

  try {
    const transporter = makeFakeTransporter({ verifyDelayMs: Infinity });

    await expectVerificationFailure(transporter, 'smtp_timeout', { timeoutMs: 50 });
    assert.equal(transporter.calls.close, 1, 'timed-out verification must close the transporter');
    assert.equal(activeTimeouts.size, 0, 'verification must not leave timers pending');
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('a fast successful verification leaves no pending timer', async () => {
  const activeTimeouts = new Set();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  global.setTimeout = (...args) => {
    const handle = originalSetTimeout(...args);
    activeTimeouts.add(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    activeTimeouts.delete(handle);
    return originalClearTimeout(handle);
  };

  try {
    const capture = captureConsole();

    try {
      await emailService.verifySmtpTransport({ transporter: makeFakeTransporter(), timeoutMs: 60000 });
    } finally {
      capture.restore();
    }

    assert.equal(activeTimeouts.size, 0, 'the timeout timer must be cleared after success');
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('unknown transport errors collapse to smtp_transport_failure without raw text', async () => {
  const weirdError = transportError(`EWEIRD ${SECRET_USER}`);

  const lines = await expectVerificationFailure(makeFakeTransporter({ verifyError: weirdError }), 'smtp_transport_failure');

  assert.ok(!lines.join('\n').includes('EWEIRD'), 'log must not contain the raw error code');

  const capture = captureConsole();

  try {
    await emailService.verifySmtpTransport({ transporter: makeFakeTransporter({ verifyError: weirdError }) });
    assert.fail('verification must reject');
  } catch (error) {
    assert.ok(!error.message.includes(SECRET_USER), 'thrown error must not contain the SMTP user');
    assert.ok(!error.message.includes(SECRET_HOST), 'thrown error must not contain the SMTP host');
    assert.ok(!error.message.includes('535'), 'thrown error must not contain raw transport text');
  } finally {
    capture.restore();
  }
});

test('startup readiness verification runs exactly once per process', async () => {
  const transporter = makeFakeTransporter();
  emailService.setTransporterForTesting(transporter);

  const capture = captureConsole();

  try {
    const [first, second] = await Promise.all([
      emailService.verifyMailStartupReadiness(),
      emailService.verifyMailStartupReadiness()
    ]);
    const third = await emailService.verifyMailStartupReadiness();

    assert.deepEqual(first, { mode: 'smtp', verified: true, skipped: false });
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
  } finally {
    capture.restore();
  }

  assert.equal(transporter.calls.verify, 1, 'concurrent and repeated callers must share one verification');
});

test('development log mode does not verify SMTP', async () => {
  env.mailMode = 'log';
  emailService.resetMailStateForTesting();

  const transporter = makeFakeTransporter();
  emailService.setTransporterForTesting(transporter);

  const readiness = await emailService.verifyMailStartupReadiness();

  assert.deepEqual(readiness, { mode: 'log', verified: false, skipped: true });
  assert.equal(transporter.calls.verify, 0, 'log mode must never contact SMTP');
});

test('test mode does not verify SMTP unless explicitly requested', async () => {
  env.smtpVerifyOnStartup = false;

  const transporter = makeFakeTransporter();
  emailService.setTransporterForTesting(transporter);

  const skipped = await emailService.verifyMailStartupReadiness();

  assert.deepEqual(skipped, { mode: 'smtp', verified: false, skipped: true });
  assert.equal(transporter.calls.verify, 0);

  emailService.resetMailStateForTesting();
  env.smtpVerifyOnStartup = true;
  emailService.setTransporterForTesting(transporter);

  const capture = captureConsole();

  try {
    const verified = await emailService.verifyMailStartupReadiness();
    assert.deepEqual(verified, { mode: 'smtp', verified: true, skipped: false });
  } finally {
    capture.restore();
  }

  assert.equal(transporter.calls.verify, 1, 'explicit opt-in must verify');
});

test('a successfully verified transporter is reused for delivery', async () => {
  const transporter = makeFakeTransporter();
  emailService.setTransporterForTesting(transporter);

  const capture = captureConsole();

  try {
    await emailService.verifyMailStartupReadiness();
    const delivery = await emailService.sendMail({
      to: 'recipient@example.test',
      subject: 's',
      text: 't',
      html: '<p>t</p>'
    });

    assert.equal(delivery.mode, 'smtp');
  } finally {
    capture.restore();
  }

  assert.equal(transporter.calls.verify, 1);
  assert.equal(transporter.calls.sendMail, 1, 'delivery must reuse the verified transporter');
});

test('failed verification closes the transporter and drops it from the cache', async () => {
  const failing = makeFakeTransporter({ verifyError: transportError('EAUTH') });
  emailService.setTransporterForTesting(failing);

  const capture = captureConsole();

  try {
    await assert.rejects(
      emailService.verifyMailStartupReadiness(),
      (error) => error instanceof emailService.SmtpVerificationError && error.reasonCode === 'smtp_auth_failure'
    );
  } finally {
    capture.restore();
  }

  assert.equal(failing.calls.close, 1, 'failed verification must close the transporter');
  assert.equal(emailService.getMailReadinessState().verified, false, 'mail must never be reported verified after failure');
});
