'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const winston = require('winston');

const authService = require('../src/services/auth.service');
const { AppError } = require('../src/utils/error-response');
const { buildLogFormatter, logger } = require('../src/utils/logger');
const { app, logSocialAuthRequest } = require('../src/app');

const SENSITIVE_VALUES = Object.freeze({
  authorizationCode: 'SENTINEL_AUTHORIZATION_CODE_4D91',
  code: 'SENTINEL_CODE_9A62',
  idToken: 'SENTINEL_ID_TOKEN_2B73',
  accessToken: 'SENTINEL_ACCESS_TOKEN_8C04',
  refreshToken: 'SENTINEL_REFRESH_TOKEN_6E15',
  clientSecret: 'SENTINEL_CLIENT_SECRET_7F26',
  bearer: 'SENTINEL_BEARER_1A37',
  cookie: 'SENTINEL_COOKIE_3B48',
  identityToken: 'SENTINEL_IDENTITY_TOKEN_5C59'
});

function createWinstonCapture() {
  const stream = new PassThrough();
  let output = '';
  stream.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });

  const transport = new winston.transports.Stream({
    stream,
    format: buildLogFormatter()
  });
  logger.add(transport);

  return {
    output: () => output,
    close() {
      logger.remove(transport);
      transport.destroy();
      stream.destroy();
    }
  };
}

function createConsoleCapture() {
  const methods = ['log', 'info', 'warn', 'error'];
  const originals = Object.fromEntries(methods.map((method) => [method, console[method]]));
  const entries = [];

  for (const method of methods) {
    console[method] = (...values) => {
      entries.push({ method, values });
    };
  }

  return {
    output: () => entries
      .map(({ method, values }) => `${method}:${values.map((value) => String(value)).join(' ')}`)
      .join('\n'),
    close() {
      for (const method of methods) {
        console[method] = originals[method];
      }
    }
  };
}

async function listen() {
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

async function postJson(baseUrl, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      connection: 'close',
      ...headers
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    payload: await response.json()
  };
}

function assertNoSensitiveOutput(output) {
  for (const [name, sentinel] of Object.entries(SENSITIVE_VALUES)) {
    assert.doesNotMatch(output, new RegExp(sentinel, 'i'), `${name} escaped into a logging sink`);
  }

  assert.doesNotMatch(
    output,
    /\?(?:authorizationCode|code|id_token|access_token|refresh_token|client_secret)=/i,
    'raw OAuth query-string keys must not be emitted'
  );
  assert.doesNotMatch(output, /authorization:\s*bearer|cookie:\s*/i);
}

