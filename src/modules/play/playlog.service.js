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

/// Resolves the requested catalog game to its canonical survivor and validates
/// that the caller may reference it, plus that any regional release belongs to
/// that *resolved* game. Returns the canonical id, which callers must persist —
/// storing the requested id would leave a tombstone reference behind.
async function assertCatalogGameUsable({ userId, catalogGameId, regionalReleaseId, client = prisma }) {
  const canonicalId = await catalogIdentityService.resolveCanonicalGameId(catalogGameId, { client });

  if (!canonicalId) {
    throw new AppError(400, 'CATALOG_GAME_NOT_FOUND', 'The referenced catalog game could not be found');
  }

  const game = await client.catalogGame.findFirst({
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
    const release = await client.regionalRelease.findFirst({
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
  // The receipt and the mutation share one transaction. Writing the receipt first
  // and committing it separately meant that if the update then failed, a retry
  // with the same clientMutationId saw a duplicate receipt and reported a
  // successful replay for a mutation that had never been applied.
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.playSession.findFirst({
      // userId is part of the lookup, so another account's id resolves to null.
      where: { id: sessionId, userId },
      select: { id: true, catalogGameId: true, regionalReleaseId: true }
    });

    if (!existing) {
      throw new AppError(404, 'PLAY_SESSION_NOT_FOUND', 'Play session could not be found');
    }

    const gameChangeRequested = patch.catalogGameId !== undefined && patch.catalogGameId !== null;
    const releaseProvided = patch.regionalReleaseId !== undefined;
    let nextCatalogGameId = existing.catalogGameId;
    let nextRegionalReleaseId;

    if (gameChangeRequested || releaseProvided) {
      // The candidate release is whatever the patch supplies; when the game moves
      // and no release is supplied, the old release cannot be carried over
      // because it belongs to the previous game.
      const candidateReleaseId = releaseProvided ? patch.regionalReleaseId : null;

      nextCatalogGameId = await assertCatalogGameUsable({
        userId,
        catalogGameId: patch.catalogGameId ?? existing.catalogGameId,
        regionalReleaseId: candidateReleaseId,
        client: tx
      });

      if (releaseProvided) {
        nextRegionalReleaseId = patch.regionalReleaseId;
      } else if (nextCatalogGameId !== existing.catalogGameId) {
        // Game moved and no release was supplied: clear it rather than leave a
        // release pointing at the previous canonical game.
        nextRegionalReleaseId = null;
      }
    }

    if (clientMutationId) {
      const replay = await recordMutationReceipt({
        client: tx,
        userId,
        scope: 'play_session_update',
        clientMutationId,
        resourceId: sessionId,
        outcomeCode: 'updated'
      });

      if (replay.duplicate) {
        // A receipt only exists if its transaction committed, so this is a real
        // replay of an applied mutation.
        if (replay.resourceId && replay.resourceId !== sessionId) {
          throw new AppError(409, 'CLIENT_MUTATION_ID_REUSED',
            'This clientMutationId was already used for a different play session');
        }

        const current = await tx.playSession.findFirst({
          where: { id: sessionId, userId },
          select: SESSION_SELECT
        });

        return { session: current, idempotentReplay: true };
      }
    }

    const updated = await tx.playSession.update({
      where: { id: existing.id },
      data: {
        // Always the canonical survivor, never the id the request supplied.
        ...(nextCatalogGameId !== existing.catalogGameId ? { catalogGameId: nextCatalogGameId } : {}),
        ...(nextRegionalReleaseId !== undefined ? { regionalReleaseId: nextRegionalReleaseId } : {}),
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

    return { session: updated, idempotentReplay: false };
  });

  logger.info('play-session-updated', {
    outcome: outcome.session?.outcome ?? null,
    visibility: outcome.session?.visibility ?? null,
    hasDuration: outcome.session?.durationMinutes != null,
    hasProgress: outcome.session?.progressPercent != null,
    hasMood: outcome.session?.mood != null,
    hasNote: outcome.session?.note != null,
    idempotentReplay: outcome.idempotentReplay
  });

  return outcome;
}

async function deletePlaySession({ userId, sessionId, clientMutationId = null }) {
  // Receipt and delete share one transaction, so a failed delete cannot leave a
  // receipt that makes the retry look like a successful replay.
  const outcome = await prisma.$transaction(async (tx) => {
    if (clientMutationId) {
      const replay = await recordMutationReceipt({
        client: tx,
        userId,
        scope: 'play_session_delete',
        clientMutationId,
        resourceId: sessionId,
        outcomeCode: 'deleted'
      });

      if (replay.duplicate) {
        if (replay.resourceId && replay.resourceId !== sessionId) {
          throw new AppError(409, 'CLIENT_MUTATION_ID_REUSED',
            'This clientMutationId was already used for a different play session');
        }

        return { deleted: false, idempotentReplay: true };
      }
    }

    // deleteMany with userId in the filter means a foreign id deletes nothing.
    const result = await tx.playSession.deleteMany({ where: { id: sessionId, userId } });

    if (result.count === 0) {
      // Throwing rolls the receipt back with it.
      throw new AppError(404, 'PLAY_SESSION_NOT_FOUND', 'Play session could not be found');
    }

    return { deleted: true, idempotentReplay: false };
  });

  logger.info('play-session-deleted', {
    deleted: outcome.deleted,
    idempotentReplay: outcome.idempotentReplay
  });

  return outcome;
}

/// Claims an idempotency receipt.
///
/// Uses INSERT ... ON CONFLICT DO NOTHING rather than catching a unique violation.
/// Inside a PostgreSQL transaction a raised constraint error aborts the entire
/// transaction (SQLSTATE 25P02), so the old catch-then-query approach could not
/// read the existing receipt and surfaced an opaque failure to every concurrent
/// retry. ON CONFLICT does not raise, so the transaction stays usable.
///
/// Concurrency: a competing transaction holding the conflicting row makes this
/// statement block until that transaction settles. If it committed, DO NOTHING
/// returns no row and this caller is a genuine replay; if it rolled back, the
/// insert proceeds and this caller owns the mutation.
async function recordMutationReceipt({ client = prisma, userId, scope, clientMutationId, resourceId, outcomeCode }) {
  const inserted = await client.$queryRaw`
    INSERT INTO "client_mutation_receipts"
      ("id", "user_id", "scope", "client_mutation_id", "resource_id", "outcome_code", "created_at")
    VALUES (gen_random_uuid(), ${userId}::uuid, ${scope}, ${clientMutationId}, ${resourceId}, ${outcomeCode}, CURRENT_TIMESTAMP)
    ON CONFLICT ("user_id", "scope", "client_mutation_id") DO NOTHING
    RETURNING "id"
  `;

  if (Array.isArray(inserted) && inserted.length === 1) {
    return { duplicate: false, resourceId: null };
  }

  // Report which resource the key was originally used for, so reusing one
  // clientMutationId across two different sessions surfaces as a conflict
  // instead of a silently successful no-op.
  const existing = await client.clientMutationReceipt.findUnique({
    where: { userId_scope_clientMutationId: { userId, scope, clientMutationId } },
    select: { resourceId: true }
  });

  return { duplicate: true, resourceId: existing?.resourceId ?? null };
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
