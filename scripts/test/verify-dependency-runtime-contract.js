#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
const deployScript = fs.readFileSync(
  path.join(root, 'scripts/server/deploy-instance.sh'),
  'utf8'
);
const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');

assert.equal(packageJson.engines.node, '>=22.0.0');
assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node);
assert.equal(packageJson.dependencies['firebase-admin'], '14.2.0');
assert.equal(packageLock.packages[''].dependencies['firebase-admin'], '14.2.0');
assert.equal(packageJson.devDependencies['@redocly/cli'], '2.41.2');
assert.match(npmrc, /^engine-strict=true$/m);
assert.match(npmrc, /^omit=optional$/m);
assert.match(workflow, /^\s*NODE_VERSION: '22'$/m);
assert.match(workflow, /npm run test:dependency-security/);
assert.match(
  deployScript,
  /^npm ci --omit=dev --omit=optional$/m,
  'deployment must install exactly the audited runtime tree'
);

process.stdout.write('Dependency runtime contract verified.\n');
