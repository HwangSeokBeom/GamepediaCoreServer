const { randomUUID } = require('crypto');
const { Prisma, ReviewCommentReactionType, UserStatus } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const moderationService = require('../moderation/moderation.service');
const { AppError } = require('../../utils/error-response');
const steamService = require('../../services/steam.service');
const igdbService = require('../igdb/igdb.service');
const {
  buildGameImageResolverUrl,
  extractUsableIgdbCoverUrl
} = require('../library/library-image.service');
const userActivityService = require('../user/user-activity.service');
const {
  mapAverageRating,
  mapReviewCommentPreviewToDto,
  mapReviewCommentSummaryToDto,
  mapReviewCommentToDto,
  mapReviewListToDto,
  mapReviewToDto,
  mapSteamLinkedReviewToDto
} = require('./review.mapper');

const reviewAuthorSelect = {
  id: true,
  nickname: true,
  profileImageUrl: true
};

const reviewCommentInclude = {
  user: {
    select: reviewAuthorSelect
  },
  replyToComment: {
    select: {
      id: true,
      userId: true,
      user: {
        select: reviewAuthorSelect
      }
    }
  },
  review: {
    select: {
      id: true,
      gameId: true,
      userId: true
    }
  }
};

const REVIEW_COMMENTS_DEFAULT_LIMIT = 20;
const REVIEW_COMMENTS_MAX_LIMIT = 50;
const REVIEW_COMMENT_MAX_DEPTH = 1;
const REVIEW_COMMENT_REPLY_SORT = 'oldest';
const REVIEW_COMMENT_REPLY_TIE_BREAKER = 'id_asc';
const REVIEW_COMMENT_REPLY_PREVIEW_ANCHOR = 'latest';
const REVIEW_COMMENT_REPLY_CURSOR_DIRECTION = 'older';
const REVIEW_COMMENT_REACTION_THROTTLE_MS = 10 * 60 * 1000;
const REVIEW_COMMENT_DEFAULT_SORT = 'latest';
const REVIEW_COMMENT_THREAD_SORT = 'oldest';
const REVIEW_COMMENT_SUMMARY_REPLY_COUNT_DEFAULT = 2;
const COMMENT_NOTIFICATION_TYPE = {
  COMMENT_REPLY: 'COMMENT_REPLY',
  COMMENT_REACTION_LIKE: 'COMMENT_REACTION_LIKE',
  COMMENT_REACTION_DISLIKE: 'COMMENT_REACTION_DISLIKE'
};

