const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const nicknameSchema = z.string().trim().min(2).max(30);
const notificationsPageSchema = z.coerce.number().int().min(1).optional();
const notificationsLimitSchema = z.coerce.number().int().min(1).max(50).optional();
const activityFeedLimitSchema = z.coerce.number().int().min(1).max(50).optional();
const notificationIdSchema = z.string().uuid();
const userIdSchema = z.string().uuid();
const friendSearchKeywordSchema = z.string().trim().min(1).max(30);
const supportedUserTitleKeys = [
  'pro_reviewer',
  'early_adopter',
  'hardcore_gamer',
  'collector',
  'rpg_lover',
  'soulslike_lover',
  'social_player'
];

const updateCurrentUserProfileSchema = z.object({
  nickname: nicknameSchema.optional(),
  selectedTitles: z.array(z.string().trim().min(1)).max(20).optional(),
  selectedTitleKeys: z.array(z.string().trim().min(1)).max(20).optional()
}).superRefine((value, context) => {
  if (typeof value.nickname !== 'string' && !Array.isArray(value.selectedTitles) && !Array.isArray(value.selectedTitleKeys)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nickname'],
      message: 'nickname or selectedTitleKeys is required'
    });
  }
}).transform((value) => ({
  nickname: typeof value.nickname === 'string' ? value.nickname : undefined,
  selectedTitleKeys: Array.isArray(value.selectedTitleKeys)
    ? value.selectedTitleKeys
    : (Array.isArray(value.selectedTitles) ? value.selectedTitles : [])
}));

const updateMyTitlesSchema = z.object({
  selectedTitles: z.array(z.string().trim().min(1)).max(20).optional(),
  selectedTitleKeys: z.array(z.string().trim().min(1)).max(20).optional()
}).superRefine((value, context) => {
  if (!Array.isArray(value.selectedTitles) && !Array.isArray(value.selectedTitleKeys)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedTitleKeys'],
      message: 'selectedTitleKeys or selectedTitles is required'
    });
  }
}).transform((value) => ({
  selectedTitleKeys: Array.isArray(value.selectedTitleKeys)
    ? value.selectedTitleKeys
    : (Array.isArray(value.selectedTitles) ? value.selectedTitles : [])
}));

const notificationsQuerySchema = z.object({
  page: notificationsPageSchema,
  limit: notificationsLimitSchema
});

const friendActivityFeedQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: activityFeedLimitSchema
});

const markNotificationsReadSchema = z.object({
  ids: z.array(notificationIdSchema).min(1).max(100)
});

const userSearchQuerySchema = z.object({
  keyword: friendSearchKeywordSchema.optional(),
  nickname: friendSearchKeywordSchema.optional()
}).superRefine((value, context) => {
  if (!value.keyword && !value.nickname) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['keyword'],
      message: 'keyword or nickname is required'
    });
  }
}).transform((value) => ({
  keyword: value.keyword ?? value.nickname,
  keywordAliasUsed: !value.keyword && Boolean(value.nickname)
}));

const friendRequestBodySchema = z.object({
  toUserId: userIdSchema.optional(),
  targetUserId: userIdSchema.optional(),
  friendUserId: userIdSchema.optional(),
  userId: userIdSchema.optional()
}).superRefine((value, context) => {
  if (!value.toUserId && !value.targetUserId && !value.friendUserId && !value.userId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['toUserId'],
      message: 'toUserId is required'
    });
  }
}).transform((value) => {
  const resolvedField = value.toUserId
    ? 'toUserId'
    : (value.targetUserId
      ? 'targetUserId'
      : (value.friendUserId ? 'friendUserId' : 'userId'));
  const resolvedToUserId = value.toUserId ?? value.targetUserId ?? value.friendUserId ?? value.userId;

  return {
    toUserId: resolvedToUserId,
    resolvedToUserId,
    resolvedFromField: resolvedField,
    aliasFieldUsed: resolvedField !== 'toUserId'
  };
});
const blockUserBodySchema = z.object({
  blockedUserId: userIdSchema
});

