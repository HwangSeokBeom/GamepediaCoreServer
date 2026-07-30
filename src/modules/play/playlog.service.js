const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const catalogIdentityService = require('../catalog/catalog-identity.service');
const { listMonthDateKeys, resolveMonthWindow, toZonedDateKey } = require('./play-time.util');

// Playlog CRUD.
//
// Ownership: every read, update and delete is scoped by userId in the same query
// that locates the row, so account B can never reach account A's session — a
// mismatch is reported as 404, not 403, so ids are not enumerable.
//
// Idempotency: (userId, clientMutationId) is unique on play_sessions, so a
// retried create returns the original row instead of inserting a second one. For
// update and delete the same key is recorded in client_mutation_receipts.
//
// Privacy: `note` and `mood` never appear in a log line or an event property.
// Only counts, flags and enum codes are logged.

const SESSION_SELECT = {
  id: true,
  catalogGameId: true,
  regionalReleaseId: true,
  playedAt: true,
  durationMinutes: true,
  progressPercent: true,
  mood: true,
  note: true,
  outcome: true,
  visibility: true,
  provenance: true,
  clientMutationId: true,
  createdAt: true,
  updatedAt: true
};

function isUniqueViolation(error) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isRecordNotFound(error) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

async function assertCatalogGameUsable({ userId, catalogGameId, regionalReleaseId }) {
  const canonicalId = await catalogIdentityService.resolveCanonicalGameId(catalogGameId);

  if (!canonicalId) {
    throw new AppError(400, 'CATALOG_GAME_NOT_FOUND', 'The referenced catalog game could not be found');
  }

  const game = await prisma.catalogGame.findFirst({
    where: {
      id: canonicalId,
      mergedIntoCatalogGameId: null,
      OR: [{ publicationStatus: 'PUBLISHED' }, { createdByUserId: userId }]
    },
    select: { id: true }
  });

  if (!game) {
    throw new AppError(400, 'CATALOG_GAME_NOT_FOUND', 'The referenced catalog game could not be found');
  }

  if (regionalReleaseId) {
    const release = await prisma.regionalRelease.findFirst({
      where: { id: regionalReleaseId, catalogGameId: canonicalId },
      select: { id: true }
    });

    if (!release) {
      throw new AppError(400, 'REGIONAL_RELEASE_MISMATCH', 'The regional release does not belong to this catalog game');
    }
  }

  return canonicalId;
}

async function createPlaySession({ userId, input }) {
  const canonicalGameId = await assertCatalogGameUsable({
    userId,
    catalogGameId: input.catalogGameId,
    regionalReleaseId: input.regionalReleaseId ?? null
  });

  try {
    const created = await prisma.playSession.create({
      data: {
        userId,
        catalogGameId: canonicalGameId,
        regionalReleaseId: input.regionalReleaseId ?? null,
        playedAt: input.playedAt,
        durationMinutes: input.durationMinutes ?? null,
        progressPercent: input.progressPercent ?? null,
        mood: input.mood ?? null,
        note: input.note ?? null,
        outcome: input.outcome,
        visibility: input.visibility ?? 'PRIVATE',
        provenance: input.provenance ?? 'USER_CONFIRMED',
        clientMutationId: input.clientMutationId
      },
      select: SESSION_SELECT
    });

    logger.info('play-session-created', {
      outcome: created.outcome,
      visibility: created.visibility,
      hasDuration: created.durationMinutes !== null,
      hasProgress: created.progressPercent !== null,
      hasMood: created.mood !== null,
      hasNote: created.note !== null,
      idempotentReplay: false
    });

    return { session: created, idempotentReplay: false };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    // A retry with the same clientMutationId resolves to the original row.
    const existing = await prisma.playSession.findUnique({
      where: { userId_clientMutationId: { userId, clientMutationId: input.clientMutationId } },
      select: SESSION_SELECT
    });

    if (!existing) {
      throw error;
    }

    logger.info('play-session-created', {
      outcome: existing.outcome,
      visibility: existing.visibility,
      hasDuration: existing.durationMinutes !== null,
      hasProgress: existing.progressPercent !== null,
      hasMood: existing.mood !== null,
      hasNote: existing.note !== null,
      idempotentReplay: true
    });

    return { session: existing, idempotentReplay: true };
  }
}

