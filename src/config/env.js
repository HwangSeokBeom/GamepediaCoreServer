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

function parseEnum(name, fallbackValue, allowedValues) {
  const rawValue = (readEnv(name) ?? fallbackValue).toLowerCase();

  if (!allowedValues.includes(rawValue)) {
    throw new Error(`Environment variable ${name} must be one of: ${allowedValues.join(', ')}`);
  }

  return rawValue;
}

const nodeEnv = readEnv('NODE_ENV') ?? bootstrapNodeEnv;
const isDevelopmentLike = nodeEnv === 'development' || nodeEnv === 'test';
const mailModeFallback = readEnv('EMAIL_DELIVERY_MODE') ?? 'log';
const port = parseNumber('PORT', '3000');
const llmProvider = (readEnv('LLM_PROVIDER') ?? 'openai').toLowerCase();

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
  mailMode: parseEnum('MAIL_MODE', mailModeFallback, ['log', 'smtp']),
  mailHost: readEnv('MAIL_HOST'),
  mailPort: parseNumber('MAIL_PORT', '587'),
  mailSecure: parseBoolean('MAIL_SECURE', 'false'),
  mailUser: readEnv('MAIL_USER'),
  mailPassword: readEnv('MAIL_PASSWORD'),
  mailFrom: readEnv('MAIL_FROM') ?? readEnv('EMAIL_FROM_ADDRESS') ?? (isDevelopmentLike ? 'no-reply@gamepedia.local' : null),
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
  prismaQueryLogging: parseBoolean('PRISMA_QUERY_LOGGING', 'false')
};

function validateEnv(config) {
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

  if (!isDevelopmentLike && !readEnv('APP_WEB_BASE_URL')) {
    throw new Error('Missing required environment variable: APP_WEB_BASE_URL');
  }
}

validateEnv(env);

module.exports = { env };
