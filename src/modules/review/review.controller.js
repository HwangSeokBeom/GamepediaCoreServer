const reviewService = require('./review.service');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');

const GAME_REVIEW_PREVIEW_LIMIT = 5;

const createReview = asyncHandler(async (req, res) => {
  const result = await reviewService.createReview({
    userId: req.auth.userId,
    ...req.body
  });

  res.status(201).json(successResponse(result));
});

const createReviewComment = asyncHandler(async (req, res) => {
  const result = await reviewService.createReviewComment({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    ...req.body
  });

  res.status(201).json(successResponse(result));
});

const createReviewCommentReply = asyncHandler(async (req, res) => {
  const result = await reviewService.createReviewComment({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    ...req.body,
    parentCommentId: req.body.parentCommentId ?? req.params.commentId,
    replyToCommentId: req.body.replyToCommentId ?? req.params.commentId
  });

  res.status(201).json(successResponse(result));
});

const getGameReviews = asyncHandler(async (req, res) => {
  const result = await reviewService.getGameReviews({
    currentUserId: req.auth.userId,
    gameId: req.params.gameId,
    sort: req.query.sort,
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const getGameReviewPreview = asyncHandler(async (req, res) => {
  const result = await reviewService.getGameReviews({
    currentUserId: req.auth.userId,
    gameId: req.params.gameId,
    sort: req.query.sort,
    limit: GAME_REVIEW_PREVIEW_LIMIT
  });

  res.status(200).json(successResponse(result));
});

const getReviewDetail = asyncHandler(async (req, res) => {
  const result = await reviewService.getReviewDetail({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    commentsCursor: req.query.cursor,
    commentsLimit: req.query.limit,
    repliesLimit: req.query.repliesLimit,
    commentsSort: req.query.sort
  });

  res.status(200).json(successResponse(result));
});

const getMyGameReviews = asyncHandler(async (req, res) => {
  const result = await reviewService.getMyGameReviews({
    currentUserId: req.auth.userId,
    gameId: req.params.gameId,
    sort: req.query.sort,
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const getMyGameReviewPreview = asyncHandler(async (req, res) => {
  const result = await reviewService.getMyGameReviews({
    currentUserId: req.auth.userId,
    gameId: req.params.gameId,
    sort: req.query.sort,
    limit: GAME_REVIEW_PREVIEW_LIMIT
  });

  res.status(200).json(successResponse(result));
});

const getReviewComments = asyncHandler(async (req, res) => {
  const result = await reviewService.getReviewComments({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    cursor: req.query.cursor,
    limit: req.query.limit,
    repliesLimit: req.query.repliesLimit,
    sort: req.query.sort
  });

  res.status(200).json(successResponse(result));
});

const getReviewCommentReplies = asyncHandler(async (req, res) => {
  const result = await reviewService.getReviewCommentReplies({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    commentId: req.params.commentId,
    cursor: req.query.cursor,
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const getReviewCommentThread = asyncHandler(async (req, res) => {
  const result = await reviewService.getReviewCommentThread({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    rootCommentId: req.params.rootCommentId
  });

  res.status(200).json(successResponse(result));
});

const updateReview = asyncHandler(async (req, res) => {
  const result = await reviewService.updateReview({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    ...req.body
  });

  res.status(200).json(successResponse(result));
});

const updateReviewComment = asyncHandler(async (req, res) => {
  const result = await reviewService.updateReviewComment({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    commentId: req.params.commentId,
    ...req.body
  });

  res.status(200).json(successResponse(result));
});

const deleteReview = asyncHandler(async (req, res) => {
  const result = await reviewService.deleteReview({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId
  });

  res.status(200).json(successResponse(result));
});

const likeReview = asyncHandler(async (req, res) => {
  const result = await reviewService.likeReview({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId
  });

  res.status(200).json(successResponse(result));
});

const removeReviewLike = asyncHandler(async (req, res) => {
  const result = await reviewService.removeReviewLike({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId
  });

  res.status(200).json(successResponse(result));
});

const deleteReviewComment = asyncHandler(async (req, res) => {
  const result = await reviewService.deleteReviewComment({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    commentId: req.params.commentId
  });

  res.status(200).json(successResponse(result));
});

const getMyReviews = asyncHandler(async (req, res) => {
  const result = await reviewService.getMyReviews({
    currentUserId: req.auth.userId,
    sort: req.query.sort,
    limit: req.query.limit
  });

  res.status(200).json(successResponse(result));
});

const getMyReviewComments = asyncHandler(async (req, res) => {
  const result = await reviewService.getMyReviewComments({
    currentUserId: req.auth.userId,
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort
  });

  res.status(200).json(successResponse(result));
});

const reactToReviewComment = asyncHandler(async (req, res) => {
  const result = await reviewService.reactToReviewComment({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    commentId: req.params.commentId,
    reactionType: req.body.reactionType
  });

  res.status(200).json(successResponse(result));
});

const likeReviewComment = asyncHandler(async (req, res) => {
  const result = await reviewService.likeReviewComment({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    commentId: req.params.commentId
  });

  res.status(200).json(successResponse(result));
});

const removeReviewCommentReaction = asyncHandler(async (req, res) => {
  const result = await reviewService.removeReviewCommentReaction({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    commentId: req.params.commentId
  });

  res.status(200).json(successResponse(result));
});

const reportReviewComment = asyncHandler(async (req, res) => {
  const result = await reviewService.reportReviewComment({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    commentId: req.params.commentId,
    reason: req.body.reason
  });

  res.status(200).json(successResponse(result));
});

const getSteamLinkedReviews = asyncHandler(async (req, res) => {
  const result = await reviewService.getSteamLinkedReviews({
    currentUserId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  createReview,
  createReviewComment,
  createReviewCommentReply,
  deleteReview,
  deleteReviewComment,
  getGameReviewPreview,
  getGameReviews,
  getReviewDetail,
  getMyGameReviewPreview,
  getMyGameReviews,
  getMyReviewComments,
  getMyReviews,
  getReviewCommentThread,
  getReviewCommentReplies,
  getReviewComments,
  likeReview,
  likeReviewComment,
  removeReviewLike,
  reactToReviewComment,
  removeReviewCommentReaction,
  reportReviewComment,
  getSteamLinkedReviews,
  updateReviewComment,
  updateReview
};
