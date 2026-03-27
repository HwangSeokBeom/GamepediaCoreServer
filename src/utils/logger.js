const fs = require('fs');
const path = require('path');
const winston = require('winston');

const logDirectory = path.resolve(process.cwd(), 'logs');

fs.mkdirSync(logDirectory, { recursive: true });

function serializeMeta(meta) {
  const entries = Object.entries(meta).filter(([, value]) => value !== undefined);

  if (entries.length === 0) {
    return '';
  }

  return JSON.stringify(Object.fromEntries(entries), (key, value) => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }

    return value;
  });
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
  logger
};
