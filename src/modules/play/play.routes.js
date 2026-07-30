const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const { requireFeature } = require('../product/feature-flag.service');
const playController = require('./play.controller');
const {
  buildPlayValidationError,
  calendarQuerySchema,
  createPlaySessionSchema,
  deletePlaySessionSchema,
  listPlaySessionsQuerySchema,
  monthlyReplayQuerySchema,
  playCompassEventSchema,
  playCompassRequestSchema,
  playSessionParamsSchema,
  updatePlaySessionSchema
} = require('./play.validator');

// Mounted under /api/v1. Each feature carries its own kill switch so, for
// example, disabling Play Compass leaves the Playlog fully usable.
const router = express.Router();

// The calendar route is declared before /:id so "calendar" is never parsed as an
// id by the parameterised route.
router.get('/users/me/play-sessions/calendar',
  requireFeature('playlog'),
  authenticateAccessToken,
  validate({ query: calendarQuerySchema, errorMapper: buildPlayValidationError }),
  playController.getPlayCalendar);

router.get('/users/me/play-sessions',
  requireFeature('playlog'),
  authenticateAccessToken,
  validate({ query: listPlaySessionsQuerySchema, errorMapper: buildPlayValidationError }),
  playController.listPlaySessions);

router.post('/users/me/play-sessions',
  requireFeature('playlog'),
  authenticateAccessToken,
  validate({ body: createPlaySessionSchema, errorMapper: buildPlayValidationError }),
  playController.createPlaySession);

router.patch('/users/me/play-sessions/:id',
  requireFeature('playlog'),
  authenticateAccessToken,
  validate({
    params: playSessionParamsSchema,
    body: updatePlaySessionSchema,
    errorMapper: buildPlayValidationError
  }),
  playController.updatePlaySession);

router.delete('/users/me/play-sessions/:id',
  requireFeature('playlog'),
  authenticateAccessToken,
  validate({
    params: playSessionParamsSchema,
    body: deletePlaySessionSchema,
    errorMapper: buildPlayValidationError
  }),
  playController.deletePlaySession);

router.get('/users/me/game-dna',
  requireFeature('gameDNA'),
  authenticateAccessToken,
  playController.getGameDna);

router.post('/users/me/play-compass',
  requireFeature('playCompass'),
  authenticateAccessToken,
  validate({ body: playCompassRequestSchema, errorMapper: buildPlayValidationError }),
  playController.recommendPlayCompass);

router.post('/users/me/play-compass/events',
  requireFeature('playCompass'),
  authenticateAccessToken,
  validate({ body: playCompassEventSchema, errorMapper: buildPlayValidationError }),
  playController.recordPlayCompassEvent);

router.get('/users/me/replays/monthly',
  requireFeature('monthlyReplay'),
  authenticateAccessToken,
  validate({ query: monthlyReplayQuerySchema, errorMapper: buildPlayValidationError }),
  playController.getMonthlyReplay);

module.exports = router;
