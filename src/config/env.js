const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const DEFAULT_PAPAGO_ENDPOINT = 'https://papago.apigw.ntruss.com/nmt/v1/translation';

function loadEnvFile(filePath, override = false) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  dotenv.config({
    path: filePath,
    override,
    quiet: true
  });
}

const bootstrapNodeEnv = process.env.NODE_ENV?.trim() || 'development';
const envFilePaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), `.env.${bootstrapNodeEnv}`),
  path.resolve(process.cwd(), `.env.${bootstrapNodeEnv}.local`)
];

envFilePaths.forEach((filePath, index) => {
  loadEnvFile(filePath, index > 0);
});

function readEnv(name) {
  const value = process.env[name];

  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : null;
}

function readFirstEnv(...names) {
  for (const name of names) {
    const value = readEnv(name);

    if (value) {
      return value;
    }
  }

  return null;
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
  redisUrl: readEnv('REDIS_URL'),
  twitchClientId: readEnv('TWITCH_CLIENT_ID'),
  twitchClientSecret: readEnv('TWITCH_CLIENT_SECRET'),
  libreTranslateUrl: readEnv('LIBRETRANSLATE_URL') ?? (isDevelopmentLike ? 'http://localhost:5001' : null),
  libreTranslateTimeoutMs: parseNumber('LIBRETRANSLATE_TIMEOUT_MS', '5000'),
  papagoClientId: readEnv('PAPAGO_CLIENT_ID'),
  papagoClientSecret: readEnv('PAPAGO_CLIENT_SECRET'),
  papagoEndpoint: readEnv('PAPAGO_ENDPOINT') ?? DEFAULT_PAPAGO_ENDPOINT,
  papagoTimeoutMs: parseNumber('PAPAGO_TIMEOUT_MS', '5000'),
  translationProxyBaseUrl: readFirstEnv('TRANSLATION_BASE_URL', 'TRANSLATION_PROXY_BASE_URL') ?? (isDevelopmentLike ? 'http://localhost:3000' : null)
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
