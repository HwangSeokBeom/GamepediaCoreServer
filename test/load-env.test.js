const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnvironment } = require('../src/config/load-env');

function withEnvironment(callback) {
  const original = { ...process.env };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gamepedia-env-'));

  try {
    return callback(directory);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('shell DATABASE_URL remains authoritative over every dotenv file', () => withEnvironment((cwd) => {
  fs.writeFileSync(path.join(cwd, '.env'), 'DATABASE_URL=postgresql://file/base\n');
  fs.writeFileSync(path.join(cwd, '.env.local'), 'DATABASE_URL=postgresql://file/local\n');
  fs.writeFileSync(path.join(cwd, '.env.test'), 'DATABASE_URL=postgresql://file/test\n');
  fs.writeFileSync(path.join(cwd, '.env.test.local'), 'DATABASE_URL=postgresql://file/test-local\n');
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://shell/isolated';

  loadEnvironment({ cwd });

  assert.equal(process.env.DATABASE_URL, 'postgresql://shell/isolated');
  assert.equal(process.env.NODE_ENV, 'test');
}));

test('environment-specific local file wins when the shell does not define a value', () => withEnvironment((cwd) => {
  fs.writeFileSync(path.join(cwd, '.env'), 'DATABASE_URL=postgresql://file/base\n');
  fs.writeFileSync(path.join(cwd, '.env.local'), 'DATABASE_URL=postgresql://file/local\n');
  fs.writeFileSync(path.join(cwd, '.env.production'), 'DATABASE_URL=postgresql://file/production\n');
  fs.writeFileSync(path.join(cwd, '.env.production.local'), 'DATABASE_URL=postgresql://file/production-local\n');
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'production';

  loadEnvironment({ cwd });

  assert.equal(process.env.DATABASE_URL, 'postgresql://file/production-local');
}));

test('development is the default and explicit nodeEnv remains authoritative', () => withEnvironment((cwd) => {
  fs.writeFileSync(path.join(cwd, '.env.development'), 'APP_ENV_SOURCE=development\n');
  delete process.env.NODE_ENV;
  loadEnvironment({ cwd });
  assert.equal(process.env.NODE_ENV, 'development');
  assert.equal(process.env.APP_ENV_SOURCE, 'development');

  loadEnvironment({ cwd, nodeEnv: 'test' });
  assert.equal(process.env.NODE_ENV, 'test');
}));
