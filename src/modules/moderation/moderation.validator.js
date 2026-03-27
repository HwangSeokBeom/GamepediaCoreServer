const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const reportTargetTypeSchema = z.enum(['review', 'comment', 'user']);
const reportReasonSchema = z.enum([
  'spam',
  'harassment',
  'hate_speech',
  'sexual_content',
  'violence',
  'self_harm',
  'impersonation',
  'misinformation',
  'other'
]);
const reportTargetIdSchema = z.string().trim().min(1).max(100);
const reportDetailSchema = z.string().trim().min(1).max(1000);
const userIdSchema = z.string().uuid();

const createReportSchema = z.object({
  targetType: reportTargetTypeSchema,
  targetId: reportTargetIdSchema,
  reason: reportReasonSchema,
  detail: reportDetailSchema.optional()
}).superRefine((value, context) => {
  if ((value.targetType === 'review' || value.targetType === 'user') && !userIdSchema.safeParse(value.targetId).success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetId'],
      message: `${value.targetType} targetId must be a valid UUID`
    });
  }
});

const blockUserParamsSchema = z.object({
  userId: userIdSchema
});

function flattenModerationIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function buildModerationValidationError(error) {
  const issueFields = new Set(error.issues.map((issue) => issue.path[0]));
  const details = flattenModerationIssues(error.issues);

  console.warn(`[moderation:validation] issues=${JSON.stringify(details)}`);

  if (issueFields.has('targetType')) {
    return new AppError(400, 'INVALID_REPORT_TARGET_TYPE', 'targetType must be one of review, comment, or user', details);
  }

  if (issueFields.has('reason')) {
    return new AppError(400, 'INVALID_REPORT_REASON', 'reason must be a supported moderation reason', details);
  }

  if (issueFields.has('targetId')) {
    return new AppError(400, 'INVALID_REPORT_TARGET_ID', 'targetId is required and must match the target type format', details);
  }

  if (issueFields.has('detail')) {
    return new AppError(400, 'INVALID_REPORT_DETAIL', 'detail must be between 1 and 1000 characters when provided', details);
  }

  if (issueFields.has('userId')) {
    return new AppError(400, 'INVALID_USER_ID', 'userId must be a valid UUID', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
  blockUserParamsSchema,
  buildModerationValidationError,
  createReportSchema
};
