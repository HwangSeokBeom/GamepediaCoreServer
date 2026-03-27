module.exports = {
  apps: [
    {
      name: 'core-server',
      script: 'src/server.js',
      cwd: __dirname,
      env_development: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
