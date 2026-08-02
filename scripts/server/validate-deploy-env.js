#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getEnvFilePaths, loadEnvironment } = require('../../src/config/load-env');

const targetEnv = process.argv[2];
const projectDir = process.cwd();

const targetConfig = {
  production: {
    envName: 'production',
    expectedPort: '3001',
    expectedDatabaseName: 'gamepedia',
    expectedPublicUrl: 'https://gamepedia-api.duckdns.org'
  },
  staging: {
    envName: 'staging',
    expectedPort: '3101',
    expectedDatabaseName: 'gamepedia_core_staging',
    expectedPublicUrl: 'https://staging-gamepedia-api.duckdns.org'
  }
};

function fail(message) {
  console.error(`Deployment aborted: ${message}`);
  process.exit(1);
}

function normalizeUrl(rawValue, variableName) {
  try {
    return new URL(rawValue).toString();
  } catch (error) {
    fail(`${variableName} must be a valid absolute URL`);
  }
}

function readTrimmedEnv(name) {
  const rawValue = process.env[name];

  if (typeof rawValue !== 'string') {
    return null;
  }

  const trimmedValue = rawValue.trim();

  return trimmedValue.length > 0 ? trimmedValue : null;
}

function extractDatabaseName(databaseUrl) {
  try {
    const parsedUrl = new URL(databaseUrl);
    const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, '').split('/')[0] || '');

    if (!databaseName) {
      fail('DATABASE_URL must include a database name in the path');
    }

    return databaseName;
  } catch (error) {
    fail('DATABASE_URL must be a valid absolute PostgreSQL URL');
  }
}

if (!targetEnv || !targetConfig[targetEnv]) {
  fail('Usage: node scripts/server/validate-deploy-env.js <production|staging>');
}

const config = targetConfig[targetEnv];
const expectedPublicUrl = normalizeUrl(config.expectedPublicUrl, 'expected public URL');
const envSpecificPath = path.resolve(projectDir, `.env.${config.envName}`);
const envSpecificLocalPath = path.resolve(projectDir, `.env.${config.envName}.local`);

if (!fs.existsSync(envSpecificPath) && !fs.existsSync(envSpecificLocalPath)) {
  fail(`missing .env.${config.envName} or .env.${config.envName}.local`);
}

process.env.NODE_ENV = config.envName;
loadEnvironment({ cwd: projectDir, nodeEnv: config.envName });

if (!readTrimmedEnv('PORT')) {
  process.env.PORT = config.expectedPort;
}

const envModulePath = path.resolve(projectDir, 'src/config/env.js');
delete require.cache[envModulePath];

let env;

try {
  ({ env } = require(envModulePath));
} catch (error) {
  fail(error.message);
}

if (env.nodeEnv !== config.envName) {
  fail(`NODE_ENV must resolve to ${config.envName}, received ${env.nodeEnv}`);
}

if (String(env.port) !== config.expectedPort) {
  fail(`PORT must resolve to ${config.expectedPort}, received ${env.port}`);
}

if (extractDatabaseName(env.databaseUrl) !== config.expectedDatabaseName) {
  fail(`DATABASE_URL must target ${config.expectedDatabaseName}`);
}

if (normalizeUrl(env.appWebBaseUrl, 'APP_WEB_BASE_URL') !== expectedPublicUrl) {
  fail(`APP_WEB_BASE_URL must be ${config.expectedPublicUrl}`);
}

const apiPublicBaseUrl = readTrimmedEnv('API_PUBLIC_BASE_URL');

if (apiPublicBaseUrl && normalizeUrl(apiPublicBaseUrl, 'API_PUBLIC_BASE_URL') !== expectedPublicUrl) {
  fail(`API_PUBLIC_BASE_URL must be ${config.expectedPublicUrl}`);
}

const loadedEnvFiles = getEnvFilePaths(config.envName, projectDir)
  .filter((filePath) => fs.existsSync(filePath))
  .map((filePath) => path.relative(projectDir, filePath));

console.log(`Validated ${config.envName} deployment environment`);
console.log(`Loaded env files: ${loadedEnvFiles.join(', ')}`);