const reviewOrderByMap = {
  latest: [{ createdAt: 'desc' }, { id: 'desc' }],
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
  oldest: [{ createdAt: 'asc' }, { id: 'asc' }],
  rating_desc: [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  rating_asc: [{ rating: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
  rating_high: [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  rating_low: [{ rating: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }]
};

function getReviewOrderBy(sort) {
  return reviewOrderByMap[sort] ?? reviewOrderByMap.latest;
}

function normalizeReviewSort(sort) {
  if (sort === 'latest') {
    return 'newest';
  }

  if (sort === 'rating_desc') {
    return 'rating_high';
  }

  if (sort === 'rating_asc') {
    return 'rating_low';
  }

  return sort ?? 'newest';
}

function buildReviewData({ rating, content, containsSpoiler }) {
  return {
    ...(rating !== undefined ? { rating: new Prisma.Decimal(rating) } : {}),
    ...(content !== undefined ? { content: content.trim() } : {}),
    ...(containsSpoiler !== undefined ? { containsSpoiler: Boolean(containsSpoiler) } : {})
  };
}

function uniqueStringValues(values) {
  return [...new Set(
    (values ?? [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  )];
}

function normalizePositiveInteger(value, fallbackValue, maxValue = REVIEW_COMMENTS_MAX_LIMIT) {
  const parsedValue = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return Math.min(parsedValue, maxValue);
}

function getRootCommentOrderBy(sort = REVIEW_COMMENT_DEFAULT_SORT) {
  if (sort === 'oldest') {
    return [{ createdAt: 'asc' }, { id: 'asc' }];
  }

  return [{ createdAt: 'desc' }, { id: 'desc' }];
}

function normalizeRootCommentSort(sort) {
  if (sort === 'newest') {
    return REVIEW_COMMENT_DEFAULT_SORT;
  }

  if (sort === 'oldest' || sort === 'like') {
    return sort;
  }

  return REVIEW_COMMENT_DEFAULT_SORT;
}

function isMissingTableError(error, expectedName) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (error.code !== 'P2021' && error.code !== 'P2022') {
    return false;
  }

  const serializedMeta = JSON.stringify(error.meta ?? {});
  return serializedMeta.includes(expectedName) || String(error.message ?? '').includes(expectedName);
}

function getReplyOrderBy() {
  // Returned reply arrays stay chronological even when the selected slice is anchored to the latest replies.
  return [{ createdAt: 'asc' }, { id: 'asc' }];
}

function getReplyPageOrderBy() {
  return [{ createdAt: 'desc' }, { id: 'desc' }];
}

function buildReviewCommentDepthPolicy() {
  return {
    maxDepth: REVIEW_COMMENT_MAX_DEPTH,
    replyMode: 'flat_root_thread',
    replyToReplyHandling: 'attach_to_root_comment'
  };
}

function buildCommentVisibilityWhere(hiddenUserIds = []) {
  const normalizedHiddenUserIds = uniqueStringValues(hiddenUserIds);

  if (normalizedHiddenUserIds.length === 0) {
    return {};
  }

  return {
    userId: {
      notIn: normalizedHiddenUserIds
    }
  };
}

function buildActiveReplyWhere(hiddenUserIds = []) {
  return {
    isDeleted: false,
    ...buildCommentVisibilityWhere(hiddenUserIds)
  };
}

function buildVisibleRootCommentWhere(reviewId, hiddenUserIds = []) {
  return {
    reviewId,
    parentCommentId: null,
    ...buildCommentVisibilityWhere(hiddenUserIds),
    OR: [
      {
        isDeleted: false
      },
      {
        replies: {
          some: buildActiveReplyWhere(hiddenUserIds)
        }
      }
    ]
  };
}

function resolveRootCommentId(comment) {
  return comment?.rootCommentId ?? comment?.parentCommentId ?? comment?.id ?? null;
}

function buildUuidListSql(values) {
  return Prisma.join(values.map((value) => Prisma.sql`${value}::uuid`));
}

function buildReplyCollapseMeta({
  replyCount = 0,
  latestReplyPreview = null,
  summaryReplyCountDefault = REVIEW_COMMENT_SUMMARY_REPLY_COUNT_DEFAULT
} = {}) {
  const normalizedReplyCount = Number.isInteger(replyCount)
    ? replyCount
    : Number(replyCount ?? 0);
  const hiddenOlderReplyCount = Math.max(normalizedReplyCount - summaryReplyCountDefault, 0);
  const threadCommentCount = normalizedReplyCount + 1;

  return {
    replyCount: normalizedReplyCount,
    totalReplyCount: normalizedReplyCount,
    threadReplyCount: normalizedReplyCount,
    threadCommentCount,
    totalCommentCount: threadCommentCount,
    latestReplyId: latestReplyPreview?.id ?? null,
    latestReplyCreatedAt: latestReplyPreview?.createdAt ?? null,
    summaryReplyCountDefault,
    hiddenOlderReplyCount,
    hasReplies: normalizedReplyCount > 0,
    hasMoreOlderReplies: hiddenOlderReplyCount > 0,
    replySort: REVIEW_COMMENT_REPLY_SORT,
    replyTieBreaker: REVIEW_COMMENT_REPLY_TIE_BREAKER,
    replyPageAnchor: REVIEW_COMMENT_REPLY_PREVIEW_ANCHOR,
    replyCursorDirection: REVIEW_COMMENT_REPLY_CURSOR_DIRECTION
  };
}

function mapReactionTypeToEnum(reactionType) {
  if (reactionType === 'like' || reactionType === ReviewCommentReactionType.LIKE) {
    return ReviewCommentReactionType.LIKE;
  }

  if (reactionType === 'dislike' || reactionType === ReviewCommentReactionType.DISLIKE) {
    return ReviewCommentReactionType.DISLIKE;
  }

  return null;
}

function buildCommentNotificationDeepLink({ reviewId, commentId, gameId = null }) {
  const normalizedReviewId = typeof reviewId === 'string' ? reviewId.trim() : '';
  const normalizedCommentId = typeof commentId === 'string' ? commentId.trim() : '';
  const normalizedGameId = typeof gameId === 'string' ? gameId.trim() : '';

  if (!normalizedReviewId || !normalizedCommentId) {
    return null;
  }

  const query = normalizedGameId ? `?gameId=${encodeURIComponent(normalizedGameId)}` : '';
  return `gamepedia://reviews/${normalizedReviewId}/comments/${normalizedCommentId}${query}`;
}

function assertCommentMatchesReviewScope(comment, reviewId, message = 'Comment does not belong to this review') {
  if (!reviewId) {
    return;
  }

  if (comment.reviewId !== reviewId) {
    throw new AppError(400, 'COMMENT_REVIEW_MISMATCH', message);
  }
}

function buildTextPreview(value, maxLength = 120) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return null;
  }

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 1).trimEnd()}…`;
}

async function buildIgdbGameMap(gameIds) {
  const normalizedIds = uniqueStringValues(gameIds).filter((gameId) => /^\d+$/.test(gameId));

  if (normalizedIds.length === 0) {
    return new Map();
  }

  try {
    const result = await igdbService.getGamesByIds({ gameIds: normalizedIds });
    return new Map(result.games.map((game) => [String(game.id), game]));
  } catch (error) {
    logger.warn('review-comment-igdb-hydration-skipped', {
      code: error?.code ?? null,
      message: error?.message ?? 'Review comment IGDB hydration failed',
      gameCount: normalizedIds.length
    });

    return new Map();
  }
}

function mapReviewCommentGameSummary(gameId, game) {
  if (!gameId) {
    return null;
  }

  return {
    id: gameId,
    name: game?.name ?? gameId,
    title: game?.name ?? gameId,
    coverUrl: buildGameImageResolverUrl({
      gameSource: 'IGDB',
      externalGameId: gameId,
      igdbCoverUrl: extractUsableIgdbCoverUrl(game?.coverUrl ?? null)
    })
  };
}

function mapReviewGameSummary(gameId, game) {
  if (!gameId) {
    return null;
  }

  return {
    id: gameId,
    name: game?.name ?? gameId,
    title: game?.name ?? gameId,
    coverUrl: buildGameImageResolverUrl({
      gameSource: 'IGDB',
      externalGameId: gameId,
      igdbCoverUrl: extractUsableIgdbCoverUrl(game?.coverUrl ?? null)
    })
  };
}

function mapReviewCommentReviewSummary(review, currentUserId) {
  if (!review?.id) {
    return null;
  }

  return {
    id: review.id,
    contentPreview: buildTextPreview(review.content, 140),
    containsSpoiler: Boolean(review.containsSpoiler),
    createdAt: review.createdAt ?? null,
    updatedAt: review.updatedAt ?? null,
    author: review.user
      ? {
        id: review.user.id,
        nickname: review.user.nickname,
        profileImageUrl: review.user.profileImageUrl ?? null
      }
      : null,
    isMine: review.userId === currentUserId
  };
}

function buildCommentReactionResponse({
  commentId,
  reviewId = null,
  rootCommentId = null,
  reactionContext,
  myReaction = null
}) {
  const reactionSummary = reactionContext.reactionSummaryMap.get(commentId) ?? {
    likeCount: 0,
    dislikeCount: 0
  };
  const normalizedMyReaction = myReaction === ReviewCommentReactionType.LIKE
    ? 'like'
    : (myReaction === ReviewCommentReactionType.DISLIKE ? 'dislike' : null);

  return {
    commentId,
    reviewId,
    rootCommentId,
    myReaction: normalizedMyReaction,
    viewerHasLiked: normalizedMyReaction === 'like',
    isLikedByCurrentUser: normalizedMyReaction === 'like',
    isLiked: normalizedMyReaction === 'like',
    likeCount: reactionSummary.likeCount ?? 0,
    dislikeCount: reactionSummary.dislikeCount ?? 0,
    reactions: {
      likeCount: reactionSummary.likeCount ?? 0,
      dislikeCount: reactionSummary.dislikeCount ?? 0,
      myReaction: normalizedMyReaction
    }
  };
}

function buildReviewLikeResponse({ reviewId, likeCount = 0, viewerHasLiked = false }) {
  return {
    reviewId,
    likeCount,
    viewerHasLiked,
    isLikedByCurrentUser: viewerHasLiked,
    isLiked: viewerHasLiked
  };
}

async function buildReviewLikeContext(reviewIds, currentUserId) {
  const normalizedReviewIds = uniqueStringValues(reviewIds);

  if (normalizedReviewIds.length === 0) {
    return {
      likeCountMap: new Map(),
      viewerHasLikedMap: new Map()
    };
  }

  let likeCounts = [];
  let viewerLikes = [];

  try {
    [likeCounts, viewerLikes] = await Promise.all([
      prisma.reviewLike.groupBy({
        by: ['reviewId'],
        where: {
          reviewId: {
            in: normalizedReviewIds
          }
        },
        _count: {
          _all: true
        }
      }),
      currentUserId
        ? prisma.reviewLike.findMany({
          where: {
            reviewId: {
              in: normalizedReviewIds
            },
            userId: currentUserId
          },
          select: {
            reviewId: true
          }
        })
        : []
    ]);
  } catch (error) {
    if (!isMissingTableError(error, 'review_likes') && !isMissingTableError(error, 'ReviewLike')) {
      throw error;
    }

    logger.error('review-likes-table-missing', {
      code: error.code,
      message: error.message,
      meta: error.meta ?? null
    });
  }

  return {
    likeCountMap: new Map(likeCounts.map((item) => [item.reviewId, item._count._all])),
    viewerHasLikedMap: new Map(viewerLikes.map((item) => [item.reviewId, true]))
  };
}

async function buildReviewCommentCountContext(reviewIds, hiddenUserIds = []) {
  const normalizedReviewIds = uniqueStringValues(reviewIds);
  const normalizedHiddenUserIds = uniqueStringValues(hiddenUserIds);

  if (normalizedReviewIds.length === 0) {
    return {
      commentCountMap: new Map(),
      activeCommentCountMap: new Map()
    };
  }

  let visibleCounts = [];

  try {
    visibleCounts = await prisma.reviewComment.groupBy({
      by: ['reviewId'],
      where: {
        reviewId: {
          in: normalizedReviewIds
        },
        ...(normalizedHiddenUserIds.length > 0
          ? {
            userId: {
              notIn: normalizedHiddenUserIds
            }
          }
          : {}),
        isDeleted: false
      },
      _count: {
        _all: true
      }
    });
  } catch (error) {
    if (!isMissingTableError(error, 'review_comments') && !isMissingTableError(error, 'ReviewComment')) {
      throw error;
    }

    logger.error('review-comments-table-missing', {
      code: error.code,
      message: error.message,
      meta: error.meta ?? null
    });
  }

  const visibleCommentCountMap = new Map(visibleCounts.map((item) => [item.reviewId, item._count._all]));

  return {
    commentCountMap: visibleCommentCountMap,
    activeCommentCountMap: visibleCommentCountMap
  };
}

async function buildReviewDtoContext(reviews, currentUserId, {
  hiddenUserIds = null
} = {}) {
  const reviewIds = reviews.map((review) => review.id);
  const gameIds = reviews.map((review) => review.gameId);
  const resolvedHiddenUserIds = Array.isArray(hiddenUserIds)
    ? uniqueStringValues(hiddenUserIds)
    : await moderationService.getHiddenUserIds(currentUserId);
  const [reviewLikeContext, reviewCommentCountContext, igdbGameMap] = await Promise.all([
    buildReviewLikeContext(reviewIds, currentUserId),
    buildReviewCommentCountContext(reviewIds, resolvedHiddenUserIds),
    buildIgdbGameMap(gameIds)
  ]);

  const reviewMetricsMap = new Map(
    reviews.map((review) => [
      review.id,
      {
        likeCount: reviewLikeContext.likeCountMap.get(review.id) ?? 0,
        viewerHasLiked: Boolean(reviewLikeContext.viewerHasLikedMap.get(review.id)),
        commentCount: reviewCommentCountContext.commentCountMap.get(review.id) ?? 0,
        activeCommentCount: reviewCommentCountContext.activeCommentCountMap.get(review.id) ?? 0
      }
    ])
  );
  const gameSummaryMap = new Map(
    uniqueStringValues(gameIds).map((gameId) => [
      gameId,
      mapReviewGameSummary(gameId, igdbGameMap.get(gameId) ?? null)
    ])
  );

  return {
    reviewMetricsMap,
    gameSummaryMap
  };
}

async function getEditableCurrentUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      nickname: true,
      profileImageUrl: true,
      status: true
    }
  });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User could not be found');
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw new AppError(403, 'USER_NOT_ACTIVE', 'Your account is not available for this action');
  }

  return user;
}

async function getReviewById(reviewId) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      gameId: true,
      userId: true
    }
  });

  if (!review) {
    throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review could not be found');
  }

  return review;
}

async function getReviewDetailRecordById(reviewId) {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    include: {
      user: {
        select: reviewAuthorSelect
      }
    }
  });

  if (!review) {
    throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review could not be found');
  }

  return review;
}

async function getReviewCommentById(commentId) {
  const comment = await prisma.reviewComment.findUnique({
    where: { id: commentId },
    include: reviewCommentInclude
  });

  if (!comment) {
    throw new AppError(404, 'REVIEW_COMMENT_NOT_FOUND', 'Review comment could not be found');
  }

  if (!comment.review?.id) {
    logger.warn('review-comment-orphaned', {
      commentId,
      reviewId: comment.reviewId ?? null
    });

    throw new AppError(404, 'COMMENT_REVIEW_NOT_FOUND', 'Parent review could not be found');
  }

  return comment;
}

async function assertCommentVisibilityAllowed(currentUserId, targetUserId) {
  if (!currentUserId || !targetUserId || currentUserId === targetUserId) {
    return;
  }

  const hiddenUserIds = await moderationService.getHiddenUserIds(currentUserId);

  if (hiddenUserIds.includes(targetUserId)) {
    throw new AppError(403, 'REVIEW_COMMENT_FORBIDDEN', 'This comment is not available');
  }
}

async function buildReviewCommentReactionContext(commentIds, currentUserId) {
  const normalizedCommentIds = uniqueStringValues(commentIds);

  if (normalizedCommentIds.length === 0) {
    return {
      reactionSummaryMap: new Map(),
      myReactionMap: new Map()
    };
  }

  const [reactionCounts, myReactions] = await Promise.all([
    prisma.reviewCommentReaction.groupBy({
      by: ['commentId', 'reactionType'],
      where: {
        commentId: {
          in: normalizedCommentIds
        }
      },
      _count: {
        _all: true
      }
    }),
    currentUserId
      ? prisma.reviewCommentReaction.findMany({
        where: {
          commentId: {
            in: normalizedCommentIds
          },
          userId: currentUserId
        },
        select: {
          commentId: true,
          reactionType: true
        }
      })
      : []
  ]);

  const reactionSummaryMap = new Map();

  for (const reactionCount of reactionCounts) {
    const existingSummary = reactionSummaryMap.get(reactionCount.commentId) ?? {
      likeCount: 0,
      dislikeCount: 0
    };

    if (reactionCount.reactionType === ReviewCommentReactionType.LIKE) {
      existingSummary.likeCount = reactionCount._count._all;
    } else if (reactionCount.reactionType === ReviewCommentReactionType.DISLIKE) {
      existingSummary.dislikeCount = reactionCount._count._all;
    }

    reactionSummaryMap.set(reactionCount.commentId, existingSummary);
  }

  const myReactionMap = new Map(
    myReactions.map((reaction) => [reaction.commentId, reaction.reactionType])
  );

  return {
    reactionSummaryMap,
    myReactionMap
  };
}

async function buildReplyCountsMap(parentCommentIds, hiddenUserIds = []) {
  const normalizedParentCommentIds = uniqueStringValues(parentCommentIds);

  if (normalizedParentCommentIds.length === 0) {
    return new Map();
  }

  const replyCounts = await prisma.reviewComment.groupBy({
    by: ['parentCommentId'],
    where: {
      parentCommentId: {
        in: normalizedParentCommentIds
      },
      ...buildActiveReplyWhere(hiddenUserIds)
    },
    _count: {
      _all: true
    }
  });

  return new Map(
    replyCounts.map((item) => [item.parentCommentId, item._count._all])
  );
}

async function findLatestActiveReplyIdsByRootCommentIds(rootCommentIds, hiddenUserIds = []) {
  const normalizedRootCommentIds = uniqueStringValues(rootCommentIds);

  if (normalizedRootCommentIds.length === 0) {
    return new Map();
  }

  const hiddenUsersCondition = hiddenUserIds.length > 0
    ? Prisma.sql`AND c.user_id NOT IN (${buildUuidListSql(hiddenUserIds)})`
    : Prisma.empty;

  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT DISTINCT ON (c.parent_comment_id)
      c.id AS "id",
      c.parent_comment_id AS "parentCommentId"
    FROM review_comments c
    WHERE c.parent_comment_id IN (${buildUuidListSql(normalizedRootCommentIds)})
      AND c.is_deleted = false
      ${hiddenUsersCondition}
    ORDER BY c.parent_comment_id ASC, c.created_at DESC, c.id DESC
  `);

  return new Map(rows.map((row) => [row.parentCommentId, row.id]));
}

