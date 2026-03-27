const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function getNodeEnv() {
  const nodeEnv = process.env.NODE_ENV?.trim();

  return nodeEnv ? nodeEnv : 'development';
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
  const nodeEnv = getNodeEnv();
  const envFilePaths = getEnvFilePaths(nodeEnv, cwd);

  envFilePaths.forEach((filePath, index) => {
    loadEnvFile(filePath, index > 0);
  });

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
