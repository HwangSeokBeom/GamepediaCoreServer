const { normalizeProfileImageUrl } = require('../user/user.mapper');

function normalizeNumericValue(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value.toNumber === 'function') {
    return value.toNumber();
  }

  return Number(value);
}

function mapReviewToDto(review, currentUserId, {
  likeCount = 0,
  viewerHasLiked = false,
  commentCount = 0,
  activeCommentCount = null,
  gameSummary = null
} = {}) {
  const createdAtValue = review?.createdAt ? new Date(review.createdAt).getTime() : null;
  const updatedAtValue = review?.updatedAt ? new Date(review.updatedAt).getTime() : null;
  const isEdited = createdAtValue != null && updatedAtValue != null && updatedAtValue > createdAtValue;
  const authorProfileImageUrl = normalizeProfileImageUrl(review.user.profileImageUrl);
  const normalizedCommentCount = Number.isInteger(commentCount)
    ? commentCount
    : Number(commentCount ?? 0);
  const normalizedActiveCommentCount = Number.isInteger(activeCommentCount)
    ? activeCommentCount
    : Number(activeCommentCount ?? normalizedCommentCount);

  return {
    id: review.id,
    reviewId: review.id,
    gameId: review.gameId,
    ...(gameSummary
      ? {
        game: gameSummary,
        gameName: gameSummary.name ?? gameSummary.title ?? null,
        gameImageUrl: gameSummary.coverUrl ?? null
      }
      : {}),
    rating: normalizeNumericValue(review.rating),
    content: review.content,
    containsSpoiler: Boolean(review.containsSpoiler),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    isEdited,
    authorId: review.user.id,
    authorNickname: review.user.nickname,
    authorProfileImageUrl,
    author: {
      id: review.user.id,
      nickname: review.user.nickname,
      profileImageUrl: authorProfileImageUrl
    },
    likeCount,
    viewerHasLiked,
    isLikedByCurrentUser: viewerHasLiked,
    isLiked: viewerHasLiked,
    commentCount: normalizedCommentCount,
    discussionCount: normalizedCommentCount,
    activeCommentCount: normalizedActiveCommentCount,
    hasComments: normalizedCommentCount > 0,
    isMine: review.userId === currentUserId,
    canEdit: review.userId === currentUserId,
    canDelete: review.userId === currentUserId
  };
}

function mapReviewListToDto(reviews, currentUserId, {
  reviewMetricsMap = new Map(),
  gameSummaryMap = new Map()
} = {}) {
  return reviews.map((review) => mapReviewToDto(review, currentUserId, {
    ...(reviewMetricsMap.get(review.id) ?? {}),
    gameSummary: gameSummaryMap.get(review.gameId) ?? null
  }));
}

function buildCommentAuthorSummary(user) {
  return {
    id: user?.id ?? null,
    nickname: user?.nickname ?? null,
    profileImageUrl: normalizeProfileImageUrl(user?.profileImageUrl)
  };
}

function mapCommentReactionType(reactionType) {
  if (reactionType === 'LIKE') {
    return 'like';
  }

  if (reactionType === 'DISLIKE') {
    return 'dislike';
  }

  if (reactionType === 'like' || reactionType === 'dislike') {
    return reactionType;
  }

  return null;
}

function buildCommentReactionState(reactionSummary = {}, myReaction = null) {
  const normalizedMyReaction = mapCommentReactionType(myReaction);
  const likeCount = reactionSummary.likeCount ?? 0;
  const dislikeCount = reactionSummary.dislikeCount ?? 0;
  const viewerHasLiked = normalizedMyReaction === 'like';

  return {
    likeCount,
    dislikeCount,
    myReaction: normalizedMyReaction,
    viewerHasLiked,
    reactions: {
      likeCount,
      dislikeCount,
      myReaction: normalizedMyReaction
    }
  };
}

function buildReplyTargetSummary(comment, currentUserId, reviewAuthorId) {
  if (!comment?.replyToComment) {
    return null;
  }

  const replyToUser = comment.replyToComment.user ?? null;
  const replyToUserId = replyToUser?.id ?? comment.replyToComment.userId ?? null;
  const isOwner = replyToUserId === currentUserId;

  return {
    commentId: comment.replyToComment.id,
    userId: replyToUserId,
    nickname: replyToUser?.nickname ?? null,
    profileImageUrl: normalizeProfileImageUrl(replyToUser?.profileImageUrl),
    isOwner,
    isMine: isOwner,
    isReviewAuthor: replyToUserId === reviewAuthorId
  };
}

