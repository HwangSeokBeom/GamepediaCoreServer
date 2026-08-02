const { z } = require('zod');
const { AppError } = require('../../utils/error-response');
const {
  isWellFormedUnicode,
  UNPAIRED_SURROGATE_MESSAGE
} = require('../../utils/unicode-text');
const {
  PLAY_COMPASS_ACTIONS,
  PLAY_COMPASS_REASON_CODES,
  PLAY_SESSION_MOODS,
  PLAY_SESSION_OUTCOMES,
  PLAY_SESSION_VISIBILITIES
} = require('./play.constants');

const uuidSchema = z.string().trim().uuid();
const isoDateTimeSchema = z.string().trim().datetime({ offset: true }).transform((value) => new Date(value));
const clientMutationIdSchema = z.string().trim().min(8).max(120).regex(
  /^[A-Za-z0-9._:-]+$/,
  'clientMutationId must be an opaque token of letters, digits, dot, underscore, colon or dash'
);
const timezoneSchema = z.string().trim().min(1).max(64).regex(
  /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/,
  'timezone must be an IANA identifier such as Asia/Seoul'
);
// The month component is range-checked here, not only inside the service, so an
// impossible month is rejected at the request boundary.
const monthSchema = z.string().trim()
  .regex(/^\d{4}-\d{2}$/, 'month must be formatted as YYYY-MM')
  .refine((value) => {
    const month = Number(value.slice(5, 7));
    const year = Number(value.slice(0, 4));

    return month >= 1 && month <= 12 && year >= 1970 && year <= 9999;
  }, 'month must be a real calendar month formatted as YYYY-MM');
const platformSchema = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/)
  .transform((value) => value.toUpperCase());

const createPlaySessionSchema = z.object({
  catalogGameId: uuidSchema,
  regionalReleaseId: uuidSchema.nullish(),
  playedAt: isoDateTimeSchema,
  durationMinutes: z.number().int().min(1).max(1440).nullish(),
  progressPercent: z.number().int().min(0).max(100).nullish(),
  mood: z.enum(PLAY_SESSION_MOODS).nullish(),
  // Private free text. Stored on the row, never logged, never an event property.
  note: z.string().trim().max(2000)
    .refine(isWellFormedUnicode, UNPAIRED_SURROGATE_MESSAGE).nullish(),
  outcome: z.enum(PLAY_SESSION_OUTCOMES),
  visibility: z.enum(PLAY_SESSION_VISIBILITIES).default('PRIVATE'),
  clientMutationId: clientMutationIdSchema
}).strict();

const updatePlaySessionSchema = z.object({
  catalogGameId: uuidSchema.optional(),
  regionalReleaseId: uuidSchema.nullish(),
  playedAt: isoDateTimeSchema.optional(),
  durationMinutes: z.number().int().min(1).max(1440).nullish(),
  progressPercent: z.number().int().min(0).max(100).nullish(),
  mood: z.enum(PLAY_SESSION_MOODS).nullish(),
  note: z.string().trim().max(2000)
    .refine(isWellFormedUnicode, UNPAIRED_SURROGATE_MESSAGE).nullish(),
  outcome: z.enum(PLAY_SESSION_OUTCOMES).optional(),
  visibility: z.enum(PLAY_SESSION_VISIBILITIES).optional(),
  clientMutationId: clientMutationIdSchema.optional()
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'clientMutationId'),
  { message: 'At least one mutable field must be supplied' }
);

const deletePlaySessionSchema = z.object({
  clientMutationId: clientMutationIdSchema.optional()
}).strict();

const playSessionParamsSchema = z.object({
  id: uuidSchema
}).strict();

const listPlaySessionsQuerySchema = z.object({
  catalogGameId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  outcome: z.enum(PLAY_SESSION_OUTCOMES).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().trim().max(400).optional()
}).strict().refine(
  (value) => !value.from || !value.to || value.from.getTime() < value.to.getTime(),
  { message: 'from must be earlier than to', path: ['from'] }
);

const calendarQuerySchema = z.object({
  month: monthSchema,
  timezone: timezoneSchema.default('UTC')
}).strict();

const monthlyReplayQuerySchema = z.object({
  month: monthSchema,
  timezone: timezoneSchema.default('UTC')
}).strict();

const playCompassRequestSchema = z.object({
  availableMinutes: z.number().int().min(5).max(1440),
  mood: z.enum(PLAY_SESSION_MOODS).nullish(),
  energy: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  soloOrParty: z.enum(['SOLO', 'PARTY', 'EITHER']).default('EITHER'),
  continueOrStart: z.enum(['CONTINUE', 'START', 'EITHER']).default('EITHER'),
  availablePlatforms: z.array(platformSchema).max(12).default([]),
  friendUserIds: z.array(uuidSchema).max(20).default([])
}).strict();

const playCompassEventSchema = z.object({
  catalogGameId: uuidSchema,
  action: z.enum(PLAY_COMPASS_ACTIONS),
  // Only allowlisted reason codes may be echoed back with a feedback event.
  reasonCodes: z.array(z.enum(PLAY_COMPASS_REASON_CODES)).max(12).default([]),
  requestHash: z.string().trim().regex(/^[0-9a-f]{64}$/, 'requestHash must be a SHA-256 hex digest').nullish(),
  occurredAt: isoDateTimeSchema.optional()
}).strict();

function buildPlayValidationError(error) {
  const issueFields = new Set(error.issues.map((issue) => issue.path.join('.')));

  if (error.issues.some((issue) => issue.message === UNPAIRED_SURROGATE_MESSAGE)) {
    return new AppError(400, 'INVALID_UNICODE_TEXT',
      'Persisted text must not contain an unpaired UTF-16 surrogate',
      error.issues
        .filter((issue) => issue.message === UNPAIRED_SURROGATE_MESSAGE)
        .map((issue) => ({ field: issue.path.join('.'), message: 'unpaired_surrogate' })));
  }

  if (issueFields.has('clientMutationId')) {
    return new AppError(400, 'INVALID_CLIENT_MUTATION_ID', 'clientMutationId must be an opaque token of 8 to 120 characters');
  }

  if (issueFields.has('timezone')) {
    return new AppError(400, 'INVALID_TIMEZONE', 'timezone must be an IANA identifier such as Asia/Seoul');
  }

  if (issueFields.has('month')) {
    return new AppError(400, 'INVALID_MONTH', 'month must be formatted as YYYY-MM');
  }

  if (issueFields.has('outcome')) {
    return new AppError(400, 'INVALID_PLAY_OUTCOME', 'outcome must be CONTINUE, PAUSED, DROPPED or COMPLETED');
  }

  if (issueFields.has('availableMinutes')) {
    return new AppError(400, 'INVALID_AVAILABLE_MINUTES', 'availableMinutes must be an integer between 5 and 1440');
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed',
    error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
}

module.exports = {
  buildPlayValidationError,
  calendarQuerySchema,
  createPlaySessionSchema,
  deletePlaySessionSchema,
  listPlaySessionsQuerySchema,
  monthlyReplayQuerySchema,
  playCompassEventSchema,
  playCompassRequestSchema,
  playSessionParamsSchema,
  updatePlaySessionSchema
};
