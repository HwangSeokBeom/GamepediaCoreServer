const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const {
  CODE_VALUE_PATTERN,
  PRODUCT_EVENT_ALLOWLIST,
  PROPERTY_SHAPES
} = require('./product.constants');

// Product Events are allowlist-only in both dimensions: the event code must be
// declared, and each property must match a declared shape. Anything else is
// dropped, so a raw search query, a Playlog note, a URL query string, a provider
// response body or a prompt can never reach the analytics table even if a client
// sends one.

function isUniqueViolation(error) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function coerceProperty(rule, value) {
  if (value === null || value === undefined) {
    return { accepted: false, reason: 'null_value' };
  }

  if (rule.shape === PROPERTY_SHAPES.boolean) {
    return typeof value === 'boolean'
      ? { accepted: true, value }
      : { accepted: false, reason: 'not_boolean' };
  }

  if (rule.shape === PROPERTY_SHAPES.integer) {
    if (!Number.isSafeInteger(value)) {
      return { accepted: false, reason: 'not_integer' };
    }

    if (value < rule.min || value > rule.max) {
      return { accepted: false, reason: 'out_of_range' };
    }

    return { accepted: true, value };
  }

  if (rule.shape === PROPERTY_SHAPES.enum) {
    return rule.values.includes(value)
      ? { accepted: true, value }
      : { accepted: false, reason: 'not_in_enum' };
  }

  if (rule.shape === PROPERTY_SHAPES.code) {
    return typeof value === 'string' && CODE_VALUE_PATTERN.test(value)
      ? { accepted: true, value }
      : { accepted: false, reason: 'not_a_code' };
  }

  return { accepted: false, reason: 'unknown_shape' };
}

/// Returns only allowlisted, shape-checked properties plus the keys that were
/// rejected (as key names, never values, so nothing sensitive is echoed back).
function sanitizeEventProperties(eventCode, properties) {
  const rules = PRODUCT_EVENT_ALLOWLIST[eventCode];

  if (!rules) {
    throw new AppError(400, 'UNKNOWN_PRODUCT_EVENT_CODE', 'Product event code is not allowlisted', [{
      field: 'eventCode',
      message: eventCode
    }]);
  }

  const accepted = {};
  const rejectedKeys = [];

  for (const [key, value] of Object.entries(properties ?? {})) {
    const rule = rules[key];

    if (!rule) {
      rejectedKeys.push(key);
      continue;
    }

    const result = coerceProperty(rule, value);

    if (result.accepted) {
      accepted[key] = result.value;
    } else {
      rejectedKeys.push(key);
    }
  }

  return { accepted, rejectedKeys };
}

/// Records one batch. eventId carries the idempotency: a retried batch cannot
/// double count because the unique index rejects the duplicate and the row is
/// reported as `duplicate` instead of failing the whole request.
async function recordProductEvents({ userId, events }) {
  const results = [];
  let acceptedCount = 0;
  let duplicateCount = 0;
  let droppedPropertyCount = 0;

  for (const event of events) {
    const { accepted, rejectedKeys } = sanitizeEventProperties(event.eventCode, event.properties);
    droppedPropertyCount += rejectedKeys.length;

    try {
      await prisma.productEvent.create({
        data: {
          eventId: event.eventId,
          userId: userId ?? null,
          eventCode: event.eventCode,
          occurredAt: event.occurredAt,
          properties: Object.keys(accepted).length > 0 ? accepted : Prisma.DbNull
        },
        select: { id: true }
      });

      acceptedCount += 1;
      results.push({ eventId: event.eventId, status: 'recorded', droppedPropertyKeys: rejectedKeys });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      duplicateCount += 1;
      results.push({ eventId: event.eventId, status: 'duplicate', droppedPropertyKeys: rejectedKeys });
    }
  }

  logger.info('product-event-batch-recorded', {
    eventCount: events.length,
    acceptedCount,
    duplicateCount,
    droppedPropertyCount
  });

  return {
    acceptedCount,
    duplicateCount,
    results
  };
}

module.exports = {
  recordProductEvents,
  sanitizeEventProperties
};
