const crypto = require('node:crypto');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const catalogService = require('./catalog.service');
const catalogSubmissionService = require('./catalog-submission.service');

const searchCatalogGames = asyncHandler(async (req, res) => {
  const result = await catalogService.searchCatalogGames({
    userId: req.auth?.userId ?? null,
    query: req.query.query,
    locale: req.query.locale ?? null,
    regionCode: req.query.regionCode ?? null,
    platform: req.query.platform ?? null,
    limit: req.query.limit,
    cursor: req.query.cursor ?? null
  });

  res.status(200).json(successResponse(result));
});

const getCatalogGame = asyncHandler(async (req, res) => {
  const result = await catalogService.getCatalogGameDetail({
    userId: req.auth?.userId ?? null,
    catalogGameId: req.params.catalogGameId
  });

  res.status(200).json(successResponse(result));
});

const previewSubmission = asyncHandler(async (req, res) => {
  const result = await catalogSubmissionService.previewSubmission({
    userId: req.auth.userId,
    inputType: req.body.inputType,
    input: req.body.input,
    locale: req.body.locale,
    regionCode: req.body.regionCode,
    platformHint: req.body.platformHint ?? null
  });

  res.status(200).json(successResponse(result));
});

const confirmSubmission = asyncHandler(async (req, res) => {
  const result = await catalogSubmissionService.confirmSubmission({
    userId: req.auth.userId,
    submissionId: req.params.submissionId,
    selectedCatalogGameId: req.body.selectedCatalogGameId ?? null,
    confirmedFields: req.body.confirmedFields ?? null,
    requestPublicReview: req.body.requestPublicReview === true
  });

  res.status(result.createdNewGame && !result.idempotentReplay ? 201 : 200).json(successResponse(result));
});

const getSubmission = asyncHandler(async (req, res) => {
  const result = await catalogSubmissionService.getSubmission({
    userId: req.auth.userId,
    submissionId: req.params.submissionId
  });

  res.status(200).json(successResponse(result));
});

const submitCorrections = asyncHandler(async (req, res) => {
  const result = await catalogService.submitCatalogCorrection({
    userId: req.auth.userId,
    catalogGameId: req.params.catalogGameId,
    corrections: req.body.corrections.map((correction) => ({
      fieldPath: correction.fieldPath,
      sourceUrl: correction.sourceUrl ?? null,
      // The proposed value is fingerprinted rather than stored verbatim so a
      // free-text claim never lands in the catalog before review.
      valueFingerprint: crypto
        .createHash('sha256')
        .update(JSON.stringify(correction.proposedValue))
        .digest('hex')
    }))
  });

  res.status(202).json(successResponse(result));
});

const followCatalogGame = asyncHandler(async (req, res) => {
  const result = await catalogService.followCatalogGame({
    userId: req.auth.userId,
    catalogGameId: req.params.catalogGameId,
    regionalReleaseId: req.body?.regionalReleaseId ?? null
  });

  res.status(200).json(successResponse(result));
});

const unfollowCatalogGame = asyncHandler(async (req, res) => {
  const result = await catalogService.unfollowCatalogGame({
    userId: req.auth.userId,
    catalogGameId: req.params.catalogGameId
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  confirmSubmission,
  followCatalogGame,
  getCatalogGame,
  getSubmission,
  previewSubmission,
  searchCatalogGames,
  submitCorrections,
  unfollowCatalogGame
};
