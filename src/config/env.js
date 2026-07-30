const { loadEnvironment } = require('./load-env');

const { nodeEnv: bootstrapNodeEnv } = loadEnvironment();

function readEnv(name) {
  const value = process.env[name];

  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : null;
}

function parseUrl(name, fallbackValue = null) {
  const rawValue = readEnv(name) ?? fallbackValue;

  if (!rawValue) {
    return null;
  }

  try {
    return new URL(rawValue).toString();
  } catch (error) {
    throw new Error(`Environment variable ${name} must be a valid absolute URL`);
  }
}

function requireEnv(name) {
  const value = readEnv(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseNumber(name, fallbackValue) {
  const rawValue = readEnv(name) ?? fallbackValue;
  const parsedValue = Number(rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return parsedValue;
}

function parseNonNegativeNumber(name, fallbackValue) {
  const rawValue = readEnv(name) ?? fallbackValue;
  const parsedValue = Number(rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer`);
  }

  return parsedValue;
}

function parseBoundedNumber(name, fallbackValue, { min, max }) {
  const parsedValue = parseNumber(name, fallbackValue);

  if (parsedValue < min || parsedValue > max) {
    throw new Error(`Environment variable ${name} must be between ${min} and ${max}`);
  }

  return parsedValue;
}

function parseBoolean(name, fallbackValue) {
  const rawValue = (readEnv(name) ?? fallbackValue).toLowerCase();

  if (rawValue === 'true') {
    return true;
  }

  if (rawValue === 'false') {
    return false;
  }

  throw new Error(`Environment variable ${name} must be "true" or "false"`);
}

const nodeEnv = readEnv('NODE_ENV') ?? bootstrapNodeEnv;
const isDevelopmentLike = nodeEnv === 'development' || nodeEnv === 'test';
const appEnv = readEnv('APP_ENV') ?? nodeEnv;

function resolveMailMode() {
  // The non-sending "log" mode may only be defaulted in development/test.
  // Production-like environments must opt into a delivery mode explicitly and
  // fail closed at startup instead of silently falling back.
  const rawMailMode = readEnv('MAIL_MODE') ?? readEnv('EMAIL_DELIVERY_MODE') ?? (isDevelopmentLike ? 'log' : null);

  if (!rawMailMode) {
    throw new Error(`MAIL_MODE must be set explicitly when NODE_ENV=${nodeEnv} (expected: smtp)`);
  }

  const mailMode = rawMailMode.toLowerCase();

  if (!['log', 'smtp'].includes(mailMode)) {
    throw new Error('Environment variable MAIL_MODE must be one of: log, smtp');
  }

  return mailMode;
}

const port = parseNumber('PORT', '3000');
const llmProvider = (readEnv('LLM_PROVIDER') ?? 'openai').toLowerCase();

// Product 2.2 kill switches. Every feature has an independent default so a
// single failing feature can be turned off without touching the others, and a
// database override row is not required for the shipped behavior.
const PRODUCT_FEATURE_FLAG_KEYS = Object.freeze([
  'openCatalog',
  'aiQuickAdd',
  'playlog',
  'playCompass',
  'gameDNA',
  'monthlyReplay',
  'todayFeed',
  'magazine'
]);

function toEnvSegment(flagKey) {
  return flagKey
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

function resolveProductFeatureDefaults() {
  return Object.freeze(Object.fromEntries(PRODUCT_FEATURE_FLAG_KEYS.map((flagKey) => [
    flagKey,
    parseBoolean(`PRODUCT_FEATURE_${toEnvSegment(flagKey)}_ENABLED`, 'true')
  ])));
}

function getLlmProviderDefaults(provider) {
  if (provider === 'gemini') {
    return {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash'
    };
  }

  if (provider === 'groq') {
    return {
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-8b-instant'
    };
  }

  return {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  };
}

const llmProviderDefaults = getLlmProviderDefaults(llmProvider);

const env = {
  nodeEnv,
  appEnv,
  isDevelopmentLike,
  host: readEnv('HOST') ?? '0.0.0.0',
  port,
  databaseUrl: requireEnv('DATABASE_URL'),
  jwtAccessSecret: requireEnv('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: requireEnv('JWT_REFRESH_SECRET'),
  accessTokenExpiresIn: requireEnv('ACCESS_TOKEN_EXPIRES_IN'),
  refreshTokenExpiresIn: requireEnv('REFRESH_TOKEN_EXPIRES_IN'),
  bcryptSaltRounds: parseNumber('BCRYPT_SALT_ROUNDS', '12'),
  appWebBaseUrl: readEnv('APP_WEB_BASE_URL') ?? (isDevelopmentLike ? `http://localhost:${port}` : requireEnv('APP_WEB_BASE_URL')),
  apiPublicBaseUrl: readEnv('API_PUBLIC_BASE_URL') ?? (isDevelopmentLike ? `http://localhost:${port}` : null),
  mobileAppSteamCallbackUrl: parseUrl('MOBILE_APP_STEAM_CALLBACK_URL', 'gamepedia://steam/callback'),
  mailMode: resolveMailMode(),
  mailHost: readEnv('MAIL_HOST'),
  mailPort: parseNumber('MAIL_PORT', '587'),
  mailSecure: parseBoolean('MAIL_SECURE', 'false'),
  mailUser: readEnv('MAIL_USER'),
  mailPassword: readEnv('MAIL_PASSWORD'),
  mailFrom: readEnv('MAIL_FROM') ?? readEnv('EMAIL_FROM_ADDRESS') ?? (isDevelopmentLike ? 'no-reply@gamepedia.local' : null),
  // Pre-listen SMTP verification: mandatory outside development/test, opt-in
  // inside them so unit tests never contact a mail server by accident. The
  // timeout is bounded so startup can never hang on an unreachable host.
  smtpVerifyOnStartup: parseBoolean('SMTP_VERIFY_ON_STARTUP', isDevelopmentLike ? 'false' : 'true'),
  smtpVerifyTimeoutMs: parseBoundedNumber('SMTP_VERIFY_TIMEOUT_MS', '10000', { min: 1000, max: 60000 }),
  passwordResetTokenTtlMinutes: parseNumber('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60'),
  profileImageMaxSizeBytes: parseNumber('PROFILE_IMAGE_MAX_SIZE_BYTES', '5242880'),
  appleClientId: readEnv('APPLE_CLIENT_ID'),
  googleClientId: readEnv('GOOGLE_CLIENT_ID'),
  steamApiKey: readEnv('STEAM_API_KEY'),
  steamWebApiBaseUrl: parseUrl('STEAM_WEB_API_BASE_URL', 'https://api.steampowered.com/'),
  redisUrl: readEnv('REDIS_URL'),
  twitchClientId: readEnv('TWITCH_CLIENT_ID'),
  twitchClientSecret: readEnv('TWITCH_CLIENT_SECRET'),
  llmProvider,
  llmApiKey: readEnv('LLM_API_KEY'),
  llmBaseUrl: parseUrl('LLM_BASE_URL', llmProviderDefaults.baseUrl),
  llmModel: readEnv('LLM_MODEL') ?? llmProviderDefaults.model,
  llmTimeoutMs: parseNumber('LLM_TIMEOUT_MS', '8000'),
  aiRecommendationDailyLimit: parseNumber('AI_RECOMMENDATION_DAILY_LIMIT', '20'),
  aiRecommendationCacheTtlSeconds: parseNonNegativeNumber('AI_RECOMMENDATION_CACHE_TTL_SECONDS', '300'),
  aiLibraryCuratorDailyLimit: parseNumber(
    'AI_LIBRARY_CURATOR_DAILY_LIMIT',
    readEnv('AI_RECOMMENDATION_DAILY_LIMIT') ?? '20'
  ),
  aiLibraryCuratorCacheTtlSeconds: parseNonNegativeNumber(
    'AI_LIBRARY_CURATOR_CACHE_TTL_SECONDS',
    readEnv('AI_RECOMMENDATION_CACHE_TTL_SECONDS') ?? '300'
  ),
  aiSearchDailyLimit: parseNumber('AI_SEARCH_DAILY_LIMIT', readEnv('AI_RECOMMENDATION_DAILY_LIMIT') ?? '20'),
  aiSearchCacheTtlSeconds: parseNonNegativeNumber(
    'AI_SEARCH_CACHE_TTL_SECONDS',
    readEnv('AI_RECOMMENDATION_CACHE_TTL_SECONDS') ?? '300'
  ),
  firebaseAdminCredentialsPath: readEnv('FIREBASE_ADMIN_CREDENTIALS_PATH'),
  firebaseAdminCredentialsBase64Configured: Boolean(readEnv('FIREBASE_ADMIN_CREDENTIALS_BASE64')),
  firebaseAdminProjectId: readEnv('FIREBASE_ADMIN_PROJECT_ID'),
  firebaseAdminClientEmailConfigured: Boolean(readEnv('FIREBASE_ADMIN_CLIENT_EMAIL')),
  firebaseAdminPrivateKeyConfigured: Boolean(readEnv('FIREBASE_ADMIN_PRIVATE_KEY')),
  prismaQueryLogging: parseBoolean('PRISMA_QUERY_LOGGING', 'false'),
  // --- Product 2.2 ---
  productConfigVersion: readEnv('PRODUCT_CONFIG_VERSION') ?? '2.2.0',
  productFeatureFlagKeys: PRODUCT_FEATURE_FLAG_KEYS,
  productFeatureFlagDefaults: resolveProductFeatureDefaults(),
  catalogSubmissionPreviewTtlMinutes: parseBoundedNumber(
    'CATALOG_SUBMISSION_PREVIEW_TTL_MINUTES',
    '60',
    { min: 5, max: 1440 }
  ),
  aiQuickAddDailyLimit: parseNumber('AI_QUICK_ADD_DAILY_LIMIT', readEnv('AI_RECOMMENDATION_DAILY_LIMIT') ?? '20'),
  // Editorial source adapters may only ever reach hosts on this allowlist.
  // Empty means "no outbound source fetching is configured".
  editorialSourceAllowlist: Object.freeze((readEnv('EDITORIAL_SOURCE_HOST_ALLOWLIST') ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)),
  editorialSourceFetchTimeoutMs: parseBoundedNumber(
    'EDITORIAL_SOURCE_FETCH_TIMEOUT_MS',
    '5000',
    { min: 500, max: 30000 }
  ),
  editorialSourceMaxBytes: parseBoundedNumber(
    'EDITORIAL_SOURCE_MAX_BYTES',
    '524288',
    { min: 1024, max: 5242880 }
  )
};

function validateEnv(config) {
  if (!isDevelopmentLike && config.mailMode !== 'smtp') {
    // The log mode is a non-sending development aid; allowing it outside
    // development/test would leave password-reset delivery silently disabled.
    throw new Error(`MAIL_MODE=${config.mailMode} is not allowed when NODE_ENV=${config.nodeEnv} (expected: smtp)`);
  }

  if (config.mailMode === 'smtp') {
    const missingSmtpVars = [];

    if (!config.mailHost) {
      missingSmtpVars.push('MAIL_HOST');
    }

    if (!config.mailUser) {
      missingSmtpVars.push('MAIL_USER');
    }

    if (!config.mailPassword) {
      missingSmtpVars.push('MAIL_PASSWORD');
    }

    if (!config.mailFrom) {
      missingSmtpVars.push('MAIL_FROM');
    }

    if (missingSmtpVars.length > 0) {
      throw new Error(`Missing required SMTP environment variables: ${missingSmtpVars.join(', ')}`);
    }
  }

  if (!isDevelopmentLike && config.mailMode === 'smtp' && !config.smtpVerifyOnStartup) {
    // The release policy makes readiness depend on a working SMTP transport;
    // allowing an opt-out here would silently downgrade it to a warning.
    throw new Error(
      `SMTP_VERIFY_ON_STARTUP=false is not allowed when NODE_ENV=${config.nodeEnv}; SMTP verification is mandatory`
    );
  }

  if (!isDevelopmentLike && !readEnv('APP_WEB_BASE_URL')) {
    throw new Error('Missing required environment variable: APP_WEB_BASE_URL');
  }
}

validateEnv(env);

module.exports = { env };
