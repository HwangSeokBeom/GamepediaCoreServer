const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const { requireFeature } = require('../product/feature-flag.service');
const { requireRole } = require('../product/user-role.service');
const feedController = require('./feed.controller');
const {
  articleSlugParamsSchema,
  buildFeedValidationError,
  createArticleSchema,
  listArticlesQuerySchema,
  productEventBatchSchema,
  retractArticleSchema,
  todayQuerySchema,
  updateArticleSchema
} = require('./feed.validator');

// Mounted under /api/v1.
const router = express.Router();

router.get('/users/me/today',
  requireFeature('todayFeed'),
  authenticateAccessToken,
  validate({ query: todayQuerySchema, errorMapper: buildFeedValidationError }),
  feedController.getToday);

router.get('/articles/:slug',
  requireFeature('magazine'),
  authenticateAccessToken,
  validate({ params: articleSlugParamsSchema, errorMapper: buildFeedValidationError }),
  feedController.getArticle);

// --- editor / admin surface ---
// requireRole reads user_role_assignments on every request, so a revoked role
// stops working immediately rather than when the access token expires.
router.get('/editorial/articles',
  requireFeature('magazine'),
  authenticateAccessToken,
  requireRole('EDITOR', 'ADMIN'),
  validate({ query: listArticlesQuerySchema, errorMapper: buildFeedValidationError }),
  feedController.listArticles);

router.post('/editorial/articles',
  requireFeature('magazine'),
  authenticateAccessToken,
  requireRole('EDITOR', 'ADMIN'),
  validate({ body: createArticleSchema, errorMapper: buildFeedValidationError }),
  feedController.createArticle);

router.patch('/editorial/articles/:slug',
  requireFeature('magazine'),
  authenticateAccessToken,
  requireRole('EDITOR', 'ADMIN'),
  validate({
    params: articleSlugParamsSchema,
    body: updateArticleSchema,
    errorMapper: buildFeedValidationError
  }),
  feedController.updateArticle);

router.post('/editorial/articles/:slug/publish',
  requireFeature('magazine'),
  authenticateAccessToken,
  requireRole('EDITOR', 'ADMIN'),
  validate({ params: articleSlugParamsSchema, errorMapper: buildFeedValidationError }),
  feedController.publishArticle);

router.post('/editorial/articles/:slug/retract',
  requireFeature('magazine'),
  authenticateAccessToken,
  requireRole('EDITOR', 'ADMIN'),
  validate({
    params: articleSlugParamsSchema,
    body: retractArticleSchema,
    errorMapper: buildFeedValidationError
  }),
  feedController.retractArticle);

// --- product control plane ---
// product-config and product-events are intentionally NOT behind a feature flag:
// the client needs the config to learn which features are off, and event intake
// must keep working while a feature is disabled.
router.get('/product-config',
  authenticateAccessToken,
  feedController.getProductConfiguration);

router.post('/product-events',
  authenticateAccessToken,
  validate({ body: productEventBatchSchema, errorMapper: buildFeedValidationError }),
  feedController.submitProductEvents);

module.exports = router;
