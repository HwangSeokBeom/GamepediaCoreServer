const net = require('net');
const { env } = require('./env');
const { logger } = require('../utils/logger');

const REDIS_CONNECT_TIMEOUT_MS = 3000;

function buildRedisCommand(parts) {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`;
}

function parseRedisConnection(redisUrl) {
  try {
    const parsedUrl = new URL(redisUrl);

    return {
      host: parsedUrl.hostname || '127.0.0.1',
      port: parsedUrl.port ? Number(parsedUrl.port) : 6379,
      username: parsedUrl.username ? decodeURIComponent(parsedUrl.username) : null,
      password: parsedUrl.password ? decodeURIComponent(parsedUrl.password) : null,
      database: parsedUrl.pathname ? parsedUrl.pathname.replace(/^\//, '') || null : null
    };
  } catch (error) {
    return null;
  }
}

async function probeRedisConnection() {
  if (!env.redisUrl) {
    logger.info('Redis URL is not configured; skipping Redis connectivity check');
    return false;
  }

  const connection = parseRedisConnection(env.redisUrl);

  if (!connection) {
    logger.warn('Redis URL is invalid; skipping Redis connectivity check');
    return false;
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: connection.host,
      port: connection.port
    });

    let settled = false;
    let responseBuffer = '';

    function finish(level, message, meta = {}) {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      logger[level](message, {
        host: connection.host,
        port: connection.port,
        database: connection.database,
        ...meta
      });
      resolve(level === 'info');
    }

    socket.setTimeout(REDIS_CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      const commands = [];

      if (connection.password) {
        if (connection.username) {
          commands.push(buildRedisCommand(['AUTH', connection.username, connection.password]));
        } else {
          commands.push(buildRedisCommand(['AUTH', connection.password]));
        }
      }

      commands.push(buildRedisCommand(['PING']));
      socket.write(commands.join(''));
    });

    socket.on('data', (chunk) => {
      responseBuffer += chunk.toString('utf8');

      if (responseBuffer.includes('\r\n-') || responseBuffer.startsWith('-')) {
        finish('warn', 'Redis connection failed', {
          response: responseBuffer.split('\r\n')[0]
        });
        return;
      }

      if (responseBuffer.includes('+PONG')) {
        finish('info', 'Redis connection established');
      }
    });

    socket.on('timeout', () => {
      finish('warn', 'Redis connection timed out', {
        timeoutMs: REDIS_CONNECT_TIMEOUT_MS
      });
    });

    socket.on('error', (error) => {
      finish('warn', 'Redis connection failed', { error });
    });

    socket.on('end', () => {
      if (!settled) {
        finish('warn', 'Redis connection ended before PONG');
      }
    });
  });
}

module.exports = {
  probeRedisConnection
};
