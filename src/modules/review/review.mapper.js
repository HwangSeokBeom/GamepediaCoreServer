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
    commentCount,
    activeCommentCount: activeCommentCount ?? commentCount,
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

function mapReviewCommentToDto({
  comment,
  currentUserId,
  reviewAuthorId,
  reactionSummary = {},
  myReaction = null,
  replyCount = 0,
  replies = [],
  repliesNextCursor = null,
  reviewSummary = null,
  gameSummary = null
}) {
  const isMine = comment?.userId === currentUserId;
  const isDeleted = Boolean(comment?.isDeleted);
  const replyToUser = comment?.replyToComment?.user ?? null;
  const createdAtValue = comment?.createdAt ? new Date(comment.createdAt).getTime() : null;
  const updatedAtValue = comment?.updatedAt ? new Date(comment.updatedAt).getTime() : null;
  const normalizedMyReaction = mapCommentReactionType(myReaction);
  const isEdited = !isDeleted && createdAtValue != null && updatedAtValue != null && updatedAtValue > createdAtValue;

  return {
    id: comment.id,
    reviewId: comment.reviewId,
    parentCommentId: comment.parentCommentId ?? null,
    threadParentCommentId: comment.parentCommentId ?? comment.id,
    replyToCommentId: comment.replyToCommentId ?? null,
    depth: Number.isInteger(comment.depth) ? comment.depth : 0,
    content: isDeleted ? null : comment.content,
    isDeleted,
    deletedAt: comment.deletedAt ?? null,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    isEdited,
    edited: isEdited,
    author: buildCommentAuthorSummary(comment.user),
    replyTo: comment.replyToComment
      ? {
        commentId: comment.replyToComment.id,
        userId: replyToUser?.id ?? comment.replyToComment.userId ?? null,
        nickname: replyToUser?.nickname ?? null,
        profileImageUrl: normalizeProfileImageUrl(replyToUser?.profileImageUrl),
        isMine: (replyToUser?.id ?? comment.replyToComment.userId ?? null) === currentUserId,
        isReviewAuthor: (replyToUser?.id ?? comment.replyToComment.userId ?? null) === reviewAuthorId
      }
      : null,
    target: {
      reviewId: comment.reviewId,
      gameId: comment.review?.gameId ?? null
    },
    reactions: {
      likeCount: reactionSummary.likeCount ?? 0,
      dislikeCount: reactionSummary.dislikeCount ?? 0,
      myReaction: normalizedMyReaction
    },
    likeCount: reactionSummary.likeCount ?? 0,
    dislikeCount: reactionSummary.dislikeCount ?? 0,
    myReaction: normalizedMyReaction,
    viewerHasLiked: normalizedMyReaction === 'like',
    isLikedByCurrentUser: normalizedMyReaction === 'like',
    isLiked: normalizedMyReaction === 'like',
    replyCount,
    replies,
    replyPreviewCount: Array.isArray(replies) ? replies.length : 0,
    repliesNextCursor,
    isMine,
    isReply: Boolean(comment.parentCommentId),
    isReviewAuthor: comment?.userId === reviewAuthorId,
    canEdit: isMine && !isDeleted,
    canDelete: isMine && !isDeleted,
    availableActions: {
      canReply: !isDeleted,
      canEdit: isMine && !isDeleted,
      canDelete: isMine && !isDeleted,
      canReact: !isDeleted,
      canReport: !isMine
    },
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
  mapAverageRating,
  mapCommentReactionType,
  mapReviewListToDto,
  mapReviewCommentToDto,
  mapReviewToDto,
  mapSteamLinkedReviewToDto
};