async function listPlaySessions({ userId, catalogGameId = null, from = null, to = null, outcome = null, limit = 20, cursor = null }) {
  const cursorState = decodeCursor(cursor);
  const sessions = await prisma.playSession.findMany({
    where: {
      userId,
      ...(catalogGameId ? { catalogGameId } : {}),
      ...(outcome ? { outcome } : {}),
      ...(from || to
        ? {
          playedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: to } : {})
          }
        }
        : {}),
      ...(cursorState
        ? {
          OR: [
            { playedAt: { lt: cursorState.playedAt } },
            { playedAt: cursorState.playedAt, id: { lt: cursorState.id } }
          ]
        }
        : {})
    },
    select: SESSION_SELECT,
    // Deterministic total order: (playedAt desc, id desc) is unique because id is
    // unique, so the keyset cursor can never skip or repeat a row.
    orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1
  });

  const page = sessions.slice(0, limit);
  const last = page[page.length - 1] ?? null;

  return {
    sessions: page,
    meta: {
      limit,
      nextCursor: sessions.length > limit && last ? encodeCursor(last) : null
    }
  };
}

function encodeCursor(session) {
  return Buffer
    .from(JSON.stringify({ v: 1, p: session.playedAt.toISOString(), i: session.id }), 'utf8')
    .toString('base64url');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const playedAt = new Date(parsed?.p);

    if (parsed?.v !== 1 || Number.isNaN(playedAt.getTime()) || typeof parsed.i !== 'string') {
      throw new Error('malformed cursor');
    }

    return { playedAt, id: parsed.i };
  } catch (error) {
    throw new AppError(400, 'INVALID_CURSOR', 'The supplied play session cursor could not be decoded');
  }
}

async function updatePlaySession({ userId, sessionId, patch, clientMutationId = null }) {
  const existing = await prisma.playSession.findFirst({
    // userId is part of the lookup, so another account's id resolves to null.
    where: { id: sessionId, userId },
    select: { id: true, catalogGameId: true }
  });

  if (!existing) {
    throw new AppError(404, 'PLAY_SESSION_NOT_FOUND', 'Play session could not be found');
  }

  if (patch.catalogGameId || patch.regionalReleaseId !== undefined) {
    await assertCatalogGameUsable({
      userId,
      catalogGameId: patch.catalogGameId ?? existing.catalogGameId,
      regionalReleaseId: patch.regionalReleaseId ?? null
    });
  }

  if (clientMutationId) {
    const replay = await recordMutationReceipt({
      userId,
      scope: 'play_session_update',
      clientMutationId,
      resourceId: sessionId,
      outcomeCode: 'updated'
    });

    if (replay.duplicate) {
      const current = await prisma.playSession.findFirst({ where: { id: sessionId, userId }, select: SESSION_SELECT });

      return { session: current, idempotentReplay: true };
    }
  }

  const updated = await prisma.playSession.update({
    where: { id: existing.id },
    data: {
      ...(patch.catalogGameId ? { catalogGameId: patch.catalogGameId } : {}),
      ...(patch.regionalReleaseId !== undefined ? { regionalReleaseId: patch.regionalReleaseId } : {}),
      ...(patch.playedAt ? { playedAt: patch.playedAt } : {}),
      ...(patch.durationMinutes !== undefined ? { durationMinutes: patch.durationMinutes } : {}),
      ...(patch.progressPercent !== undefined ? { progressPercent: patch.progressPercent } : {}),
      ...(patch.mood !== undefined ? { mood: patch.mood } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.outcome ? { outcome: patch.outcome } : {}),
      ...(patch.visibility ? { visibility: patch.visibility } : {})
    },
    select: SESSION_SELECT
  });

  logger.info('play-session-updated', {
    outcome: updated.outcome,
    visibility: updated.visibility,
    hasDuration: updated.durationMinutes !== null,
    hasProgress: updated.progressPercent !== null,
    hasMood: updated.mood !== null,
    hasNote: updated.note !== null,
    idempotentReplay: false
  });

  return { session: updated, idempotentReplay: false };
}

