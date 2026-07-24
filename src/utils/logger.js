const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const winston = require('winston');

const logDirectory = path.resolve(process.cwd(), 'logs');

fs.mkdirSync(logDirectory, { recursive: true });

const OMITTED_LOG_KEY = /token$|password|secret|authorization|authurl|endpointurl|profileurl|email|quer(?:y|ies)$|prompt|headers|body$|responsebody|payload$|personaname|gamename|selectedtitles|topresulttitles|hosteddomain|(?:title|nickname|name|message)$/i;
const HASHED_LOG_KEY = /(?:userId|targetUserId|friendUserId|blockedUserId|actorUserId|steamId(?:64)?|providerSubject|deviceId|externalGameId|appId|gameId|subject|audience|ip|remoteAddress)$/i;

function hashLogValue(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function sanitizeLogMeta(value, key = '', seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (OMITTED_LOG_KEY.test(key)) return '<redacted>';
  if (HASHED_LOG_KEY.test(key) && (typeof value === 'string' || typeof value === 'number')) return hashLogValue(value);
  if (typeof value === 'string') return value.slice(0, 500);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { errorCategory: value.code ?? value.name ?? 'Error' };
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLogMeta(item, key, seen));
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([childKey, item]) => [childKey, sanitizeLogMeta(item, childKey, seen)]));
}

function serializeMeta(meta) {
  const entries = Object.entries(sanitizeLogMeta(meta)).filter(([, value]) => value !== undefined);

  if (entries.length === 0) {
    return '';
  }

  return JSON.stringify(Object.fromEntries(entries));
}

function buildLogFormatter({ colorize = false } = {}) {
  const formats = [
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true })
  ];

  if (colorize) {
    formats.push(winston.format.colorize({ all: true }));
  }

  formats.push(winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const body = stack ? `${message}\n${stack}` : message;
    const metaText = serializeMeta(meta);

    return metaText
      ? `${timestamp} [${level}] ${body} ${metaText}`
      : `${timestamp} [${level}] ${body}`;
  }));

  return winston.format.combine(...formats);
}

const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console({
      format: buildLogFormatter({ colorize: true })
    }),
    new winston.transports.File({
      filename: path.join(logDirectory, 'app.log'),
      level: 'info',
      format: buildLogFormatter()
    }),
    new winston.transports.File({
      filename: path.join(logDirectory, 'error.log'),
      level: 'error',
      format: buildLogFormatter()
    })
  ]
});

module.exports = {
  buildLogFormatter,
  logger,
  sanitizeLogMeta
};