async function buildLatestReplyPreviewMap(rootCommentIds, hiddenUserIds = []) {
  const latestReplyIdsByRootCommentId = await findLatestActiveReplyIdsByRootCommentIds(
    rootCommentIds,
    hiddenUserIds
  );
  const replyIds = uniqueStringValues([...latestReplyIdsByRootCommentId.values()]);

  if (replyIds.length === 0) {
    return new Map();
  }

  const replies = await prisma.reviewComment.findMany({
    where: {
      id: {
        in: replyIds
      }
    },
    include: reviewCommentInclude
  });
  const replyMap = new Map(replies.map((reply) => [reply.id, reply]));
  const latestReplyPreviewMap = new Map();

  for (const [rootCommentId, replyId] of latestReplyIdsByRootCommentId.entries()) {
    latestReplyPreviewMap.set(
      rootCommentId,
      mapReviewCommentPreviewToDto(replyMap.get(replyId) ?? null)
    );
  }

  return latestReplyPreviewMap;
}

async function buildRootCommentSummaryList(rootComments, {
  currentUserId,
  hiddenUserIds = []
}) {
  if (!Array.isArray(rootComments) || rootComments.length === 0) {
    return [];
  }

  const rootCommentIds = rootComments.map((comment) => comment.id);
  const reviewAuthorId = rootComments[0]?.review?.userId ?? null;
  const [replyCountsMap, latestReplyPreviewMap, reactionContext] = await Promise.all([
    buildReplyCountsMap(rootCommentIds, hiddenUserIds),
    buildLatestReplyPreviewMap(rootCommentIds, hiddenUserIds),
    buildReviewCommentReactionContext(rootCommentIds, currentUserId)
  ]);

  return rootComments.map((comment) => mapReviewCommentSummaryToDto({
    threadMeta: buildReplyCollapseMeta({
      replyCount: replyCountsMap.get(comment.id) ?? 0,
      latestReplyPreview: latestReplyPreviewMap.get(comment.id) ?? null
    }),
    comment,
    currentUserId,
    reviewAuthorId,
    reactionSummary: reactionContext.reactionSummaryMap.get(comment.id) ?? {},
    myReaction: reactionContext.myReactionMap.get(comment.id) ?? null,
    replyCount: replyCountsMap.get(comment.id) ?? 0,
    latestReplyPreview: latestReplyPreviewMap.get(comment.id) ?? null
  }));
}

async function buildRootCommentSummary(rootCommentId, currentUserId, {
  hiddenUserIds = null,
  rootComment = null
} = {}) {
  const normalizedRootCommentId = typeof rootCommentId === 'string' ? rootCommentId.trim() : '';

  if (!normalizedRootCommentId) {
    return null;
  }

  const resolvedHiddenUserIds = Array.isArray(hiddenUserIds)
    ? uniqueStringValues(hiddenUserIds)
    : await moderationService.getHiddenUserIds(currentUserId);
  let resolvedRootComment = rootComment ?? await getReviewCommentById(normalizedRootCommentId);
  const effectiveRootCommentId = resolveRootCommentId(resolvedRootComment);

  if (effectiveRootCommentId !== normalizedRootCommentId) {
    resolvedRootComment = await getReviewCommentById(effectiveRootCommentId);
  }

  const [summary] = await buildRootCommentSummaryList([resolvedRootComment], {
    currentUserId,
    hiddenUserIds: resolvedHiddenUserIds
  });

  if (!summary) {
    return null;
  }

  if (summary.isDeleted && summary.replyCount === 0) {
    return null;
  }

  return summary;
}

async function resolveRootCommentCursor({ cursor, reviewId }) {
  if (!cursor) {
    return null;
  }

  const cursorComment = await prisma.reviewComment.findUnique({
    where: { id: cursor },
    select: {
      id: true,
      reviewId: true,
      parentCommentId: true,
      rootCommentId: true
    }
  });

  if (!cursorComment || cursorComment.reviewId !== reviewId) {
    throw new AppError(400, 'INVALID_COMMENT_CURSOR', 'cursor must belong to this review');
  }

  return resolveRootCommentId(cursorComment);
}

async function getSortedRootCommentIdsByLike({
  reviewId,
  hiddenUserIds = [],
  cursor = null,
  limit = REVIEW_COMMENTS_DEFAULT_LIMIT
}) {
  const normalizedHiddenUserIds = uniqueStringValues(hiddenUserIds);
  const rootVisibilityCondition = normalizedHiddenUserIds.length > 0
    ? Prisma.sql`AND c.user_id NOT IN (${buildUuidListSql(normalizedHiddenUserIds)})`
    : Prisma.empty;
  const replyVisibilityCondition = normalizedHiddenUserIds.length > 0
    ? Prisma.sql`AND child.user_id NOT IN (${buildUuidListSql(normalizedHiddenUserIds)})`
    : Prisma.empty;
  let cursorCondition = Prisma.empty;

  if (cursor) {
    const [cursorRow] = await prisma.$queryRaw(Prisma.sql`
      SELECT
        c.id AS "id",
        c.created_at AS "createdAt",
        COALESCE(COUNT(r.id), 0)::int AS "likeCount"
      FROM review_comments c
      LEFT JOIN review_comment_reactions r
        ON r.comment_id = c.id
       AND r.reaction_type = 'LIKE'
      WHERE c.id = ${cursor}::uuid
        AND c.review_id = ${reviewId}::uuid
        AND c.parent_comment_id IS NULL
        ${rootVisibilityCondition}
      GROUP BY c.id, c.created_at
    `);

    if (!cursorRow) {
      throw new AppError(400, 'INVALID_COMMENT_CURSOR', 'cursor must reference a root comment in this review');
    }

    cursorCondition = Prisma.sql`
      AND (
        COALESCE(like_stats.like_count, 0) < ${cursorRow.likeCount}
        OR (
          COALESCE(like_stats.like_count, 0) = ${cursorRow.likeCount}
          AND c.created_at < ${cursorRow.createdAt}
        )
        OR (
          COALESCE(like_stats.like_count, 0) = ${cursorRow.likeCount}
          AND c.created_at = ${cursorRow.createdAt}
          AND c.id < ${cursorRow.id}::uuid
        )
      )
    `;
  }

  const rows = await prisma.$queryRaw(Prisma.sql`
    WITH reply_stats AS (
      SELECT
        child.parent_comment_id AS "rootCommentId",
        COUNT(*)::int AS "activeReplyCount"
      FROM review_comments child
      WHERE child.review_id = ${reviewId}::uuid
        AND child.parent_comment_id IS NOT NULL
        AND child.is_deleted = false
        ${replyVisibilityCondition}
      GROUP BY child.parent_comment_id
    ),
    like_stats AS (
      SELECT
        c.id AS "commentId",
        COUNT(r.id)::int AS "likeCount"
      FROM review_comments c
      LEFT JOIN review_comment_reactions r
        ON r.comment_id = c.id
       AND r.reaction_type = 'LIKE'
      WHERE c.review_id = ${reviewId}::uuid
        AND c.parent_comment_id IS NULL
        ${rootVisibilityCondition}
      GROUP BY c.id
    )
    SELECT c.id AS "id"
    FROM review_comments c
    LEFT JOIN reply_stats
      ON reply_stats."rootCommentId" = c.id
    LEFT JOIN like_stats
      ON like_stats."commentId" = c.id
    WHERE c.review_id = ${reviewId}::uuid
      AND c.parent_comment_id IS NULL
      ${rootVisibilityCondition}
      AND (
        c.is_deleted = false
        OR COALESCE(reply_stats."activeReplyCount", 0) > 0
      )
      ${cursorCondition}
    ORDER BY COALESCE(like_stats."likeCount", 0) DESC, c.created_at DESC, c.id DESC
    LIMIT ${limit + 1}
  `);

  return rows.map((row) => row.id);
}

async function buildCommentDto(comment, {
  currentUserId,
  replyCount = null,
  replies = [],
  repliesNextCursor = null,
  reviewSummary = null,
  gameSummary = null,
  hiddenUserIds = null
} = {}) {
  const reactionContext = await buildReviewCommentReactionContext([comment.id], currentUserId);
  const resolvedHiddenUserIds = Array.isArray(hiddenUserIds)
    ? uniqueStringValues(hiddenUserIds)
    : await moderationService.getHiddenUserIds(currentUserId);
  const resolvedReplyCount = Number.isInteger(replyCount)
    ? replyCount
    : (comment.parentCommentId
      ? 0
      : await prisma.reviewComment.count({
        where: {
          parentCommentId: comment.id,
          ...buildActiveReplyWhere(resolvedHiddenUserIds)
        }
      }));
  const latestReplyPreview = comment.parentCommentId
    ? null
    : (await buildLatestReplyPreviewMap([comment.id], resolvedHiddenUserIds)).get(comment.id) ?? null;
  const threadMeta = comment.parentCommentId
    ? null
    : buildReplyCollapseMeta({
      replyCount: resolvedReplyCount,
      latestReplyPreview
    });

  return mapReviewCommentToDto({
    comment,
    currentUserId,
    reviewAuthorId: comment.review.userId,
    reactionSummary: reactionContext.reactionSummaryMap.get(comment.id) ?? {},
    myReaction: reactionContext.myReactionMap.get(comment.id) ?? null,
    replyCount: resolvedReplyCount,
    replies,
    repliesNextCursor,
    latestReplyPreview,
    threadMeta,
    reviewSummary,
    gameSummary
  });
}

