// Shared setup for Product 2.2 unit tests.
//
// Environment defaults are applied before src/config/env is required by any
// module under test. The DATABASE_URL here points at a port nothing listens on:
// these tests stub every Prisma call they need, so a stray real query fails
// loudly instead of silently reaching a database.

process.env.NODE_ENV ??= 'test';
process.env.APP_ENV ??= 'test';
process.env.MAIL_MODE ??= 'log';
process.env.JWT_ACCESS_SECRET ??= 'product-2-2-test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'product-2-2-test-refresh-secret';
process.env.ACCESS_TOKEN_EXPIRES_IN ??= '900';
process.env.REFRESH_TOKEN_EXPIRES_IN ??= '1209600';
process.env.BCRYPT_SALT_ROUNDS ??= '4';
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@127.0.0.1:5499/placeholder_unit_only';

const { prisma } = require('../../../src/config/prisma');

/// Replaces the named delegate methods and returns a restore function. Any model
/// method a test forgets to stub keeps its real implementation, so an unexpected
/// query surfaces as a connection error rather than a false pass.
function stubPrisma(overridesByModel) {
  const originals = [];

  for (const [modelName, methods] of Object.entries(overridesByModel)) {
    const delegate = prisma[modelName];

    if (!delegate) {
      throw new Error(`Unknown Prisma delegate in stub: ${modelName}`);
    }

    for (const [methodName, implementation] of Object.entries(methods)) {
      originals.push([delegate, methodName, delegate[methodName]]);
      delegate[methodName] = implementation;
    }
  }

  return function restore() {
    for (const [delegate, methodName, original] of originals) {
      delegate[methodName] = original;
    }
  };
}

/// Minimal `$transaction` stand-in: runs the callback with the (stubbed) client so
/// transactional service code can be exercised without a database.
function stubTransaction(client = prisma) {
  const original = prisma.$transaction;

  prisma.$transaction = async (arg) => (typeof arg === 'function' ? arg(client) : Promise.all(arg));

  return function restore() {
    prisma.$transaction = original;
  };
}

/// Stubs `$queryRaw`, which the ON CONFLICT DO NOTHING claim inserts use.
///
/// `handler` receives the joined SQL text and the interpolated values, and returns
/// the rows the statement should produce: one row means the insert won the claim,
/// zero rows means it conflicted with an existing row.
function stubQueryRaw(handler) {
  const original = prisma.$queryRaw;

  prisma.$queryRaw = async (strings, ...values) => {
    const sql = Array.isArray(strings) ? strings.join('?') : String(strings);

    return handler(sql, values);
  };

  return function restore() {
    prisma.$queryRaw = original;
  };
}

/// Stubs the `SELECT ... FOR UPDATE` row lock the editorial mutations take.
///
/// `articleId` is the id the lock resolves to; pass null to simulate a missing
/// article. Returns `{ lockCount, restore }` so a test can assert that the lock was
/// actually taken — the round-2 finding was that the status, revision and asset
/// reads happened outside any transaction, so "did it lock?" is the assertion that
/// distinguishes the fix from the defect.
function stubArticleLock(articleId) {
  const state = { lockCount: 0 };
  const original = prisma.$queryRaw;

  prisma.$queryRaw = async (strings) => {
    const sql = Array.isArray(strings) ? strings.join('?') : String(strings);

    if (!/FOR UPDATE/i.test(sql)) {
      throw new Error(`Unexpected raw query in an editorial test: ${sql}`);
    }

    state.lockCount += 1;

    return articleId === null ? [] : [{ id: articleId }];
  };

  return {
    get lockCount() {
      return state.lockCount;
    },
    restore() {
      prisma.$queryRaw = original;
    }
  };
}

/// Captures winston log records so privacy assertions can inspect exactly what a
/// code path would have written.
function captureLogs() {
  const { logger } = require('../../../src/utils/logger');
  const records = [];
  const originals = {};

  for (const level of ['info', 'warn', 'error', 'debug']) {
    originals[level] = logger[level];
    logger[level] = (message, meta) => {
      records.push({ level, message, meta });
      return logger;
    };
  }

  return {
    records,
    /// Every logged value flattened into one string, for leak scanning.
    serialize() {
      const { sanitizeLogMeta } = require('../../../src/utils/logger');

      return records
        .map((record) => `${record.message} ${JSON.stringify(sanitizeLogMeta(record.meta ?? {}))}`)
        .join('\n');
    },
    restore() {
      for (const [level, original] of Object.entries(originals)) {
        logger[level] = original;
      }
    }
  };
}

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const CATALOG_GAME_A = '00000000-0000-4000-8000-0000000000c1';
const CATALOG_GAME_B = '00000000-0000-4000-8000-0000000000c2';

module.exports = {
  CATALOG_GAME_A,
  CATALOG_GAME_B,
  USER_A,
  USER_B,
  captureLogs,
  prisma,
  stubArticleLock,
  stubPrisma,
  stubQueryRaw,
  stubTransaction
};
