const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@127.0.0.1:5499/placeholder_unit_only';
process.env.JWT_ACCESS_SECRET ??= 'production-readiness-access-fixture';
process.env.JWT_REFRESH_SECRET ??= 'production-readiness-refresh-fixture';
process.env.ACCESS_TOKEN_EXPIRES_IN ??= '900';
process.env.REFRESH_TOKEN_EXPIRES_IN ??= '1209600';

const contract = require('../openapi/cross-platform.openapi.json');
const { createHealthHandler } = require('../src/app');
const {
  normalizeBaseUrl,
  verifyRuntimeReadiness
} = require('../scripts/server/verify-runtime-readiness');

const readyPushState = {
  enabled: true,
  initialized: true,
  projectId: 'fixture-project',
  source: 'fixture',
  reason: null
};
const readyMailState = { mode: 'smtp', verified: true, skipped: false };

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

test('production health returns 503 before an incomplete IGDB configuration can look ready', async (context) => {
  const probeApp = express();
  probeApp.get('/health', createHealthHandler({
    runtimeEnv: {
      isDevelopmentLike: false,
      twitchClientId: 'fixture-client-id',
      twitchClientSecret: null
    },
    getPushState: () => readyPushState,
    getMailState: () => readyMailState
  }));

  const server = await listen(probeApp);
  context.after(() => closeServer(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.success, true);
  assert.equal(payload.data.status, 'degraded');
  assert.deepEqual(payload.data.igdb, { required: true, configured: false });
  assert.equal(
    contract.paths['/health'].get.responses['503'].$ref,
    '#/components/responses/HealthDegraded'
  );
});

test('production health is ready only when both IGDB credential fields are configured', async (context) => {
  const probeApp = express();
  probeApp.get('/health', createHealthHandler({
    runtimeEnv: {
      isDevelopmentLike: false,
      twitchClientId: 'fixture-client-id',
      twitchClientSecret: 'fixture-client-secret'
    },
    getPushState: () => readyPushState,
    getMailState: () => readyMailState
  }));

  const server = await listen(probeApp);
  context.after(() => closeServer(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.status, 'ok');
  assert.deepEqual(payload.data.igdb, { required: true, configured: true });
});

test('deployment environment validation fails closed when either IGDB credential is absent', (context) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamepedia-deploy-env-'));
  context.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixtureDir, '.env.production'), '# deployment fixture\n');
  fs.symlinkSync(path.resolve(process.cwd(), 'src'), path.join(fixtureDir, 'src'), 'dir');

  const scriptPath = path.resolve(process.cwd(), 'scripts/server/validate-deploy-env.js');
  const baseEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    APP_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '3001',
    DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/gamepedia',
    JWT_ACCESS_SECRET: 'fixture-access-secret',
    JWT_REFRESH_SECRET: 'fixture-refresh-secret',
    ACCESS_TOKEN_EXPIRES_IN: '900',
    REFRESH_TOKEN_EXPIRES_IN: '1209600',
    APP_WEB_BASE_URL: 'https://gamepedia-api.duckdns.org',
    API_PUBLIC_BASE_URL: 'https://gamepedia-api.duckdns.org',
    MAIL_MODE: 'smtp',
    MAIL_HOST: 'smtp.example.invalid',
    MAIL_PORT: '587',
    MAIL_SECURE: 'false',
    MAIL_USER: 'fixture-user',
    MAIL_PASSWORD: 'fixture-password',
    MAIL_FROM: 'fixture@example.invalid',
    SMTP_VERIFY_ON_STARTUP: 'true'
  };

  for (const partialCredentials of [
    { TWITCH_CLIENT_ID: 'fixture-client-id' },
    { TWITCH_CLIENT_SECRET: 'fixture-client-secret' }
  ]) {
    const missing = spawnSync(process.execPath, [scriptPath, 'production'], {
      cwd: fixtureDir,
      env: { ...baseEnv, ...partialCredentials },
      encoding: 'utf8'
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must both be configured/);
  }

  const complete = spawnSync(process.execPath, [scriptPath, 'production'], {
    cwd: fixtureDir,
    env: {
      ...baseEnv,
      TWITCH_CLIENT_ID: 'fixture-client-id',
      TWITCH_CLIENT_SECRET: 'fixture-client-secret'
    },
    encoding: 'utf8'
  });
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /Validated production deployment environment/);
});

test('runtime deployment probe verifies health and a real IGDB-backed response shape', async () => {
  const requestedUrls = [];
  const payloads = [
    { success: true, data: { status: 'ok', igdb: { required: true, configured: true } } },
    { success: true, data: { games: [] } }
  ];

  await verifyRuntimeReadiness({
    baseUrl: normalizeBaseUrl('http://127.0.0.1:3001'),
    attempts: 1,
    intervalMs: 1,
    fetchImpl: async (url) => {
      requestedUrls.push(url.toString());
      return new Response(JSON.stringify(payloads.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  assert.deepEqual(requestedUrls, [
    'http://127.0.0.1:3001/health',
    'http://127.0.0.1:3001/games/highlights?limit=1'
  ]);
});

test('runtime deployment probe retries deterministically and never accepts a false-green health response', async () => {
  let fetchCount = 0;
  let waitCount = 0;

  await assert.rejects(
    verifyRuntimeReadiness({
      baseUrl: normalizeBaseUrl('http://127.0.0.1:3001'),
      attempts: 2,
      intervalMs: 1,
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({
          success: true,
          data: { status: 'degraded', igdb: { required: true, configured: false } }
        }), { status: 503 });
      },
      wait: async () => { waitCount += 1; }
    }),
    /runtime readiness failed after 2 attempt\(s\): health returned HTTP 503/
  );

  assert.equal(fetchCount, 2);
  assert.equal(waitCount, 1);
});

test('the deployment boundary blocks pm2 save until the runtime and IGDB probe passes', () => {
  const deployScript = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/server/deploy-instance.sh'),
    'utf8'
  );
  const readinessIndex = deployScript.indexOf('verify-runtime-readiness.js');
  const pm2SaveIndex = deployScript.indexOf('pm2 save');

  assert.ok(readinessIndex > 0, 'deploy-instance.sh must invoke the runtime readiness probe');
  assert.ok(pm2SaveIndex > readinessIndex, 'pm2 save must happen only after readiness passes');
  assert.match(deployScript, /--base-url "http:\/\/127\.0\.0\.1:\$\{APP_PORT\}"/);
});