async function buildReviewDto(review, currentUserId, {
  metrics = null,
  gameSummary = null
} = {}) {
  const resolvedMetrics = metrics ?? {
    likeCount: 0,
    viewerHasLiked: false,
    commentCount: 0,
    activeCommentCount: 0
  };
  const resolvedGameSummary = gameSummary ?? mapReviewGameSummary(review.gameId, null);

  return mapReviewToDto(review, currentUserId, {
    likeCount: resolvedMetrics.likeCount ?? 0,
    viewerHasLiked: Boolean(resolvedMetrics.viewerHasLiked),
    commentCount: resolvedMetrics.commentCount ?? 0,
    activeCommentCount: resolvedMetrics.activeCommentCount ?? resolvedMetrics.commentCount ?? 0,
    gameSummary: resolvedGameSummary
  });
}

async function buildReviewDiscussionSummary(reviewId, currentUserId, {
  hiddenUserIds = null
} = {}) {
  const resolvedHiddenUserIds = Array.isArray(hiddenUserIds)
    ? uniqueStringValues(hiddenUserIds)
    : await moderationService.getHiddenUserIds(currentUserId);
  const reviewCommentCountContext = await buildReviewCommentCountContext([reviewId], resolvedHiddenUserIds);
  const commentCount = reviewCommentCountContext.commentCountMap.get(reviewId) ?? 0;

  return {
    reviewId,
    commentCount,
    discussionCount: commentCount,
    activeCommentCount: commentCount,
    hasComments: commentCount > 0
  };
}

async function buildParentCommentSummary(parentCommentId, currentUserId, {
  hiddenUserIds = null
} = {}) {
  const rootCommentSummary = await buildRootCommentSummary(parentCommentId, currentUserId, {
    hiddenUserIds
  });

  if (!rootCommentSummary) {
    return null;
  }

  return {
    parentCommentId: rootCommentSummary.commentId,
    threadParentCommentId: rootCommentSummary.rootCommentId,
    rootCommentId: rootCommentSummary.rootCommentId,
    replyCount: rootCommentSummary.replyCount,
    totalReplyCount: rootCommentSummary.totalReplyCount ?? rootCommentSummary.replyCount,
    threadReplyCount: rootCommentSummary.threadReplyCount ?? rootCommentSummary.replyCount,
    threadCommentCount: rootCommentSummary.threadCommentCount ?? ((rootCommentSummary.replyCount ?? 0) + 1),
    totalCommentCount: rootCommentSummary.totalCommentCount ?? ((rootCommentSummary.replyCount ?? 0) + 1),
    hasReplies: rootCommentSummary.replyCount > 0,
    latestReplyPreview: rootCommentSummary.latestReplyPreview ?? null,
    latestReplyId: rootCommentSummary.latestReplyId ?? rootCommentSummary.latestReplyPreview?.id ?? null,
    latestReplyCreatedAt: rootCommentSummary.latestReplyCreatedAt ?? rootCommentSummary.latestReplyPreview?.createdAt ?? null,
    summaryReplyCountDefault: rootCommentSummary.summaryReplyCountDefault ?? REVIEW_COMMENT_SUMMARY_REPLY_COUNT_DEFAULT,
    hiddenOlderReplyCount: rootCommentSummary.hiddenOlderReplyCount
      ?? Math.max((rootCommentSummary.replyCount ?? 0) - REVIEW_COMMENT_SUMMARY_REPLY_COUNT_DEFAULT, 0),
    hasMoreOlderReplies: rootCommentSummary.hasMoreOlderReplies ?? false,
    replySort: rootCommentSummary.replySort ?? REVIEW_COMMENT_REPLY_SORT,
    replyTieBreaker: rootCommentSummary.replyTieBreaker ?? REVIEW_COMMENT_REPLY_TIE_BREAKER,
    replyPageAnchor: rootCommentSummary.replyPageAnchor ?? REVIEW_COMMENT_REPLY_PREVIEW_ANCHOR,
    replyCursorDirection: rootCommentSummary.replyCursorDirection ?? REVIEW_COMMENT_REPLY_CURSOR_DIRECTION,
    rootComment: rootCommentSummary
  };
}

async function createCommentNotification({
  recipientUserId,
  actorUser,
  type,
  review,
  comment,
  parentCommentId = null,
  dedupeKey,
  throttleWindowMs = REVIEW_COMMENT_REACTION_THROTTLE_MS
}) {
  if (!recipientUserId || recipientUserId === actorUser?.id) {
    return null;
  }

  const throttleWindowStart = new Date(Date.now() - throttleWindowMs);
  const existingNotification = await prisma.userNotification.findFirst({
    where: {
      userId: recipientUserId,
      dedupeKey,
      createdAt: {
        gte: throttleWindowStart
      }
    },
    select: { id: true }
  });

  if (existingNotification) {
    return null;
  }

  const deepLink = buildCommentNotificationDeepLink({
    reviewId: review.id,
    commentId: comment.id,
    gameId: review.gameId
  });
  const notificationCopy = type === COMMENT_NOTIFICATION_TYPE.COMMENT_REPLY
    ? {
      title: `${actorUser.nickname}님이 댓글에 답글을 남겼어요`,
      message: '리뷰 댓글 대화에 새로운 답글이 도착했어요'
    }
    : (type === COMMENT_NOTIFICATION_TYPE.COMMENT_REACTION_LIKE
      ? {
        title: `${actorUser.nickname}님이 댓글을 좋아해요`,
        message: '내 댓글에 좋아요가 추가됐어요'
      }
      : {
        title: `${actorUser.nickname}님이 댓글에 싫어요를 남겼어요`,
        message: '내 댓글에 싫어요가 추가됐어요'
      });

  const notification = await prisma.userNotification.create({
    data: {
      userId: recipientUserId,
      type,
      title: notificationCopy.title,
      message: notificationCopy.message,
      relatedGameId: review.gameId ?? null,
      dedupeKey,
      payload: {
        deepLink,
        reviewId: review.id,
        gameId: review.gameId,
        commentId: comment.id,
        parentCommentId: parentCommentId ?? null,
        actor: {
          id: actorUser.id,
          nickname: actorUser.nickname,
          profileImageUrl: actorUser.profileImageUrl ?? null
        }
      }
    }
  });

  logger.info('review-comment-notification-created', {
    notificationId: notification.id,
    type,
    recipientUserId,
    actorUserId: actorUser.id,
    reviewId: review.id,
    commentId: comment.id
  });

  return notification;
}

async function createReview({ userId, gameId, rating, content, containsSpoiler = false }) {
  const trimmedContent = content.trim();

  // Review creation is row-based: the same user can create multiple reviews for the same game.
  // Editing remains reviewId-based through updateReview.
  const review = await prisma.review.create({
    data: {
      userId,
      gameId,
      rating: new Prisma.Decimal(rating),
      content: trimmedContent,
      containsSpoiler: Boolean(containsSpoiler)
    },
    include: {
      user: {
        select: reviewAuthorSelect
      }
    }
  });

  try {
    await userActivityService.recordReviewCreatedActivity({
      userId,
      review
    });
  } catch (activityError) {
    logger.warn('review-activity-create-failed', {
      userId,
      gameId,
      reviewId: review.id,
      code: activityError?.code ?? null,
      message: activityError?.message ?? 'Review activity creation failed'
    });
  }

  logger.info('review-created', {
    userId,
    gameId,
    reviewId: review.id
  });
  const reviewDtoContext = await buildReviewDtoContext([review], userId);

  return {
    review: await buildReviewDto(review, userId, {
      metrics: reviewDtoContext.reviewMetricsMap.get(review.id) ?? null,
      gameSummary: reviewDtoContext.gameSummaryMap.get(review.gameId) ?? null
    })
  };
}

async function getGameReviews({ currentUserId, gameId, sort, limit = null }) {
  const hiddenUserIds = await moderationService.getHiddenUserIds(currentUserId);
  const reviewWhere = {
    gameId,
    ...(hiddenUserIds.length > 0 ? {
      userId: {
        notIn: hiddenUserIds
      }
    } : {})
  };

  const normalizedSort = normalizeReviewSort(sort);
  const resolvedLimit = limit == null
    ? null
    : normalizePositiveInteger(limit, REVIEW_COMMENTS_MAX_LIMIT, REVIEW_COMMENTS_MAX_LIMIT);
  const [reviews, aggregation] = await prisma.$transaction([
    prisma.review.findMany({
      // Moderation hook: hide reviews authored by users hidden through blocking.
      where: reviewWhere,
      orderBy: getReviewOrderBy(normalizedSort),
      ...(resolvedLimit ? { take: resolvedLimit } : {}),
      include: {
        user: {
          select: reviewAuthorSelect
        }
      }
    }),
    prisma.review.aggregate({
      where: reviewWhere,
      _count: {
        id: true
      },
      _avg: {
        rating: true
      }
    })
  ]);
  const reviewDtoContext = await buildReviewDtoContext(reviews, currentUserId, {
    hiddenUserIds
  });

  return {
    reviews: mapReviewListToDto(reviews, currentUserId, reviewDtoContext),
    meta: {
      sort: normalizedSort,
      limit: resolvedLimit,
      returnedCount: reviews.length,
      reviewCount: aggregation._count.id,
      averageRating: mapAverageRating(aggregation._avg.rating)
    }
  };
}

