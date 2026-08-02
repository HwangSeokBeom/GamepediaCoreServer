const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const { requireFeature } = require('../product/feature-flag.service');
const catalogController = require('./catalog.controller');
const {
  buildCatalogValidationError,
  catalogGameParamsSchema,
  catalogSearchQuerySchema,
  confirmSubmissionSchema,
  followGameSchema,
  previewSubmissionSchema,
  submissionParamsSchema,
  submitCorrectionsSchema
} = require('./catalog.validator');

// Mounted under /api/v1 by src/routes/api-v1.routes.js. Existing unversioned
// routes are untouched.
const router = express.Router();

// Catalog reads are gated by openCatalog; AI quick add has its own kill switch so
// the catalog stays readable when extraction is disabled.
router.get('/catalog/games/search',
  requireFeature('openCatalog'),
  authenticateAccessToken,
  validate({ query: catalogSearchQuerySchema, errorMapper: buildCatalogValidationError }),
  catalogController.searchCatalogGames);

router.get('/catalog/games/:catalogGameId',
  requireFeature('openCatalog'),
  authenticateAccessToken,
  validate({ params: catalogGameParamsSchema, errorMapper: buildCatalogValidationError }),
  catalogController.getCatalogGame);

router.post('/catalog/submissions/preview',
  requireFeature('aiQuickAdd'),
  authenticateAccessToken,
  validate({ body: previewSubmissionSchema, errorMapper: buildCatalogValidationError }),
  catalogController.previewSubmission);

router.post('/catalog/submissions/:submissionId/confirm',
  requireFeature('aiQuickAdd'),
  authenticateAccessToken,
  validate({
    params: submissionParamsSchema,
    body: confirmSubmissionSchema,
    errorMapper: buildCatalogValidationError
  }),
  catalogController.confirmSubmission);

router.get('/catalog/submissions/:submissionId',
  requireFeature('aiQuickAdd'),
  authenticateAccessToken,
  validate({ params: submissionParamsSchema, errorMapper: buildCatalogValidationError }),
  catalogController.getSubmission);

router.post('/catalog/games/:catalogGameId/corrections',
  requireFeature('openCatalog'),
  authenticateAccessToken,
  validate({
    params: catalogGameParamsSchema,
    body: submitCorrectionsSchema,
    errorMapper: buildCatalogValidationError
  }),
  catalogController.submitCorrections);

router.put('/catalog/games/:catalogGameId/follow',
  requireFeature('openCatalog'),
  authenticateAccessToken,
  validate({
    params: catalogGameParamsSchema,
    body: followGameSchema,
    errorMapper: buildCatalogValidationError
  }),
  catalogController.followCatalogGame);

router.delete('/catalog/games/:catalogGameId/follow',
  requireFeature('openCatalog'),
  authenticateAccessToken,
  validate({ params: catalogGameParamsSchema, errorMapper: buildCatalogValidationError }),
  catalogController.unfollowCatalogGame);

module.exports = router;