function buildCommentBaseDto({
  comment,
  currentUserId,
  reviewAuthorId,
  reactionSummary = {},
  myReaction = null
}) {
  const rootCommentId = comment?.rootCommentId ?? comment?.parentCommentId ?? comment?.id ?? null;
  const isOwner = comment?.userId === currentUserId;
  const isDeleted = Boolean(comment?.isDeleted);
  const createdAtValue = comment?.createdAt ? new Date(comment.createdAt).getTime() : null;
  const updatedAtValue = comment?.updatedAt ? new Date(comment.updatedAt).getTime() : null;
  const isEdited = !isDeleted && createdAtValue != null && updatedAtValue != null && updatedAtValue > createdAtValue;
  const reactionState = buildCommentReactionState(reactionSummary, myReaction);
  const mention = buildReplyTargetSummary(comment, currentUserId, reviewAuthorId);

  return {
    id: comment.id,
    commentId: comment.id,
    reviewId: comment.reviewId,
    parentCommentId: comment.parentCommentId ?? null,
    rootCommentId,
    threadParentCommentId: rootCommentId,
    replyToCommentId: comment.replyToCommentId ?? null,
    depth: Number.isInteger(comment.depth) ? comment.depth : (comment.parentCommentId ? 1 : 0),
    content: isDeleted ? null : comment.content,
    isDeleted,
    deletedAt: comment.deletedAt ?? null,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    isEdited,
    edited: isEdited,
    authorId: comment.user?.id ?? comment.userId ?? null,
    authorNickname: comment.user?.nickname ?? null,
    authorProfileImageUrl: normalizeProfileImageUrl(comment.user?.profileImageUrl),
    author: buildCommentAuthorSummary(comment.user),
    mention,
    replyTo: mention,
    target: {
      reviewId: comment.reviewId,
      gameId: comment.review?.gameId ?? null
    },
    reactions: reactionState.reactions,
    likeCount: reactionState.likeCount,
    dislikeCount: reactionState.dislikeCount,
    myReaction: reactionState.myReaction,
    viewerHasLiked: reactionState.viewerHasLiked,
    isLikedByCurrentUser: reactionState.viewerHasLiked,
    isLiked: reactionState.viewerHasLiked,
    isOwner,
    isMine: isOwner,
    isReply: Boolean(comment.parentCommentId),
    isReviewAuthor: comment?.userId === reviewAuthorId,
    canEdit: isOwner && !isDeleted,
    canDelete: isOwner && !isDeleted,
    canReply: !isDeleted,
    canReport: !isOwner && !isDeleted,
    availableActions: {
      canReply: !isDeleted,
      canEdit: isOwner && !isDeleted,
      canDelete: isOwner && !isDeleted,
      canReact: !isDeleted,
      canReport: !isOwner && !isDeleted
    }
  };
}

function mapReviewCommentPreviewToDto(comment) {
  if (!comment) {
    return null;
  }

  return {
    id: comment.id,
    replyId: comment.id,
    commentId: comment.id,
    reviewId: comment.reviewId,
    parentCommentId: comment.parentCommentId ?? null,
    rootCommentId: comment.rootCommentId ?? comment.parentCommentId ?? comment.id,
    isDeleted: Boolean(comment.isDeleted),
    authorId: comment.user?.id ?? comment.userId ?? null,
    authorNickname: comment.user?.nickname ?? null,
    authorProfileImageUrl: normalizeProfileImageUrl(comment.user?.profileImageUrl),
    author: buildCommentAuthorSummary(comment.user),
    content: comment.isDeleted ? null : comment.content,
    createdAt: comment.createdAt
  };
}

function mapReviewCommentSummaryToDto({
  comment,
  currentUserId,
  reviewAuthorId,
  reactionSummary = {},
  myReaction = null,
  replyCount = 0,
  latestReplyPreview = null,
  threadMeta = null
}) {
  return {
    ...buildCommentBaseDto({
      comment,
      currentUserId,
      reviewAuthorId,
      reactionSummary,
      myReaction
    }),
    replyCount,
    latestReplyAt: latestReplyPreview?.createdAt ?? null,
    latestReplyPreview,
    ...(threadMeta ? threadMeta : {}),
    isRootComment: true
  };
}

function mapReviewCommentToDto({
  comment,
  currentUserId,
  reviewAuthorId,
  reactionSummary = {},
  myReaction = null,
  replyCount = 0,
  replies = [],
  repliesNextCursor = null,
  latestReplyPreview = null,
  threadMeta = null,
  reviewSummary = null,
  gameSummary = null
}) {
  const visibleReplyCount = Array.isArray(replies) ? replies.length : 0;
  const remainingReplyCount = Math.max((replyCount ?? 0) - visibleReplyCount, 0);
  const hasMoreReplies = Boolean(repliesNextCursor) || remainingReplyCount > 0;
  const latestReplyAt = visibleReplyCount > 0
    ? replies[visibleReplyCount - 1]?.createdAt ?? null
    : latestReplyPreview?.createdAt ?? null;

  return {
    ...buildCommentBaseDto({
      comment,
      currentUserId,
      reviewAuthorId,
      reactionSummary,
      myReaction
    }),
    replyCount,
    latestReplyPreview,
    replies,
    visibleReplyCount,
    replyPreviewCount: visibleReplyCount,
    remainingReplyCount,
    collapsedReplyCount: remainingReplyCount,
    hasMoreReplies,
    repliesNextCursor,
    latestReplyAt,
    ...(!comment?.parentCommentId && threadMeta ? threadMeta : {}),
    ...(reviewSummary ? { review: reviewSummary } : {}),
    ...(gameSummary ? { game: gameSummary } : {})
  };
}

function mapAverageRating(averageRating) {
  const normalizedRating = normalizeNumericValue(averageRating);

  if (normalizedRating == null) {
    return null;
  }

  return Number(normalizedRating.toFixed(1));
}

function mapSteamReviewStatus(reviewScore) {
  if (reviewScore == null || reviewScore === 0) {
    return null;
  }

  if (reviewScore >= 6) return 'positive';
  if (reviewScore <= 4) return 'negative';
  return null;
}

function mapSteamLinkedReviewToDto(review, currentUserId, steamMeta) {
  const base = mapReviewToDto(review, currentUserId);

  return {
    ...base,
    hasSteamReview: true,
    steamReviewSummary: steamMeta?.reviewScoreDesc ?? null,
    steamReviewStatus: mapSteamReviewStatus(steamMeta?.reviewScore)
  };
}

module.exports = {
  buildCommentAuthorSummary,
  mapAverageRating,
  mapCommentReactionType,
  mapReviewCommentPreviewToDto,
  mapReviewCommentSummaryToDto,
  mapReviewListToDto,
  mapReviewCommentToDto,
  mapReviewToDto,
  mapSteamLinkedReviewToDto
};
