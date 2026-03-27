module.exports = {
  apps: [
    {
      name: 'core-server',
      script: 'src/server.js',
      cwd: __dirname,
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
      cwd: __dirname,
      env_staging: {
        NODE_ENV: 'staging',
        PORT: '3101',
      },
    },
  ],
};