function buildReviewCommentListSummary({
  reviewId,
  visibleRootThreadCount,
  activeRootCommentCount,
  commentCount
}) {
  return {
    reviewId,
    rootCommentCount: visibleRootThreadCount,
    totalRootCommentCount: visibleRootThreadCount,
    activeRootCommentCount,
    visibleThreadCount: visibleRootThreadCount,
    commentCount,
    discussionCount: commentCount,
    activeCommentCount: commentCount,
    hasComments: visibleRootThreadCount > 0
  };
}

async function getVisibleRootCommentPage({
  reviewId,
  hiddenUserIds = [],
  sort = REVIEW_COMMENT_DEFAULT_SORT,
  cursor = null,
  limit = REVIEW_COMMENTS_DEFAULT_LIMIT
}) {
  const normalizedSort = normalizeRootCommentSort(sort);
  const normalizedCursor = await resolveRootCommentCursor({
    cursor,
    reviewId
  });

  if (normalizedSort === 'like') {
    const rootCommentIds = await getSortedRootCommentIdsByLike({
      reviewId,
      hiddenUserIds,
      cursor: normalizedCursor,
      limit
    });
    const hasMore = rootCommentIds.length > limit;
    const pagedRootCommentIds = hasMore ? rootCommentIds.slice(0, limit) : rootCommentIds;

    return {
      rootCommentIds: pagedRootCommentIds,
      hasMore,
      nextCursor: hasMore ? pagedRootCommentIds[pagedRootCommentIds.length - 1] ?? null : null,
      sort: normalizedSort
    };
  }

  const queryArgs = {
    where: buildVisibleRootCommentWhere(reviewId, hiddenUserIds),
    select: {
      id: true
    },
    orderBy: getRootCommentOrderBy(normalizedSort),
    take: limit + 1
  };

  if (normalizedCursor) {
    queryArgs.cursor = {
      id: normalizedCursor
    };
    queryArgs.skip = 1;
  }

  const rootCommentRows = await prisma.reviewComment.findMany(queryArgs);
  const hasMore = rootCommentRows.length > limit;
  const pagedRootCommentIds = (hasMore ? rootCommentRows.slice(0, limit) : rootCommentRows)
    .map((row) => row.id);

  return {
    rootCommentIds: pagedRootCommentIds,
    hasMore,
    nextCursor: hasMore ? pagedRootCommentIds[pagedRootCommentIds.length - 1] ?? null : null,
    sort: normalizedSort
  };
}

async function getReviewDetail({
  currentUserId,
  reviewId,
  commentsCursor = null,
  commentsLimit = REVIEW_COMMENTS_DEFAULT_LIMIT,
  commentsSort = REVIEW_COMMENT_DEFAULT_SORT
}) {
  return getReviewComments({
    currentUserId,
    reviewId,
    cursor: commentsCursor,
    limit: commentsLimit,
    sort: commentsSort
  });
}

async function getMyReviews({ currentUserId, sort, limit }) {
  const normalizedSort = normalizeReviewSort(sort);
  const [reviews, totalCount] = await prisma.$transaction([
    prisma.review.findMany({
      where: { userId: currentUserId },
      orderBy: getReviewOrderBy(normalizedSort),
      ...(Number.isInteger(limit) && limit > 0 ? { take: limit } : {}),
      include: {
        user: {
          select: reviewAuthorSelect
        }
      }
    }),
    prisma.review.count({
      where: { userId: currentUserId }
    })
  ]);
  const reviewDtoContext = await buildReviewDtoContext(reviews, currentUserId);

  return {
    reviews: mapReviewListToDto(reviews, currentUserId, reviewDtoContext),
    meta: {
      sort: normalizedSort,
      reviewCount: totalCount
    }
  };
}

async function getMyGameReviews({ currentUserId, gameId, sort = 'latest', limit = null }) {
  const normalizedSort = normalizeReviewSort(sort);
  const resolvedLimit = limit == null
    ? null
    : normalizePositiveInteger(limit, REVIEW_COMMENTS_MAX_LIMIT, REVIEW_COMMENTS_MAX_LIMIT);
  const [reviews, totalCount] = await prisma.$transaction([
    prisma.review.findMany({
      where: {
        userId: currentUserId,
        gameId
      },
      orderBy: getReviewOrderBy(normalizedSort),
      ...(resolvedLimit ? { take: resolvedLimit } : {}),
      include: {
        user: {
          select: reviewAuthorSelect
        }
      }
    }),
    prisma.review.count({
      where: {
        userId: currentUserId,
        gameId
      }
    })
  ]);
  const reviewDtoContext = await buildReviewDtoContext(reviews, currentUserId);

  return {
    reviews: mapReviewListToDto(reviews, currentUserId, reviewDtoContext),
    meta: {
      sort: normalizedSort,
      limit: resolvedLimit,
      returnedCount: reviews.length,
      reviewCount: totalCount
    }
  };
}

async function updateReview({ currentUserId, reviewId, rating, content, containsSpoiler }) {
  const existingReview = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      userId: true,
      gameId: true,
      rating: true,
      content: true
    }
  });

  if (!existingReview) {
    throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review could not be found');
  }

  if (existingReview.userId !== currentUserId) {
    throw new AppError(403, 'REVIEW_FORBIDDEN', 'You can only edit your own review');
  }

  const updatedReview = await prisma.review.update({
    where: { id: reviewId },
    data: buildReviewData({
      rating,
      content,
      containsSpoiler
    }),
    include: {
      user: {
        select: reviewAuthorSelect
      }
    }
  });

  try {
    await userActivityService.recordReviewUpdatedActivity({
      userId: currentUserId,
      review: updatedReview,
      previousRating: existingReview.rating,
      previousContent: existingReview.content
    });
  } catch (activityError) {
    logger.warn('review-activity-update-failed', {
      userId: currentUserId,
      reviewId,
      code: activityError?.code ?? null,
      message: activityError?.message ?? 'Review activity update failed'
    });
  }
  const reviewDtoContext = await buildReviewDtoContext([updatedReview], currentUserId);

  return {
    review: await buildReviewDto(updatedReview, currentUserId, {
      metrics: reviewDtoContext.reviewMetricsMap.get(updatedReview.id) ?? null,
      gameSummary: reviewDtoContext.gameSummaryMap.get(updatedReview.gameId) ?? null
    })
  };
}

async function deleteReview({ currentUserId, reviewId }) {
  const existingReview = await prisma.review.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      userId: true
    }
  });

  if (!existingReview) {
    throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review could not be found');
  }

  if (existingReview.userId !== currentUserId) {
    throw new AppError(403, 'REVIEW_FORBIDDEN', 'You can only delete your own review');
  }

  await prisma.review.delete({
    where: { id: reviewId }
  });

  return {
    deleted: true,
    reviewId
  };
}

async function likeReview({ currentUserId, reviewId }) {
  await getEditableCurrentUser(currentUserId);
  const review = await getReviewDetailRecordById(reviewId);

  await assertCommentVisibilityAllowed(currentUserId, review.userId);

  await prisma.reviewLike.upsert({
    where: {
      reviewId_userId: {
        reviewId,
        userId: currentUserId
      }
    },
    create: {
      reviewId,
      userId: currentUserId
    },
    update: {}
  });

  const reviewLikeContext = await buildReviewLikeContext([reviewId], currentUserId);

  logger.info('review-like-added', {
    userId: currentUserId,
    reviewId
  });

  return buildReviewLikeResponse({
    reviewId,
    likeCount: reviewLikeContext.likeCountMap.get(reviewId) ?? 0,
    viewerHasLiked: Boolean(reviewLikeContext.viewerHasLikedMap.get(reviewId))
  });
}

async function removeReviewLike({ currentUserId, reviewId }) {
  await getEditableCurrentUser(currentUserId);
  const review = await getReviewDetailRecordById(reviewId);

  await assertCommentVisibilityAllowed(currentUserId, review.userId);

  await prisma.reviewLike.deleteMany({
    where: {
      reviewId,
      userId: currentUserId
    }
  });

  const reviewLikeContext = await buildReviewLikeContext([reviewId], currentUserId);

  logger.info('review-like-removed', {
    userId: currentUserId,
    reviewId
  });

  return buildReviewLikeResponse({
    reviewId,
    likeCount: reviewLikeContext.likeCountMap.get(reviewId) ?? 0,
    viewerHasLiked: Boolean(reviewLikeContext.viewerHasLikedMap.get(reviewId))
  });
}

async function getReviewComments({
  currentUserId,
  reviewId,
  cursor = null,
  limit = REVIEW_COMMENTS_DEFAULT_LIMIT,
  sort = REVIEW_COMMENT_DEFAULT_SORT
}) {
  const [review, hiddenUserIds] = await Promise.all([
    getReviewDetailRecordById(reviewId),
    moderationService.getHiddenUserIds(currentUserId)
  ]);

  await assertCommentVisibilityAllowed(currentUserId, review.userId);

  const resolvedLimit = normalizePositiveInteger(limit, REVIEW_COMMENTS_DEFAULT_LIMIT);
  const commentVisibilityWhere = buildCommentVisibilityWhere(hiddenUserIds);
  const baseCommentWhere = {
    reviewId,
    ...commentVisibilityWhere
  };
  const rootCommentPage = await getVisibleRootCommentPage({
    reviewId,
    hiddenUserIds,
    sort,
    cursor,
    limit: resolvedLimit
  });
  const [reviewDtoContext, rootComments, visibleRootThreadCount, activeRootCommentCount, visibleCommentCount] = await Promise.all([
    buildReviewDtoContext([review], currentUserId, {
      hiddenUserIds
    }),
    rootCommentPage.rootCommentIds.length > 0
      ? prisma.reviewComment.findMany({
        where: {
          id: {
            in: rootCommentPage.rootCommentIds
          }
        },
        include: reviewCommentInclude
      })
      : [],
    prisma.reviewComment.count({
      where: buildVisibleRootCommentWhere(reviewId, hiddenUserIds)
    }),
    prisma.reviewComment.count({
      where: {
        reviewId,
        parentCommentId: null,
        isDeleted: false,
        ...commentVisibilityWhere
      }
    }),
    prisma.reviewComment.count({
      where: {
        ...baseCommentWhere,
        isDeleted: false
      }
    })
  ]);
  const rootCommentMap = new Map(rootComments.map((comment) => [comment.id, comment]));
  const orderedRootComments = rootCommentPage.rootCommentIds
    .map((commentId) => rootCommentMap.get(commentId))
    .filter(Boolean);
  const rootCommentSummaries = await buildRootCommentSummaryList(orderedRootComments, {
    currentUserId,
    hiddenUserIds
  });
  const discussionSummary = buildReviewCommentListSummary({
    reviewId,
    visibleRootThreadCount,
    activeRootCommentCount,
    commentCount: visibleCommentCount
  });

  return {
    review: await buildReviewDto(review, currentUserId, {
      metrics: reviewDtoContext.reviewMetricsMap.get(review.id) ?? {
        likeCount: 0,
        viewerHasLiked: false,
        commentCount: visibleCommentCount,
        activeCommentCount: visibleCommentCount
      },
      gameSummary: reviewDtoContext.gameSummaryMap.get(review.gameId) ?? null
    }),
    summary: discussionSummary,
    rootComments: rootCommentSummaries,
    comments: rootCommentSummaries,
    meta: {
      limit: resolvedLimit,
      returnedCount: rootCommentSummaries.length,
      sort: rootCommentPage.sort,
      nextCursor: rootCommentPage.nextCursor,
      totalTopLevelCount: visibleRootThreadCount,
      topLevelCommentCount: visibleRootThreadCount,
      activeTopLevelCommentCount: activeRootCommentCount,
      totalCommentCount: visibleCommentCount,
      commentCount: visibleCommentCount,
      discussionCount: visibleCommentCount,
      activeCommentCount: visibleCommentCount,
      hasComments: discussionSummary.hasComments,
      depthPolicy: buildReviewCommentDepthPolicy()
    }
  };
}

