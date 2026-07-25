const assert = require('node:assert/strict');
const { test } = require('node:test');

// src/config/env.js requires these at load time; skip (like the postgres
// tests do) instead of crashing when the local environment is not set up.
const REQUIRED_ENV = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ACCESS_TOKEN_EXPIRES_IN',
  'REFRESH_TOKEN_EXPIRES_IN'
];
const hasRequiredEnv = REQUIRED_ENV.every((name) => typeof process.env[name] === 'string' && process.env[name].trim());
const skip = hasRequiredEnv ? false : 'requires DATABASE_URL plus JWT env vars to load src/config/env';

const env = hasRequiredEnv ? require('../src/config/env').env : null;
const emailService = hasRequiredEnv ? require('../src/services/email.service') : null;
const passwordResetEmailService = hasRequiredEnv ? require('../src/services/password-reset-email.service') : null;

// Deterministic fixtures — intentionally fake, never realistic secrets.
const FAKE_TOKEN = 'f0'.repeat(32);
const FAKE_EMAIL = 'reset-target@example.test';

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

function assertNoSensitiveContent(lines, { password } = {}) {
  const output = lines.join('\n');

  assert.ok(!output.includes(FAKE_TOKEN), `output must not contain the raw token: ${output}`);
  assert.ok(
    !output.includes(encodeURIComponent(FAKE_TOKEN)),
    `output must not contain the encoded token: ${output}`
  );
  assert.ok(!output.includes('http://'), `output must not contain a URL: ${output}`);
  assert.ok(!output.includes('https://'), `output must not contain a URL: ${output}`);
  assert.ok(!output.includes('reset-password'), `output must not contain the reset path: ${output}`);
  assert.ok(!output.includes(FAKE_EMAIL), `output must not contain the raw email: ${output}`);
  assert.ok(!output.includes('@'), `output must not contain any email address: ${output}`);
  assert.ok(!/authorization/i.test(output), `output must not contain Authorization: ${output}`);
  assert.ok(!/bearer/i.test(output), `output must not contain Bearer: ${output}`);

  if (password) {
    assert.ok(!output.includes(password), `output must not contain the password: ${output}`);
  }
}

async function withMailMode(mode, callback) {
  const originalMode = env.mailMode;
  env.mailMode = mode;

  try {
    return await callback();
  } finally {
    env.mailMode = originalMode;
    emailService.setMailSinkForTesting(null);
    emailService.setTransporterForTesting(null);
  }
}

test('log mode never prints the reset token, reset URL, or recipient email', { skip }, async () => {
  await withMailMode('log', async () => {
    const capture = captureConsole();

    try {
      const result = await passwordResetEmailService.sendPasswordResetInstructions({
        email: FAKE_EMAIL,
        token: FAKE_TOKEN
      });

      assert.deepEqual(result, { mode: 'log' });
      assert.ok(capture.lines.length > 0, 'sanitized delivery metadata must still be logged');
    } finally {
      capture.restore();
    }

    assertNoSensitiveContent(capture.lines);
    assert.ok(
      capture.lines.some((line) => line.includes('[password-reset:email] event=dispatched mode=log')),
      'delivery metadata event must be logged'
    );
  });
});

test('log mode delivers the generated mail to a test sink without console logging it', { skip }, async () => {
  await withMailMode('log', async () => {
    const captured = [];
    emailService.setMailSinkForTesting((message) => captured.push(message));

    const capture = captureConsole();

    try {
      await passwordResetEmailService.sendPasswordResetInstructions({
        email: FAKE_EMAIL,
        token: FAKE_TOKEN
      });
    } finally {
      capture.restore();
    }

    assert.equal(captured.length, 1, 'the generated mail must reach the test sink');
    assert.equal(captured[0].to, FAKE_EMAIL);
    assert.ok(captured[0].text.includes(FAKE_TOKEN), 'the sink must expose the token for tests');
    assert.ok(captured[0].text.includes('/reset-password?token='), 'the sink must expose the reset URL');
    assert.ok(captured[0].html.includes(FAKE_TOKEN), 'the sink must expose the html body');

    assertNoSensitiveContent(capture.lines);
  });
});

test('SMTP success logs do not print the raw email or the reset URL', { skip }, async () => {
  await withMailMode('smtp', async () => {
    const sent = [];
    emailService.setTransporterForTesting({
      sendMail: async (message) => {
        sent.push(message);
        return { messageId: '<fake-id@mailer.example.test>' };
      }
    });

    const capture = captureConsole();

    try {
      const result = await passwordResetEmailService.sendPasswordResetInstructions({
        email: FAKE_EMAIL,
        token: FAKE_TOKEN
      });

      assert.deepEqual(result, { mode: 'smtp' });
    } finally {
      capture.restore();
    }

    assert.equal(sent.length, 1, 'the transport must receive the message');
    assert.equal(sent[0].to, FAKE_EMAIL, 'the transport must receive the real recipient');
    assert.ok(sent[0].text.includes(FAKE_TOKEN), 'the transport must receive the token-bearing body');

    assertNoSensitiveContent(capture.lines);
    assert.ok(
      capture.lines.some((line) => line.includes('[email] event=mail_sent mode=smtp')),
      'sanitized success metadata must be logged'
    );
  });
});

test('SMTP failure logs and thrown errors are sanitized', { skip }, async () => {
  await withMailMode('smtp', async () => {
    const transportError = new Error(
      `Cannot deliver to ${FAKE_EMAIL}: rejected body https://app.example.test/reset-password?token=${FAKE_TOKEN}`
    );
    transportError.code = 'ECONNECTION';

    emailService.setTransporterForTesting({
      sendMail: async () => {
        throw transportError;
      }
    });

    const capture = captureConsole();
    let thrownError;

    try {
      await assert.rejects(
        passwordResetEmailService.sendPasswordResetInstructions({
          email: FAKE_EMAIL,
          token: FAKE_TOKEN
        }),
        (error) => {
          thrownError = error;
          return error instanceof emailService.MailDeliveryError;
        }
      );
    } finally {
      capture.restore();
    }

    assert.equal(thrownError.reasonCode, 'econnection');
    assert.ok(!thrownError.message.includes(FAKE_TOKEN), 'thrown error must not contain the token');
    assert.ok(!thrownError.message.includes(FAKE_EMAIL), 'thrown error must not contain the email');
    assert.ok(!thrownError.message.includes('https://'), 'thrown error must not contain the URL');

    assertNoSensitiveContent(capture.lines);
    assert.ok(
      capture.lines.some((line) => line.includes('[email] event=mail_send_failed mode=smtp reason=econnection')),
      'sanitized failure metadata must be logged'
    );
  });
});

test('SMTP failures with unknown error codes collapse to a generic reason', { skip }, async () => {
  await withMailMode('smtp', async () => {
    const transportError = new Error(`recipient=${FAKE_EMAIL}`);
    transportError.code = `WEIRD ${FAKE_EMAIL}`;

    emailService.setTransporterForTesting({
      sendMail: async () => {
        throw transportError;
      }
    });

    const capture = captureConsole();

    try {
      await assert.rejects(
        emailService.sendMail({ to: FAKE_EMAIL, subject: 's', text: 't', html: '<p>t</p>' }),
        (error) => error instanceof emailService.MailDeliveryError && error.reasonCode === 'transport_error'
      );
    } finally {
      capture.restore();
    }

    assertNoSensitiveContent(capture.lines);
  });
});
