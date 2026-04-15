const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function resolveNodeEnv(nodeEnv) {
  if (typeof nodeEnv !== 'string') {
    return null;
  }

  const trimmedNodeEnv = nodeEnv.trim();

  return trimmedNodeEnv.length > 0 ? trimmedNodeEnv : null;
}

function getNodeEnv() {
  return resolveNodeEnv(process.env.NODE_ENV) ?? 'development';
}

function getEnvFilePaths(nodeEnv = getNodeEnv(), cwd = process.cwd()) {
  return [
    path.resolve(cwd, '.env'),
    path.resolve(cwd, '.env.local'),
    path.resolve(cwd, `.env.${nodeEnv}`),
    path.resolve(cwd, `.env.${nodeEnv}.local`)
  ];
}

function loadEnvFile(filePath, override = false) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  dotenv.config({
    path: filePath,
    override,
    quiet: true
  });
}

function loadEnvironment(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const nodeEnv = resolveNodeEnv(options.nodeEnv) ?? getNodeEnv();
  const envFilePaths = getEnvFilePaths(nodeEnv, cwd);

  process.env.NODE_ENV = nodeEnv;

  envFilePaths.forEach((filePath, index) => {
    loadEnvFile(filePath, index > 0);
  });

  process.env.NODE_ENV = nodeEnv;

  return {
    nodeEnv,
    envFilePaths
  };
}

module.exports = {
  getEnvFilePaths,
  getNodeEnv,
  loadEnvironment
};