async function getReviewCommentReplies({
  currentUserId,
  reviewId,
  commentId,
  cursor = null,
  limit = REVIEW_COMMENTS_DEFAULT_LIMIT
}) {
  const [review, hiddenUserIds, requestedComment] = await Promise.all([
    getReviewById(reviewId),
    moderationService.getHiddenUserIds(currentUserId),
    getReviewCommentById(commentId)
  ]);

  if (requestedComment.reviewId !== reviewId) {
    throw new AppError(400, 'COMMENT_REVIEW_MISMATCH', 'Comment does not belong to this review');
  }

  await assertCommentVisibilityAllowed(currentUserId, requestedComment.userId);

  const threadParentId = resolveRootCommentId(requestedComment);
  const threadRootComment = threadParentId === requestedComment.id
    ? requestedComment
    : await getReviewCommentById(threadParentId);

  await assertCommentVisibilityAllowed(currentUserId, threadRootComment.userId);

  const resolvedLimit = normalizePositiveInteger(limit, REVIEW_COMMENTS_DEFAULT_LIMIT);
  const queryArgs = {
    where: {
      parentCommentId: threadParentId,
      ...buildActiveReplyWhere(hiddenUserIds)
    },
    include: reviewCommentInclude,
    orderBy: getReplyPageOrderBy(),
    take: resolvedLimit + 1
  };

  if (cursor) {
    queryArgs.cursor = { id: cursor };
    queryArgs.skip = 1;
  }

  const [repliesResult, totalCount] = await Promise.all([
    prisma.reviewComment.findMany(queryArgs),
    prisma.reviewComment.count({
      where: queryArgs.where
    })
  ]);
  const hasMore = repliesResult.length > resolvedLimit;
  const pageReplies = hasMore ? repliesResult.slice(0, resolvedLimit) : repliesResult;
  const replies = [...pageReplies].reverse();
  const rootCommentSummary = await buildRootCommentSummary(threadParentId, currentUserId, {
    hiddenUserIds,
    rootComment: threadRootComment
  });
  const reactionContext = await buildReviewCommentReactionContext(
    replies.map((reply) => reply.id),
    currentUserId
  );
  const threadReplyMeta = rootCommentSummary
    ? buildReplyCollapseMeta({
      replyCount: rootCommentSummary.replyCount ?? totalCount,
      latestReplyPreview: rootCommentSummary.latestReplyPreview ?? null,
      summaryReplyCountDefault: rootCommentSummary.summaryReplyCountDefault ?? REVIEW_COMMENT_SUMMARY_REPLY_COUNT_DEFAULT
    })
    : buildReplyCollapseMeta({
      replyCount: totalCount
    });

  return {
    review: {
      id: review.id,
      gameId: review.gameId,
      authorId: review.userId
    },
    parentCommentId: threadParentId,
    rootCommentId: threadParentId,
    threadParentCommentId: threadParentId,
    rootComment: rootCommentSummary,
    replies: replies.map((reply) => mapReviewCommentToDto({
      comment: reply,
      currentUserId,
      reviewAuthorId: review.userId,
      reactionSummary: reactionContext.reactionSummaryMap.get(reply.id) ?? {},
      myReaction: reactionContext.myReactionMap.get(reply.id) ?? null,
      replyCount: 0,
      replies: [],
      repliesNextCursor: null
    })),
    meta: {
      limit: resolvedLimit,
      sort: REVIEW_COMMENT_REPLY_SORT,
      tieBreaker: REVIEW_COMMENT_REPLY_TIE_BREAKER,
      replySort: REVIEW_COMMENT_REPLY_SORT,
      replyTieBreaker: REVIEW_COMMENT_REPLY_TIE_BREAKER,
      replyPageAnchor: REVIEW_COMMENT_REPLY_PREVIEW_ANCHOR,
      replyCursorDirection: REVIEW_COMMENT_REPLY_CURSOR_DIRECTION,
      nextCursor: hasMore ? replies[0]?.id ?? null : null,
      hasMoreReplies: hasMore,
      returnedCount: replies.length,
      returnedReplyCount: replies.length,
      totalCount,
      totalReplyCount: totalCount,
      ...threadReplyMeta,
      depthPolicy: buildReviewCommentDepthPolicy()
    }
  };
}

async function getReviewCommentThread({
  currentUserId,
  reviewId,
  rootCommentId
}) {
  const [review, hiddenUserIds, requestedComment] = await Promise.all([
    getReviewById(reviewId),
    moderationService.getHiddenUserIds(currentUserId),
    getReviewCommentById(rootCommentId)
  ]);

  if (requestedComment.reviewId !== reviewId) {
    throw new AppError(400, 'COMMENT_REVIEW_MISMATCH', 'Comment does not belong to this review');
  }

  await assertCommentVisibilityAllowed(currentUserId, requestedComment.userId);

  const normalizedRootCommentId = resolveRootCommentId(requestedComment);
  const rootComment = normalizedRootCommentId === requestedComment.id
    ? requestedComment
    : await getReviewCommentById(normalizedRootCommentId);

  await assertCommentVisibilityAllowed(currentUserId, rootComment.userId);

  const replies = await prisma.reviewComment.findMany({
    where: {
      parentCommentId: normalizedRootCommentId,
      ...buildActiveReplyWhere(hiddenUserIds)
    },
    include: reviewCommentInclude,
    orderBy: getReplyOrderBy()
  });
  const activeReplyCount = replies.length;
  const latestReplyPreview = (await buildLatestReplyPreviewMap([normalizedRootCommentId], hiddenUserIds))
    .get(normalizedRootCommentId) ?? null;
  const threadReplyMeta = buildReplyCollapseMeta({
    replyCount: activeReplyCount,
    latestReplyPreview
  });
  const reactionContext = await buildReviewCommentReactionContext(
    [normalizedRootCommentId, ...replies.map((reply) => reply.id)],
    currentUserId
  );

  return {
    review: {
      id: review.id,
      gameId: review.gameId,
      authorId: review.userId
    },
    summary: {
      reviewId,
      rootCommentId: normalizedRootCommentId,
      replyCount: activeReplyCount,
      totalReplyCount: replies.length,
      latestReplyPreview,
      ...threadReplyMeta,
      hasReplies: activeReplyCount > 0
    },
    rootComment: mapReviewCommentToDto({
      comment: rootComment,
      currentUserId,
      reviewAuthorId: review.userId,
      reactionSummary: reactionContext.reactionSummaryMap.get(rootComment.id) ?? {},
      myReaction: reactionContext.myReactionMap.get(rootComment.id) ?? null,
      replyCount: activeReplyCount,
      latestReplyPreview,
      threadMeta: threadReplyMeta
    }),
    replies: replies.map((reply) => mapReviewCommentToDto({
      comment: reply,
      currentUserId,
      reviewAuthorId: review.userId,
      reactionSummary: reactionContext.reactionSummaryMap.get(reply.id) ?? {},
      myReaction: reactionContext.myReactionMap.get(reply.id) ?? null,
      replyCount: 0
    })),
    meta: {
      sort: REVIEW_COMMENT_THREAD_SORT,
      tieBreaker: REVIEW_COMMENT_REPLY_TIE_BREAKER,
      replySort: REVIEW_COMMENT_REPLY_SORT,
      replyTieBreaker: REVIEW_COMMENT_REPLY_TIE_BREAKER,
      replyPageAnchor: REVIEW_COMMENT_REPLY_PREVIEW_ANCHOR,
      replyCursorDirection: REVIEW_COMMENT_REPLY_CURSOR_DIRECTION,
      nextCursor: null,
      hasMoreReplies: false,
      returnedCount: replies.length,
      returnedReplyCount: replies.length,
      totalCount: activeReplyCount,
      activeReplyCount,
      ...threadReplyMeta,
      depthPolicy: buildReviewCommentDepthPolicy()
    }
  };
}

