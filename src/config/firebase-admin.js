const fs = require('fs');
const admin = require('firebase-admin');
const { logger } = require('../utils/logger');

let firebaseAdminState = {
  enabled: false,
  initialized: false,
  projectId: null,
  source: null,
  reason: 'not_initialized'
};

function readEnvValue(env, name) {
  const value = env?.[name];

  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : null;
}

function parseServiceAccountJson(rawJson, source) {
  let parsed;

  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    return {
      enabled: false,
      reason: `${source}_json_invalid`
    };
  }

  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    return {
      enabled: false,
      reason: `${source}_fields_missing`
    };
  }

  return {
    enabled: true,
    source,
    projectId: parsed.project_id,
    serviceAccount: parsed
  };
}

function loadFirebaseAdminCredentials(env = process.env, fileSystem = fs) {
  const base64Credentials = readEnvValue(env, 'FIREBASE_ADMIN_CREDENTIALS_BASE64');

  if (base64Credentials) {
    try {
      const decodedJson = Buffer.from(base64Credentials, 'base64').toString('utf8');

      return parseServiceAccountJson(decodedJson, 'base64');
    } catch (error) {
      return {
        enabled: false,
        reason: 'base64_decode_failed'
      };
    }
  }

  const credentialsPath = readEnvValue(env, 'FIREBASE_ADMIN_CREDENTIALS_PATH');

  if (credentialsPath) {
    try {
      const rawJson = fileSystem.readFileSync(credentialsPath, 'utf8');

      return parseServiceAccountJson(rawJson, 'path');
    } catch (error) {
      return {
        enabled: false,
        reason: 'path_read_failed'
      };
    }
  }

  const projectId = readEnvValue(env, 'FIREBASE_ADMIN_PROJECT_ID');
  const clientEmail = readEnvValue(env, 'FIREBASE_ADMIN_CLIENT_EMAIL');
  const privateKey = readEnvValue(env, 'FIREBASE_ADMIN_PRIVATE_KEY');

  if (projectId || clientEmail || privateKey) {
    if (!projectId || !clientEmail || !privateKey) {
      return {
        enabled: false,
        reason: 'individual_fields_missing'
      };
    }

    return {
      enabled: true,
      source: 'individual',
      projectId,
      serviceAccount: {
        project_id: projectId,
        client_email: clientEmail,
        private_key: privateKey.replace(/\\n/g, '\n')
      }
    };
  }

  return {
    enabled: false,
    reason: 'missing_credentials'
  };
}

function initializeFirebaseAdmin() {
  if (firebaseAdminState.initialized) {
    return firebaseAdminState;
  }

  if (admin.apps.length > 0) {
    const app = admin.app();

    firebaseAdminState = {
      enabled: true,
      initialized: true,
      app,
      messaging: admin.messaging(app),
      projectId: app.options?.projectId ?? null,
      source: 'existing_app',
      reason: null
    };
    return firebaseAdminState;
  }

  const credentials = loadFirebaseAdminCredentials();

  if (!credentials.enabled) {
    firebaseAdminState = {
      enabled: false,
      initialized: true,
      projectId: null,
      source: null,
      reason: credentials.reason
    };
    logger.warn('[FirebaseAdmin] push disabled', {
      reason: credentials.reason
    });
    return firebaseAdminState;
  }

  try {
    const app = admin.initializeApp({
      credential: admin.credential.cert(credentials.serviceAccount),
      projectId: credentials.projectId
    });

    firebaseAdminState = {
      enabled: true,
      initialized: true,
      app,
      messaging: admin.messaging(app),
      projectId: credentials.projectId,
      source: credentials.source,
      reason: null
    };

    logger.info('[FirebaseAdmin] initialized', {
      projectId: credentials.projectId,
      source: credentials.source
    });
    return firebaseAdminState;
  } catch (error) {
    firebaseAdminState = {
      enabled: false,
      initialized: true,
      projectId: credentials.projectId,
      source: credentials.source,
      reason: 'initialization_failed'
    };

    logger.error('[FirebaseAdmin] initialization failed', {
      projectId: credentials.projectId,
      source: credentials.source,
      message: error?.message ?? 'Firebase Admin initialization failed'
    });
    return firebaseAdminState;
  }
}

function getFirebaseAdminState() {
  return {
    enabled: firebaseAdminState.enabled,
    initialized: firebaseAdminState.initialized,
    projectId: firebaseAdminState.projectId,
    source: firebaseAdminState.source,
    reason: firebaseAdminState.reason
  };
}

function getFirebaseMessaging() {
  const state = initializeFirebaseAdmin();

  return state.enabled ? state.messaging : null;
}

function resetFirebaseAdminStateForTest() {
  firebaseAdminState = {
    enabled: false,
    initialized: false,
    projectId: null,
    source: null,
    reason: 'not_initialized'
  };
}

module.exports = {
  getFirebaseAdminState,
  getFirebaseMessaging,
  initializeFirebaseAdmin,
  loadFirebaseAdminCredentials,
  resetFirebaseAdminStateForTest
};