test('real OAuth request logging keeps allowlisted metadata and excludes credentials from every sink', async (context) => {
  const originalAppleLogin = authService.appleLogin;
  let handlerInput;
  authService.appleLogin = async (input) => {
    handlerInput = input;
    return {
      user: { id: 'fixture-user' },
      tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' }
    };
  };
  context.after(() => {
    authService.appleLogin = originalAppleLogin;
  });

  const winstonCapture = createWinstonCapture();
  const consoleCapture = createConsoleCapture();
  context.after(() => {
    consoleCapture.close();
    winstonCapture.close();
  });

  const server = await listen();
  context.after(() => closeServer(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const query = new URLSearchParams({
    authorizationCode: SENSITIVE_VALUES.authorizationCode,
    code: SENSITIVE_VALUES.code,
    id_token: SENSITIVE_VALUES.idToken,
    access_token: SENSITIVE_VALUES.accessToken,
    refresh_token: SENSITIVE_VALUES.refreshToken,
    client_secret: SENSITIVE_VALUES.clientSecret
  });

  const response = await postJson(
    baseUrl,
    `/auth/apple?${query}`,
    {
      identityToken: SENSITIVE_VALUES.identityToken,
      authorizationCode: SENSITIVE_VALUES.authorizationCode,
      code: SENSITIVE_VALUES.code,
      id_token: SENSITIVE_VALUES.idToken,
      access_token: SENSITIVE_VALUES.accessToken,
      refresh_token: SENSITIVE_VALUES.refreshToken,
      client_secret: SENSITIVE_VALUES.clientSecret,
      deviceName: 'privacy-regression-device'
    },
    {
      authorization: `Bearer ${SENSITIVE_VALUES.bearer}`,
      cookie: `session=${SENSITIVE_VALUES.cookie}`
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(handlerInput, {
    identityToken: SENSITIVE_VALUES.identityToken,
    deviceName: 'privacy-regression-device'
  }, 'request logging must not alter the validated OAuth handler input');

  await new Promise((resolve) => setImmediate(resolve));
  const winstonOutput = winstonCapture.output();
  const consoleOutput = consoleCapture.output();
  assertNoSensitiveOutput(winstonOutput);
  assertNoSensitiveOutput(consoleOutput);
  assert.match(winstonOutput, /social-auth-request/);
  assert.match(winstonOutput, /"method":"POST"/);
  assert.match(winstonOutput, /"path":"\/auth\/apple"/);
  assert.match(winstonOutput, /"route":"social-auth"/);
  assert.match(winstonOutput, /"provider":"apple"/);
});

test('social auth logging middleware does not mutate the request object', () => {
  const request = {
    method: 'POST',
    path: '/auth/google',
    body: { idToken: 'opaque-test-token' },
    query: { code: 'opaque-test-code' },
    headers: { authorization: 'Bearer opaque-test-bearer' },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  };
  const bodyReference = request.body;
  const queryReference = request.query;
  const headersReference = request.headers;
  const snapshot = structuredClone(request);
  let nextCalled = false;

  logSocialAuthRequest(request, {}, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(request.body, bodyReference);
  assert.equal(request.query, queryReference);
  assert.equal(request.headers, headersReference);
  assert.deepEqual(request, snapshot);
});

test('logger failure does not replace the original OAuth request error', async (context) => {
  const originalAppleLogin = authService.appleLogin;
  const originalMethods = {
    info: logger.info,
    warn: logger.warn,
    error: logger.error
  };
  authService.appleLogin = async () => {
    throw new AppError(409, 'ORIGINAL_OAUTH_FAILURE', 'Original OAuth failure');
  };
  logger.info = () => {
    throw new Error('logger-info-failure');
  };
  logger.warn = () => {
    throw new Error('logger-warn-failure');
  };
  logger.error = () => {
    throw new Error('logger-error-failure');
  };
  context.after(() => {
    authService.appleLogin = originalAppleLogin;
    logger.info = originalMethods.info;
    logger.warn = originalMethods.warn;
    logger.error = originalMethods.error;
  });

  const server = await listen();
  context.after(() => closeServer(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await postJson(baseUrl, '/auth/apple', {
    identityToken: 'opaque-invalid-apple-token'
  });

  assert.equal(response.status, 409);
  assert.equal(response.payload.error.code, 'ORIGINAL_OAUTH_FAILURE');
  assert.equal(response.payload.error.message, 'Original OAuth failure');
});

test('nested Axios-style provider errors are reduced before reaching the formatted logger sink', async () => {
  const capture = createWinstonCapture();
  const sentinel = 'SENTINEL_NESTED_AXIOS_SECRET_0D71';
  const providerError = new Error(`provider response ${sentinel}`);
  providerError.name = 'AxiosError';
  providerError.code = 'ERR_BAD_RESPONSE';
  providerError.config = {
    url: `https://provider.invalid/token?client_secret=${sentinel}`,
    headers: {
      authorization: `Bearer ${sentinel}`,
      cookie: `session=${sentinel}`
    },
    data: {
      refresh_token: sentinel
    }
  };
  providerError.response = {
    status: 401,
    data: {
      access_token: sentinel,
      id_token: sentinel
    }
  };

  try {
    logger.error('oauth-provider-request-failed', {
      operation: 'token-exchange',
      error: providerError
    });
    await new Promise((resolve) => setImmediate(resolve));
    const output = capture.output();

    assert.match(output, /oauth-provider-request-failed/);
    assert.match(output, /"operation":"token-exchange"/);
    assert.match(output, /"errorCategory":"ERR_BAD_RESPONSE"/);
    assert.doesNotMatch(output, new RegExp(sentinel, 'i'));
    assert.doesNotMatch(output, /client_secret|authorization|cookie|refresh_token|access_token|id_token/i);
  } finally {
    capture.close();
  }
});