async function deletePlaySession({ userId, sessionId, clientMutationId = null }) {
  if (clientMutationId) {
    const replay = await recordMutationReceipt({
      userId,
      scope: 'play_session_delete',
      clientMutationId,
      resourceId: sessionId,
      outcomeCode: 'deleted'
    });

    if (replay.duplicate) {
      return { deleted: false, idempotentReplay: true };
    }
  }

  try {
    // deleteMany with userId in the filter means a foreign id deletes nothing.
    const result = await prisma.playSession.deleteMany({ where: { id: sessionId, userId } });

    if (result.count === 0) {
      throw new AppError(404, 'PLAY_SESSION_NOT_FOUND', 'Play session could not be found');
    }

    logger.info('play-session-deleted', { deletedCount: result.count, idempotentReplay: false });

    return { deleted: true, idempotentReplay: false };
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new AppError(404, 'PLAY_SESSION_NOT_FOUND', 'Play session could not be found');
    }

    throw error;
  }
}

/// Inserts an idempotency receipt. A duplicate insert means the mutation already
/// ran, which the caller turns into a replay response.
async function recordMutationReceipt({ userId, scope, clientMutationId, resourceId, outcomeCode }) {
  try {
    await prisma.clientMutationReceipt.create({
      data: { userId, scope, clientMutationId, resourceId, outcomeCode },
      select: { id: true }
    });

    return { duplicate: false };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    return { duplicate: true };
  }
}

/// Per-local-day aggregates for one month. Note bodies are never returned here;
/// only counts, durations and outcome/mood code distributions.
async function getPlayCalendar({ userId, month, timezone }) {
  const window = resolveMonthWindow({ month, timeZone: timezone });
  const sessions = await prisma.playSession.findMany({
    where: {
      userId,
      playedAt: { gte: window.startUtc, lt: window.endUtc }
    },
    select: {
      id: true,
      catalogGameId: true,
      playedAt: true,
      durationMinutes: true,
      outcome: true,
      mood: true
    },
    orderBy: [{ playedAt: 'asc' }, { id: 'asc' }]
  });

  const byDay = new Map(listMonthDateKeys({ month, timeZone: timezone })
    .map((dateKey) => [dateKey, {
      date: dateKey,
      sessionCount: 0,
      totalMinutes: 0,
      minutesKnown: true,
      catalogGameIds: [],
      outcomes: {}
    }]));

  let sessionsWithoutDuration = 0;

  for (const session of sessions) {
    const dateKey = toZonedDateKey(session.playedAt, timezone);
    const day = byDay.get(dateKey);

    if (!day) {
      continue;
    }

    day.sessionCount += 1;
    day.outcomes[session.outcome] = (day.outcomes[session.outcome] ?? 0) + 1;

    if (!day.catalogGameIds.includes(session.catalogGameId)) {
      day.catalogGameIds.push(session.catalogGameId);
    }

    if (Number.isInteger(session.durationMinutes)) {
      day.totalMinutes += session.durationMinutes;
    } else {
      day.minutesKnown = false;
      sessionsWithoutDuration += 1;
    }
  }

  const days = [...byDay.values()];

  return {
    monthKey: window.monthKey,
    timezone,
    windowStartUtc: window.startUtc.toISOString(),
    windowEndUtc: window.endUtc.toISOString(),
    days,
    summary: {
      dayCount: days.length,
      playedDayCount: days.filter((day) => day.sessionCount > 0).length,
      sessionCount: sessions.length,
      totalMinutes: days.reduce((total, day) => total + day.totalMinutes, 0),
      sessionsWithoutDuration,
      isEmpty: sessions.length === 0
    }
  };
}

module.exports = {
  createPlaySession,
  decodeCursor,
  deletePlaySession,
  encodeCursor,
  getPlayCalendar,
  listPlaySessions,
  recordMutationReceipt,
  updatePlaySession
};
