const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const { assertSupportedTimeZone } = require('../play/play-time.util');
const { getProductConfig } = require('../product/product-config.service');
const { recordProductEvents } = require('../product/product-event.service');
const articleService = require('./article.service');
const todayService = require('./today.service');

const getToday = asyncHandler(async (req, res) => {
  assertSupportedTimeZone(req.query.timezone);

  const result = await todayService.getTodayFeed({
    userId: req.auth.userId,
    locale: req.query.locale ?? null,
    timezone: req.query.timezone,
    limit: req.query.limit,
    cursor: req.query.cursor ?? null
  });

  res.status(200).json(successResponse(result));
});

const getArticle = asyncHandler(async (req, res) => {
  const result = await articleService.getPublishedArticleBySlug({ slug: req.params.slug });

  res.status(200).json(successResponse({ article: result }));
});

const listArticles = asyncHandler(async (req, res) => {
  const result = await articleService.listArticlesForEditor({
    status: req.query.status ?? null,
    locale: req.query.locale ?? null,
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const createArticle = asyncHandler(async (req, res) => {
  const result = await articleService.createArticle({
    actorUserId: req.auth.userId,
    input: req.body
  });

  res.status(201).json(successResponse({ article: result }));
});

const updateArticle = asyncHandler(async (req, res) => {
  const result = await articleService.updateArticle({
    actorUserId: req.auth.userId,
    slug: req.params.slug,
    input: req.body
  });

  res.status(200).json(successResponse({ article: result }));
});

const publishArticle = asyncHandler(async (req, res) => {
  const result = await articleService.publishArticle({
    actorUserId: req.auth.userId,
    slug: req.params.slug
  });

  res.status(200).json(successResponse({ article: result }));
});

const retractArticle = asyncHandler(async (req, res) => {
  const result = await articleService.retractArticle({
    actorUserId: req.auth.userId,
    slug: req.params.slug,
    reasonCode: req.body.reasonCode
  });

  res.status(200).json(successResponse({ article: result }));
});

const getProductConfiguration = asyncHandler(async (req, res) => {
  const result = await getProductConfig();

  res.status(200).json(successResponse(result));
});

const submitProductEvents = asyncHandler(async (req, res) => {
  const result = await recordProductEvents({
    userId: req.auth.userId,
    events: req.body.events
  });

  res.status(202).json(successResponse(result));
});

module.exports = {
  createArticle,
  getArticle,
  getProductConfiguration,
  getToday,
  listArticles,
  publishArticle,
  retractArticle,
  submitProductEvents,
  updateArticle
};
