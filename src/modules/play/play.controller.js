const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const { assertSupportedTimeZone } = require('./play-time.util');
const playlogService = require('./playlog.service');
const gameDnaService = require('./game-dna.service');
const playCompassService = require('./play-compass.service');
const monthlyReplayService = require('./monthly-replay.service');

function mapSession(session) {
  return {
    id: session.id,
    catalogGameId: session.catalogGameId,
    regionalReleaseId: session.regionalReleaseId ?? null,
    playedAt: session.playedAt.toISOString(),
    durationMinutes: session.durationMinutes ?? null,
    progressPercent: session.progressPercent ?? null,
    mood: session.mood ?? null,
    note: session.note ?? null,
    outcome: session.outcome,
    visibility: session.visibility,
    provenance: session.provenance,
    clientMutationId: session.clientMutationId,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  };
}

const listPlaySessions = asyncHandler(async (req, res) => {
  const result = await playlogService.listPlaySessions({
    userId: req.auth.userId,
    catalogGameId: req.query.catalogGameId ?? null,
    from: req.query.from ?? null,
    to: req.query.to ?? null,
    outcome: req.query.outcome ?? null,
    limit: req.query.limit,
    cursor: req.query.cursor ?? null
  });

  res.status(200).json(successResponse({
    playSessions: result.sessions.map(mapSession),
    meta: result.meta
  }));
});

const createPlaySession = asyncHandler(async (req, res) => {
  const result = await playlogService.createPlaySession({
    userId: req.auth.userId,
    input: req.body
  });

  // A replayed clientMutationId returns the original record with 200 instead of
  // creating a second one.
  res.status(result.idempotentReplay ? 200 : 201).json(successResponse({
    playSession: mapSession(result.session),
    idempotentReplay: result.idempotentReplay
  }));
});

const updatePlaySession = asyncHandler(async (req, res) => {
  const { clientMutationId, ...patch } = req.body;
  const result = await playlogService.updatePlaySession({
    userId: req.auth.userId,
    sessionId: req.params.id,
    patch,
    clientMutationId: clientMutationId ?? null
  });

  res.status(200).json(successResponse({
    playSession: result.session ? mapSession(result.session) : null,
    idempotentReplay: result.idempotentReplay
  }));
});

const deletePlaySession = asyncHandler(async (req, res) => {
  const result = await playlogService.deletePlaySession({
    userId: req.auth.userId,
    sessionId: req.params.id,
    clientMutationId: req.body?.clientMutationId ?? null
  });

  res.status(200).json(successResponse(result));
});

const getPlayCalendar = asyncHandler(async (req, res) => {
  assertSupportedTimeZone(req.query.timezone);

  const result = await playlogService.getPlayCalendar({
    userId: req.auth.userId,
    month: req.query.month,
    timezone: req.query.timezone
  });

  res.status(200).json(successResponse(result));
});

const getGameDna = asyncHandler(async (req, res) => {
  const result = await gameDnaService.getGameDna({ userId: req.auth.userId });

  res.status(200).json(successResponse(result));
});

const recommendPlayCompass = asyncHandler(async (req, res) => {
  const result = await playCompassService.recommend({
    userId: req.auth.userId,
    request: {
      availableMinutes: req.body.availableMinutes,
      mood: req.body.mood ?? null,
      energy: req.body.energy,
      soloOrParty: req.body.soloOrParty,
      continueOrStart: req.body.continueOrStart,
      availablePlatforms: req.body.availablePlatforms,
      friendUserIds: req.body.friendUserIds
    }
  });

  res.status(200).json(successResponse(result));
});

const recordPlayCompassEvent = asyncHandler(async (req, res) => {
  const result = await playCompassService.recordCompassEvent({
    userId: req.auth.userId,
    catalogGameId: req.body.catalogGameId,
    action: req.body.action,
    reasonCodes: req.body.reasonCodes,
    requestHash: req.body.requestHash ?? null,
    occurredAt: req.body.occurredAt ?? new Date()
  });

  res.status(201).json(successResponse(result));
});

const getMonthlyReplay = asyncHandler(async (req, res) => {
  assertSupportedTimeZone(req.query.timezone);

  const result = await monthlyReplayService.getMonthlyReplay({
    userId: req.auth.userId,
    month: req.query.month,
    timezone: req.query.timezone
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  createPlaySession,
  deletePlaySession,
  getGameDna,
  getMonthlyReplay,
  getPlayCalendar,
  listPlaySessions,
  mapSession,
  recommendPlayCompass,
  recordPlayCompassEvent,
  updatePlaySession
};
