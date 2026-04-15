const fs = require('fs');
const os = require('os');
const path = require('path');

const homeDir = process.env.HOME || os.homedir();
const defaultProductionCwd = path.join(homeDir, 'GamePediaCoreServer-prod');
const defaultStagingCwd = path.join(homeDir, 'GamePediaCoreServer-staging');

function resolveAppCwd(preferredCwd) {
  return fs.existsSync(preferredCwd) ? preferredCwd : __dirname;
}

module.exports = {
  apps: [
    {
      name: 'core-server',
      script: 'src/server.js',
      cwd: resolveAppCwd(process.env.CORE_SERVER_PRODUCTION_CWD || defaultProductionCwd),
      env_development: {
        NODE_ENV: 'development',
        PORT: '3001',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
    },
    {
      name: 'core-server-staging',
      script: 'src/server.js',
      cwd: resolveAppCwd(process.env.CORE_SERVER_STAGING_CWD || defaultStagingCwd),
      env_staging: {
        NODE_ENV: 'staging',
        PORT: '3101',
      },
    },
  ],
};