async function createReviewComment({
  currentUserId,
  reviewId,
  content,
  parentCommentId = null,
  replyToCommentId = null
}) {
  logger.info('review-comment-create-attempt', {
    userId: currentUserId,
    reviewId,
    parentCommentId: parentCommentId ?? null,
    replyToCommentId: replyToCommentId ?? null
  });

  try {
    const actorUser = await getEditableCurrentUser(currentUserId);
    const review = await getReviewById(reviewId);

    await assertCommentVisibilityAllowed(currentUserId, review.userId);

    let parentComment = null;
    let replyTargetComment = null;
    let rootCommentId = null;
    let depth = 0;
    let commentId = randomUUID();

    if (parentCommentId) {
      parentComment = await getReviewCommentById(parentCommentId);
      assertCommentMatchesReviewScope(parentComment, reviewId, 'Parent comment does not belong to this review');

      await assertCommentVisibilityAllowed(currentUserId, parentComment.userId);
      rootCommentId = resolveRootCommentId(parentComment);
      replyTargetComment = parentComment;

      if (parentComment.isDeleted) {
        throw new AppError(409, 'COMMENT_PARENT_DELETED', 'You cannot reply to a deleted comment');
      }

      if (replyToCommentId && replyToCommentId !== parentComment.id) {
        replyTargetComment = await getReviewCommentById(replyToCommentId);
      }

      if (replyTargetComment) {
        assertCommentMatchesReviewScope(replyTargetComment, reviewId, 'Reply target comment does not belong to this review');

        const replyTargetThreadParentId = resolveRootCommentId(replyTargetComment);

        if (replyTargetThreadParentId !== rootCommentId) {
          throw new AppError(400, 'COMMENT_THREAD_MISMATCH', 'replyToCommentId must belong to the same comment thread');
        }

        if (replyTargetComment.isDeleted) {
          throw new AppError(409, 'COMMENT_REPLY_TARGET_DELETED', 'You cannot reply to a deleted comment');
        }

        await assertCommentVisibilityAllowed(currentUserId, replyTargetComment.userId);
      }

      depth = REVIEW_COMMENT_MAX_DEPTH;
    } else {
      rootCommentId = commentId;
    }

    const createdComment = await prisma.reviewComment.create({
      data: {
        id: commentId,
        reviewId,
        userId: currentUserId,
        parentCommentId: depth === 0 ? null : rootCommentId,
        rootCommentId,
        replyToCommentId: replyTargetComment?.id ?? null,
        content: content.trim(),
        depth
      },
      include: reviewCommentInclude
    });

    if (replyTargetComment && replyTargetComment.userId !== currentUserId) {
      await createCommentNotification({
        recipientUserId: replyTargetComment.userId,
        actorUser,
        type: COMMENT_NOTIFICATION_TYPE.COMMENT_REPLY,
        review,
        comment: createdComment,
        parentCommentId: rootCommentId,
        dedupeKey: `comment-reply:${createdComment.id}:${replyTargetComment.userId}`,
        throttleWindowMs: REVIEW_COMMENT_REACTION_THROTTLE_MS
      });
    }

    logger.info('review-comment-created', {
      userId: currentUserId,
      reviewId,
      commentId: createdComment.id,
      parentCommentId: createdComment.parentCommentId ?? null,
      rootCommentId: createdComment.rootCommentId,
      replyToCommentId: createdComment.replyToCommentId ?? null,
      depth: createdComment.depth
    });

    const [commentDto, discussionSummary, rootCommentSummary, parentCommentSummary] = await Promise.all([
      buildCommentDto(createdComment, {
        currentUserId,
        replyCount: 0,
        replies: [],
        repliesNextCursor: null
      }),
      buildReviewDiscussionSummary(reviewId, currentUserId),
      buildRootCommentSummary(createdComment.rootCommentId, currentUserId),
      buildParentCommentSummary(createdComment.rootCommentId, currentUserId)
    ]);

    return {
      comment: commentDto,
      discussionSummary,
      rootCommentSummary,
      parentCommentSummary
    };
  } catch (error) {
    logger.warn('review-comment-create-failed', {
      userId: currentUserId,
      reviewId,
      parentCommentId: parentCommentId ?? null,
      replyToCommentId: replyToCommentId ?? null,
      code: error?.code ?? null,
      message: error?.message ?? 'Review comment creation failed'
    });

    throw error;
  }
}

async function updateReviewComment({
  currentUserId,
  reviewId = null,
  commentId,
  content
}) {
  await getEditableCurrentUser(currentUserId);
  const existingComment = await getReviewCommentById(commentId);
  const trimmedContent = content.trim();

  assertCommentMatchesReviewScope(existingComment, reviewId);

  if (existingComment.userId !== currentUserId) {
    throw new AppError(403, 'COMMENT_FORBIDDEN', 'You can only edit your own comment');
  }

  if (existingComment.isDeleted) {
    throw new AppError(409, 'COMMENT_DELETED', 'Deleted comments cannot be edited');
  }

  if (existingComment.content === trimmedContent) {
    const [commentDto, rootCommentSummary, parentCommentSummary] = await Promise.all([
      buildCommentDto(existingComment, {
        currentUserId
      }),
      buildRootCommentSummary(existingComment.rootCommentId, currentUserId, {
        rootComment: existingComment.parentCommentId ? null : existingComment
      }),
      buildParentCommentSummary(existingComment.rootCommentId, currentUserId)
    ]);

    return {
      comment: commentDto,
      rootCommentSummary,
      parentCommentSummary
    };
  }

  const updatedComment = await prisma.reviewComment.update({
    where: { id: commentId },
    data: {
      content: trimmedContent
    },
    include: reviewCommentInclude
  });

  logger.info('review-comment-updated', {
    userId: currentUserId,
    commentId
  });

  const [commentDto, rootCommentSummary, parentCommentSummary] = await Promise.all([
    buildCommentDto(updatedComment, {
      currentUserId
    }),
    buildRootCommentSummary(updatedComment.rootCommentId, currentUserId, {
      rootComment: updatedComment.parentCommentId ? null : updatedComment
    }),
    buildParentCommentSummary(updatedComment.rootCommentId, currentUserId)
  ]);

  return {
    comment: commentDto,
    rootCommentSummary,
    parentCommentSummary
  };
}

async function deleteReviewComment({
  currentUserId,
  reviewId = null,
  commentId
}) {
  await getEditableCurrentUser(currentUserId);
  const existingComment = await getReviewCommentById(commentId);

  assertCommentMatchesReviewScope(existingComment, reviewId);

  if (existingComment.userId !== currentUserId) {
    throw new AppError(403, 'COMMENT_FORBIDDEN', 'You can only delete your own comment');
  }

  const deletedComment = await prisma.$transaction(async (tx) => {
    const deletedAt = existingComment.deletedAt ?? new Date();

    if (existingComment.isDeleted) {
      return tx.reviewComment.findUnique({
        where: { id: commentId },
        include: reviewCommentInclude
      });
    }

    return tx.reviewComment.update({
      where: { id: commentId },
      data: {
        isDeleted: true,
        deletedAt,
        content: ''
      },
      include: reviewCommentInclude
    });
  });

  logger.info('review-comment-deleted', {
    userId: currentUserId,
    commentId,
    parentCommentId: deletedComment.parentCommentId ?? null,
    rootCommentId: deletedComment.rootCommentId
  });

  const [commentDto, discussionSummary, rootCommentSummary, parentCommentSummary] = await Promise.all([
    buildCommentDto(deletedComment, {
      currentUserId
    }),
    buildReviewDiscussionSummary(deletedComment.reviewId, currentUserId),
    buildRootCommentSummary(deletedComment.rootCommentId, currentUserId, {
      rootComment: deletedComment.parentCommentId ? null : deletedComment
    }),
    buildParentCommentSummary(deletedComment.rootCommentId, currentUserId)
  ]);

  return {
    deleted: true,
    comment: commentDto,
    discussionSummary,
    rootCommentSummary,
    parentCommentSummary
  };
}

async function reactToReviewComment({
  currentUserId,
  reviewId = null,
  commentId,
  reactionType
}) {
  const actorUser = await getEditableCurrentUser(currentUserId);
  const comment = await getReviewCommentById(commentId);

  assertCommentMatchesReviewScope(comment, reviewId);

  if (comment.isDeleted) {
    throw new AppError(409, 'COMMENT_DELETED', 'Deleted comments cannot receive reactions');
  }

  await assertCommentVisibilityAllowed(currentUserId, comment.userId);

  const normalizedReactionType = mapReactionTypeToEnum(reactionType);

  if (!normalizedReactionType) {
    throw new AppError(400, 'INVALID_COMMENT_REACTION', 'reactionType must be like or dislike');
  }

  const { existingReaction, persistedReaction } = await prisma.$transaction(async (tx) => {
    const previousReaction = await tx.reviewCommentReaction.findUnique({
      where: {
        commentId_userId: {
          commentId,
          userId: currentUserId
        }
      },
    });

    const currentReaction = await tx.reviewCommentReaction.upsert({
      where: {
        commentId_userId: {
          commentId,
          userId: currentUserId
        }
      },
      create: {
        commentId,
        userId: currentUserId,
        reactionType: normalizedReactionType
      },
      update: {
        reactionType: normalizedReactionType
      }
    });

    return {
      existingReaction: previousReaction,
      persistedReaction: currentReaction
    };
  });

  const reactionChanged = !existingReaction || existingReaction.reactionType !== persistedReaction.reactionType;

  if (reactionChanged && comment.userId !== currentUserId) {
    await createCommentNotification({
      recipientUserId: comment.userId,
      actorUser,
      type: normalizedReactionType === ReviewCommentReactionType.LIKE
        ? COMMENT_NOTIFICATION_TYPE.COMMENT_REACTION_LIKE
        : COMMENT_NOTIFICATION_TYPE.COMMENT_REACTION_DISLIKE,
      review: comment.review,
      comment,
      parentCommentId: comment.parentCommentId ?? null,
      dedupeKey: `comment-reaction:${commentId}:${currentUserId}`
    });
  }

  const reactionContext = await buildReviewCommentReactionContext([commentId], currentUserId);

  logger.info('review-comment-reaction-updated', {
    userId: currentUserId,
    commentId,
    reactionType: normalizedReactionType
  });

  return buildCommentReactionResponse({
    commentId,
    reviewId: comment.reviewId,
    rootCommentId: comment.rootCommentId,
    reactionContext,
    myReaction: reactionContext.myReactionMap.get(commentId) ?? normalizedReactionType
  });
}