const friendRequestParamsSchema = z.object({
  id: z.string().uuid()
});

const friendProfileParamsSchema = z.object({
  userId: userIdSchema
});

const friendRemovalParamsSchema = z.object({
  friendUserId: userIdSchema
});

const blockedUserParamsSchema = z.object({
  blockedUserId: userIdSchema
});

const privacySettingsSchema = z.object({
  showFriendsList: z.boolean().optional(),
  showRecentlyPlayed: z.boolean().optional(),
  showLikedGames: z.boolean().optional(),
  showReviews: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one privacy setting must be provided'
});

function buildUserValidationError(error) {
  const details = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
  const issueFields = new Set(error.issues.map((issue) => issue.path[0]));

  console.warn(`[profile:validation] issues=${JSON.stringify(details)}`);

  if (issueFields.has('page')) {
    return new AppError(400, 'INVALID_NOTIFICATIONS_PAGE', 'Page must be a positive integer', details);
  }

  if (issueFields.has('limit')) {
    return new AppError(400, 'INVALID_NOTIFICATIONS_LIMIT', 'Limit must be between 1 and 50', details);
  }

  if (issueFields.has('cursor')) {
    return new AppError(400, 'INVALID_ACTIVITY_FEED_CURSOR', 'cursor must be a valid UUID', details);
  }

  if (issueFields.has('ids')) {
    return new AppError(400, 'INVALID_NOTIFICATION_IDS', 'ids must contain one or more valid notification IDs', details);
  }

  if (issueFields.has('keyword') || issueFields.has('nickname')) {
    return new AppError(400, 'INVALID_USER_SEARCH_KEYWORD', 'keyword must be between 1 and 30 characters', details);
  }

  if (
    issueFields.has('toUserId') ||
    issueFields.has('targetUserId') ||
    issueFields.has('friendUserId') ||
    (issueFields.has('userId') && !issueFields.has('id'))
  ) {
    return new AppError(400, 'INVALID_FRIEND_REQUEST_TARGET', 'toUserId must be a valid user ID', details);
  }

  if (issueFields.has('blockedUserId')) {
    return new AppError(400, 'INVALID_BLOCK_TARGET', 'blockedUserId must be a valid user ID', details);
  }

  if (issueFields.has('id')) {
    return new AppError(400, 'INVALID_FRIEND_REQUEST_ID', 'Friend request ID must be a valid UUID', details);
  }

  if (issueFields.has('userId')) {
    return new AppError(400, 'INVALID_USER_ID', 'userId must be a valid UUID', details);
  }

  if (issueFields.has('friendUserId')) {
    return new AppError(400, 'INVALID_FRIEND_USER_ID', 'friendUserId must be a valid UUID', details);
  }

  if (
    issueFields.has('showFriendsList') ||
    issueFields.has('showRecentlyPlayed') ||
    issueFields.has('showLikedGames') ||
    issueFields.has('showReviews')
  ) {
    return new AppError(400, 'INVALID_PRIVACY_SETTINGS', 'Privacy settings must be boolean values', details);
  }

  if (issueFields.has('selectedTitles')) {
    return new AppError(400, 'INVALID_USER_TITLES', 'selectedTitles must contain up to 3 valid title keys', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
  blockUserBodySchema,
  blockedUserParamsSchema,
  buildUserValidationError,
  friendActivityFeedQuerySchema,
  friendProfileParamsSchema,
  friendRemovalParamsSchema,
  friendRequestBodySchema,
  friendRequestParamsSchema,
  markNotificationsReadSchema,
  notificationsQuerySchema,
  privacySettingsSchema,
  updateMyTitlesSchema,
  userSearchQuerySchema,
  updateCurrentUserProfileSchema
};
