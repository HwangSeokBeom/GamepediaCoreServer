const express = require('express');
const catalogRoutes = require('../modules/catalog/catalog.routes');
const playRoutes = require('../modules/play/play.routes');

// Product 2.2 lives entirely under /api/v1. Every pre-existing route
// (/games/*, /reviews, /users/me/library, the Steam surface, the AI endpoints)
// keeps its current unversioned path and behavior, so a deployed iOS client is
// unaffected by anything mounted here.
const router = express.Router();

router.use('/api/v1', catalogRoutes);
router.use('/api/v1', playRoutes);

module.exports = router;