async function removeReviewCommentReaction({
  currentUserId,
  reviewId = null,
  commentId
}) {
  await getEditableCurrentUser(currentUserId);
  const comment = await getReviewCommentById(commentId);

  assertCommentMatchesReviewScope(comment, reviewId);
  await assertCommentVisibilityAllowed(currentUserId, comment.userId);

  await prisma.reviewCommentReaction.deleteMany({
    where: {
      commentId,
      userId: currentUserId
    }
  });

  const reactionContext = await buildReviewCommentReactionContext([commentId], currentUserId);

  logger.info('review-comment-reaction-removed', {
    userId: currentUserId,
    commentId
  });

  return buildCommentReactionResponse({
    commentId,
    reviewId: comment.reviewId,
    rootCommentId: comment.rootCommentId,
    reactionContext,
    myReaction: reactionContext.myReactionMap.get(commentId) ?? null
  });
}

async function likeReviewComment({
  currentUserId,
  reviewId = null,
  commentId
}) {
  return reactToReviewComment({
    currentUserId,
    reviewId,
    commentId,
    reactionType: 'like'
  });
}

async function reportReviewComment({
  currentUserId,
  reviewId = null,
  commentId,
  reason
}) {
  await getEditableCurrentUser(currentUserId);
  const comment = await getReviewCommentById(commentId);

  assertCommentMatchesReviewScope(comment, reviewId);

  if (comment.userId === currentUserId) {
    throw new AppError(400, 'COMMENT_REPORT_SELF_FORBIDDEN', 'You cannot report your own comment');
  }

  if (comment.isDeleted) {
    throw new AppError(409, 'COMMENT_DELETED', 'Deleted comments cannot be reported');
  }

  await assertCommentVisibilityAllowed(currentUserId, comment.userId);

  try {
    const report = await prisma.reviewCommentReport.create({
      data: {
        commentId,
        reporterUserId: currentUserId,
        reason: reason.trim()
      }
    });

    logger.info('review-comment-reported', {
      userId: currentUserId,
      commentId,
      reportId: report.id
    });

    return {
      reported: true,
      commentId,
      rootCommentId: comment.rootCommentId
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return {
        reported: true,
        commentId,
        rootCommentId: comment.rootCommentId
      };
    }

    throw error;
  }
}

async function getMyReviewComments({
  currentUserId,
  page = 1,
  limit = REVIEW_COMMENTS_DEFAULT_LIMIT,
  sort = 'newest'
}) {
  await getEditableCurrentUser(currentUserId);
  const hiddenUserIds = await moderationService.getHiddenUserIds(currentUserId);

  const resolvedPage = normalizePositiveInteger(page, 1, 1000);
  const resolvedLimit = normalizePositiveInteger(limit, REVIEW_COMMENTS_DEFAULT_LIMIT);
  const skip = (resolvedPage - 1) * resolvedLimit;
  let orderedIds = [];
  let totalCount = 0;

  logger.info('my-review-comments-fetch-start', {
    userId: currentUserId,
    page: resolvedPage,
    limit: resolvedLimit,
    sort
  });

  if (sort === 'most_liked') {
    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT c.id
        FROM review_comments c
        INNER JOIN reviews rv
          ON rv.id = c.review_id
        LEFT JOIN review_comment_reactions r
          ON r.comment_id = c.id
         AND r.reaction_type = 'LIKE'
        WHERE c.user_id = ${currentUserId}::uuid
          AND c.is_deleted = false
        GROUP BY c.id, c.created_at
        ORDER BY COUNT(r.id) DESC, c.created_at DESC, c.id DESC
        LIMIT ${resolvedLimit}
        OFFSET ${skip}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS total_count
        FROM review_comments c
        INNER JOIN reviews rv
          ON rv.id = c.review_id
        WHERE c.user_id = ${currentUserId}::uuid
          AND c.is_deleted = false
      `
    ]);

    orderedIds = rows.map((row) => row.id);
    totalCount = Number(countRows[0]?.total_count ?? 0);
  } else {
    const orderBy = sort === 'oldest'
      ? [{ createdAt: 'asc' }, { id: 'asc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }];
    const [comments, count] = await Promise.all([
      prisma.reviewComment.findMany({
        where: {
          userId: currentUserId,
          isDeleted: false
        },
        orderBy,
        skip,
        take: resolvedLimit,
        select: {
          id: true
        }
      }),
      prisma.reviewComment.count({
        where: {
          userId: currentUserId,
          isDeleted: false
        }
      })
    ]);

    orderedIds = comments.map((comment) => comment.id);
    totalCount = count;
  }

  if (orderedIds.length === 0) {
    logger.info('my-review-comments-fetch-result', {
      userId: currentUserId,
      resultCount: 0,
      totalCount,
      orphanedFilteredCount: 0
    });

    return {
      comments: [],
      meta: {
        page: resolvedPage,
        limit: resolvedLimit,
        totalCount,
        totalPages: totalCount > 0 ? Math.ceil(totalCount / resolvedLimit) : 0,
        sort
      }
    };
  }

  const comments = await prisma.reviewComment.findMany({
    where: {
      id: {
        in: orderedIds
      },
      isDeleted: false
    },
    include: {
      ...reviewCommentInclude,
      review: {
        select: {
          id: true,
          gameId: true,
          userId: true,
          content: true,
          containsSpoiler: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: reviewAuthorSelect
          }
        }
      }
    }
  });
  const commentMap = new Map(comments.map((comment) => [comment.id, comment]));
  const orderedComments = orderedIds
    .map((commentId) => commentMap.get(commentId))
    .filter(Boolean);
  const validOrderedComments = orderedComments.filter((comment) => Boolean(comment.review?.id));
  const orphanedFilteredCount = orderedComments.length - validOrderedComments.length;

  if (orphanedFilteredCount > 0) {
    logger.warn('my-review-comments-orphaned-filtered', {
      userId: currentUserId,
      orphanedFilteredCount
    });
  }

  const validOrderedIds = validOrderedComments.map((comment) => comment.id);
  const topLevelCommentIds = validOrderedComments
    .filter((comment) => !comment.parentCommentId)
    .map((comment) => comment.id);
  const [replyCountsMap, reactionContext, igdbGameMap] = await Promise.all([
    buildReplyCountsMap(topLevelCommentIds, hiddenUserIds),
    buildReviewCommentReactionContext(validOrderedIds, currentUserId),
    buildIgdbGameMap(validOrderedComments.map((comment) => comment.review?.gameId))
  ]);

  logger.info('my-review-comments-fetch-result', {
    userId: currentUserId,
    resultCount: validOrderedComments.length,
    totalCount,
    orphanedFilteredCount
  });

  return {
    comments: validOrderedComments.map((comment) => mapReviewCommentToDto({
      comment,
      currentUserId,
      reviewAuthorId: comment.review.userId,
      reactionSummary: reactionContext.reactionSummaryMap.get(comment.id) ?? {},
      myReaction: reactionContext.myReactionMap.get(comment.id) ?? null,
      replyCount: comment.parentCommentId ? 0 : (replyCountsMap.get(comment.id) ?? 0),
      replies: [],
      repliesNextCursor: null,
      reviewSummary: mapReviewCommentReviewSummary(comment.review, currentUserId),
      gameSummary: mapReviewCommentGameSummary(
        comment.review.gameId,
        igdbGameMap.get(comment.review.gameId) ?? null
      )
    })),
    meta: {
      page: resolvedPage,
      limit: resolvedLimit,
      totalCount,
      totalPages: totalCount > 0 ? Math.ceil(totalCount / resolvedLimit) : 0,
      returnedCount: validOrderedComments.length,
      sort
    }
  };
}

const STEAM_LINKED_REVIEW_LIMIT = 20;

async function getSteamLinkedReviews({ currentUserId }) {
  const steamAccount = await prisma.socialAccount.findUnique({
    where: {
      userId_provider: {
        userId: currentUserId,
        provider: steamService.STEAM_AUTH_PROVIDER
      }
    },
    select: { providerSubject: true }
  });

  if (!steamAccount) {
    return { reviews: [] };
  }

  const reviews = await prisma.review.findMany({
    where: { userId: currentUserId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      user: { select: reviewAuthorSelect }
    }
  });

  if (reviews.length === 0) {
    return { reviews: [] };
  }

  const reviewGameIds = reviews.map((r) => r.gameId);

  const mappings = await prisma.steamIgdbMapping.findMany({
    where: {
      igdbGameId: { in: reviewGameIds },
      matchStatus: 'CONFIRMED'
    }
  });

  if (mappings.length === 0) {
    return { reviews: [] };
  }

  const steamAppIds = mappings.map((m) => m.steamAppId);

  const libraryEntries = await prisma.userGameLibrary.findMany({
    where: {
      userId: currentUserId,
      gameSource: 'STEAM',
      externalGameId: { in: steamAppIds }
    },
    select: { externalGameId: true }
  });

  const ownedSteamAppIds = new Set(libraryEntries.map((e) => e.externalGameId));

  const igdbToSteamMap = new Map();
  for (const mapping of mappings) {
    if (ownedSteamAppIds.has(mapping.steamAppId)) {
      igdbToSteamMap.set(mapping.igdbGameId, mapping.steamAppId);
    }
  }

  const steamLinkedReviews = reviews
    .filter((r) => igdbToSteamMap.has(r.gameId))
    .slice(0, STEAM_LINKED_REVIEW_LIMIT);

  if (steamLinkedReviews.length === 0) {
    return { reviews: [] };
  }

  const uniqueAppIds = [...new Set(
    steamLinkedReviews.map((r) => igdbToSteamMap.get(r.gameId)).filter(Boolean)
  )];

  const summaryResults = await Promise.allSettled(
    uniqueAppIds.map((appId) =>
      steamService.fetchAppReviewSummarySafe({ appId }).then((summary) => [appId, summary])
    )
  );

  const steamSummaryMap = new Map();
  for (const result of summaryResults) {
    if (result.status === 'fulfilled' && result.value) {
      const [appId, summary] = result.value;
      steamSummaryMap.set(appId, summary);
    }
  }

  const mappedReviews = steamLinkedReviews.map((review) => {
    const steamAppId = igdbToSteamMap.get(review.gameId);
    const steamMeta = steamSummaryMap.get(steamAppId) ?? null;
    return mapSteamLinkedReviewToDto(review, currentUserId, steamMeta);
  });

  return { reviews: mappedReviews };
}

module.exports = {
  createReview,
  createReviewComment,
  deleteReview,
  deleteReviewComment,
  getGameReviews,
  getReviewDetail,
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
