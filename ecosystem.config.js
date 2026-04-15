const fs = require('fs');
const os = require('os');
const path = require('path');

const homeDir = process.env.HOME || os.homedir();
const defaultProductionCwd = path.join(homeDir, 'GamePediaCoreServer-prod');
const defaultStagingCwd = path.join(homeDir, 'GamePediaCoreServer-staging');

function resolveAppCwd(appName, configuredCwd, expectedDirName) {
  if (!path.isAbsolute(configuredCwd)) {
    throw new Error(`${appName} cwd must be an absolute path: ${configuredCwd}`);
  }

  if (path.basename(configuredCwd) !== expectedDirName) {
    throw new Error(`${appName} cwd must point to ${expectedDirName}, received ${configuredCwd}`);
  }

  if (!fs.existsSync(configuredCwd)) {
    throw new Error(`${appName} cwd does not exist: ${configuredCwd}`);
  }

  return configuredCwd;
}

module.exports = {
  apps: [
    {
      name: 'core-server',
      script: 'src/server.js',
      cwd: resolveAppCwd(
        'core-server',
        process.env.CORE_SERVER_PRODUCTION_CWD || defaultProductionCwd,
        'GamePediaCoreServer-prod'
      ),
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
      cwd: resolveAppCwd(
        'core-server-staging',
        process.env.CORE_SERVER_STAGING_CWD || defaultStagingCwd,
        'GamePediaCoreServer-staging'
      ),
      env_staging: {
        NODE_ENV: 'staging',
        PORT: '3101',
      },
    },
  ],
};
