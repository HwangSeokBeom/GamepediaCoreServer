const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getFirebaseAdminState,
  initializeFirebaseAdmin,
  loadFirebaseAdminCredentials,
  resetFirebaseAdminStateForTest
} = require('../src/config/firebase-admin');

const serviceAccount = {
  project_id: 'gamepedia-test',
  client_email: 'firebase-adminsdk@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n'
};

test('Firebase credential loader prefers base64 credentials', () => {
  const base64 = Buffer.from(JSON.stringify(serviceAccount), 'utf8').toString('base64');
  const result = loadFirebaseAdminCredentials({
    FIREBASE_ADMIN_CREDENTIALS_BASE64: base64,
    FIREBASE_ADMIN_CREDENTIALS_PATH: '/not-used.json'
  });

  assert.equal(result.enabled, true);
  assert.equal(result.source, 'base64');
  assert.equal(result.projectId, 'gamepedia-test');
});

test('Firebase credential loader reads path credentials', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamepedia-firebase-'));
  const filePath = path.join(tempDir, 'firebase-adminsdk-test.json');

  fs.writeFileSync(filePath, JSON.stringify(serviceAccount));

  const result = loadFirebaseAdminCredentials({
    FIREBASE_ADMIN_CREDENTIALS_PATH: filePath
  });

  assert.equal(result.enabled, true);
  assert.equal(result.source, 'path');
  assert.equal(result.projectId, 'gamepedia-test');
});

test('Firebase credential loader restores escaped newlines for individual env', () => {
  const result = loadFirebaseAdminCredentials({
    FIREBASE_ADMIN_PROJECT_ID: 'gamepedia-test',
    FIREBASE_ADMIN_CLIENT_EMAIL: 'firebase-adminsdk@example.iam.gserviceaccount.com',
    FIREBASE_ADMIN_PRIVATE_KEY: 'line1\\nline2'
  });

  assert.equal(result.enabled, true);
  assert.equal(result.source, 'individual');
  assert.equal(result.serviceAccount.private_key, 'line1\nline2');
});

test('Firebase credential loader disables push when credentials are missing', () => {
  const result = loadFirebaseAdminCredentials({});

  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'missing_credentials');
});

test('Firebase initializer uses the modular Admin SDK API', () => {
  const firebaseEnvironmentKeys = [
    'FIREBASE_ADMIN_CREDENTIALS_BASE64',
    'FIREBASE_ADMIN_CREDENTIALS_PATH',
    'FIREBASE_ADMIN_PROJECT_ID',
    'FIREBASE_ADMIN_CLIENT_EMAIL',
    'FIREBASE_ADMIN_PRIVATE_KEY'
  ];
  const previousValues = Object.fromEntries(firebaseEnvironmentKeys.map((key) => [key, process.env[key]]));

  firebaseEnvironmentKeys.forEach((key) => delete process.env[key]);
  resetFirebaseAdminStateForTest();

  try {
    const result = initializeFirebaseAdmin();

    assert.equal(result.enabled, false);
    assert.equal(result.initialized, true);
    assert.equal(result.reason, 'missing_credentials');
    assert.deepEqual(getFirebaseAdminState(), {
      enabled: false,
      initialized: true,
      projectId: null,
      source: null,
      reason: 'missing_credentials'
    });
  } finally {
    firebaseEnvironmentKeys.forEach((key) => {
      const previousValue = previousValues[key];

      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    });
    resetFirebaseAdminStateForTest();
  }
});
