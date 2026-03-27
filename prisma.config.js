const path = require('path');
const { defineConfig } = require('prisma/config');
const { loadEnvironment } = require('./src/config/load-env');

const { nodeEnv } = loadEnvironment({ cwd: __dirname });
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(`DATABASE_URL is required for Prisma when NODE_ENV=${nodeEnv}`);
}

module.exports = defineConfig({
  schema: path.resolve(__dirname, 'prisma/schema.prisma'),
  engine: 'classic',
  datasource: {
    url: databaseUrl
  }
});
