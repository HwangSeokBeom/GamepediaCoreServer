const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Loads src/config/env.js in a child process with a fully controlled
// environment and an empty working directory, so no local .env files or shell
// variables leak into the startup-validation assertions.
const ENV_MODULE_PATH = path.resolve(__dirname, '..', 'src', 'config', 'env.js');

const BASE_ENV = {
  DATABASE_URL: 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  JWT_ACCESS_SECRET: 'placeholder-access-secret',
  JWT_REFRESH_SECRET: 'placeholder-refresh-secret',
  ACCESS_TOKEN_EXPIRES_IN: '15m',
  REFRESH_TOKEN_EXPIRES_IN: '30d'
};

const SMTP_ENV = {
  MAIL_HOST: 'smtp.example.test',
  MAIL_USER: 'mailer@example.test',
  MAIL_PASSWORD: 'placeholder-smtp-password',
  MAIL_FROM: 'GamePedia <no-reply@example.test>'
};

function loadEnvInChildProcess(extraEnv) {
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gamepedia-env-test-'));

  try {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const { env } = require(${JSON.stringify(ENV_MODULE_PATH)});` +
          'process.stdout.write(JSON.stringify({ mailMode: env.mailMode }));'
      ],
      {
        cwd: emptyCwd,
        env: { ...BASE_ENV, ...extraEnv },
        encoding: 'utf8',
        timeout: 30000
      }
    );

    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? ''
    };
  } finally {
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  }
}

test('production rejects MAIL_MODE=log at startup', () => {
  const result = loadEnvInChildProcess({
    NODE_ENV: 'production',
    APP_WEB_BASE_URL: 'https://app.example.test',
    MAIL_MODE: 'log'
  });

  assert.notEqual(result.status, 0, 'startup must fail');
  assert.match(result.stderr, /MAIL_MODE=log is not allowed when NODE_ENV=production/);
});

test('production rejects EMAIL_DELIVERY_MODE=log fallback at startup', () => {
  const result = loadEnvInChildProcess({
    NODE_ENV: 'production',
    APP_WEB_BASE_URL: 'https://app.example.test',
    EMAIL_DELIVERY_MODE: 'log'
  });

  assert.notEqual(result.status, 0, 'startup must fail');
  assert.match(result.stderr, /MAIL_MODE=log is not allowed when NODE_ENV=production/);
});

test('production does not default to log mode when MAIL_MODE is omitted', () => {
  const result = loadEnvInChildProcess({
    NODE_ENV: 'production',
    APP_WEB_BASE_URL: 'https://app.example.test'
  });

  assert.notEqual(result.status, 0, 'startup must fail');
  assert.match(result.stderr, /MAIL_MODE must be set explicitly when NODE_ENV=production/);
});

test('production fails startup when SMTP mode has no delivery configuration', () => {
  const result = loadEnvInChildProcess({
    NODE_ENV: 'production',
    APP_WEB_BASE_URL: 'https://app.example.test',
    MAIL_MODE: 'smtp'
  });

  assert.notEqual(result.status, 0, 'startup must fail');
  assert.match(result.stderr, /Missing required SMTP environment variables/);
});

test('production starts with a complete SMTP configuration', () => {
  const result = loadEnvInChildProcess({
    NODE_ENV: 'production',
    APP_WEB_BASE_URL: 'https://app.example.test',
    MAIL_MODE: 'smtp',
    ...SMTP_ENV
  });

  assert.equal(result.status, 0, `startup must succeed, stderr: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { mailMode: 'smtp' });
});

test('staging is treated as production-like for MAIL_MODE', () => {
  const result = loadEnvInChildProcess({
    NODE_ENV: 'staging',
    APP_WEB_BASE_URL: 'https://staging.example.test',
    MAIL_MODE: 'log'
  });

  assert.notEqual(result.status, 0, 'startup must fail');
  assert.match(result.stderr, /MAIL_MODE=log is not allowed when NODE_ENV=staging/);
});

test('development keeps a usable non-sending default without MAIL_MODE', () => {
  const result = loadEnvInChildProcess({
    NODE_ENV: 'development'
  });

  assert.equal(result.status, 0, `startup must succeed, stderr: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { mailMode: 'log' });
});

test('test environment keeps a usable non-sending default without MAIL_MODE', () => {
  const result = loadEnvInChildProcess({
    NODE_ENV: 'test'
  });

  assert.equal(result.status, 0, `startup must succeed, stderr: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { mailMode: 'log' });
});
