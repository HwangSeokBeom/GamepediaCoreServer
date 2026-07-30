const { z } = require('zod');
const { AppError } = require('../../utils/error-response');
const {
  isWellFormedUnicode,
  UNPAIRED_SURROGATE_MESSAGE
} = require('../../utils/unicode-text');
const { CORRECTABLE_FIELD_PATHS } = require('./catalog.constants');
const { boundedText } = require('./catalog-submission.schema');

const uuidSchema = z.string().trim().uuid();
const localeSchema = z.string().trim().regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/, 'Expected a BCP-47 style locale');
const regionCodeSchema = z.string().trim().length(2).regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase());
const platformSchema = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).transform((value) => value.toUpperCase());

const catalogSearchQuerySchema = z.object({
  query: boundedText(200),
  locale: localeSchema.optional(),
  regionCode: regionCodeSchema.optional(),
  platform: platformSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().trim().max(400).optional()
}).strict();

const catalogGameParamsSchema = z.object({
  catalogGameId: uuidSchema
}).strict();

const submissionParamsSchema = z.object({
  submissionId: uuidSchema
}).strict();

const previewSubmissionSchema = z.object({
  inputType: z.enum(['TEXT', 'URL', 'PROVIDER_ID']),
  // The raw value is used to resolve candidates and is then discarded: only its
  // SHA-256 fingerprint plus confirmed structured fields are ever persisted.
  input: boundedText(2000),
  locale: localeSchema,
  regionCode: regionCodeSchema,
  platformHint: platformSchema.nullish()
}).strict();

const confirmedFieldsSchema = z.object({
  originalTitle: boundedText(300).optional(),
  developerName: boundedText(200).nullish(),
  publisherName: boundedText(200).nullish(),
  firstReleaseDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  genres: z.array(boundedText(60)).max(12).optional(),
  platforms: z.array(boundedText(40)).max(12).optional(),
  supportsSinglePlayer: z.boolean().nullish(),
  supportsMultiplayer: z.boolean().nullish(),
  typicalSessionMinutes: z.number().int().min(1).max(1440).nullish()
}).strict();

const confirmSubmissionSchema = z.object({
  // Either link one of the previewed candidates...
  selectedCatalogGameId: uuidSchema.nullish(),
  // ...or confirm (and optionally correct) the drafted fields.
  confirmedFields: confirmedFieldsSchema.nullish(),
  requestPublicReview: z.boolean().default(false)
}).strict().superRefine((value, ctx) => {
  if (value.selectedCatalogGameId && value.confirmedFields) {
    ctx.addIssue({
      code: 'custom',
      path: ['selectedCatalogGameId'],
      message: 'Provide either selectedCatalogGameId or confirmedFields, not both'
    });
  }

  if (value.selectedCatalogGameId && value.requestPublicReview) {
    ctx.addIssue({
      code: 'custom',
      path: ['requestPublicReview'],
      message: 'Linking an existing catalog game cannot request public review'
    });
  }
});

const correctionSchema = z.object({
  fieldPath: z.enum(CORRECTABLE_FIELD_PATHS),
  // A short structured claim, plus an optional official source URL. The server
  // never fetches the URL; it is stored as evidence for an editor to check.
  proposedValue: z.union([
    boundedText(300),
    z.number(),
    z.boolean(),
    z.array(boundedText(60)).max(12)
  ]),
  sourceUrl: z.string().trim().url().max(2000)
    .refine(isWellFormedUnicode, UNPAIRED_SURROGATE_MESSAGE)
    .refine((value) => value.startsWith('https://'), 'Only https source URLs are accepted')
    .nullish()
}).strict();

const submitCorrectionsSchema = z.object({
  corrections: z.array(correctionSchema).min(1).max(10)
}).strict();

const followGameSchema = z.object({
  regionalReleaseId: uuidSchema.nullish()
}).strict();

function buildCatalogValidationError(error) {
  const issueFields = new Set(error.issues.map((issue) => issue.path.join('.')));

  if (error.issues.some((issue) => issue.message === UNPAIRED_SURROGATE_MESSAGE)) {
    return new AppError(400, 'INVALID_UNICODE_TEXT',
      'Persisted text must not contain an unpaired UTF-16 surrogate',
      error.issues
        .filter((issue) => issue.message === UNPAIRED_SURROGATE_MESSAGE)
        .map((issue) => ({ field: issue.path.join('.'), message: 'unpaired_surrogate' })));
  }

  if (issueFields.has('input')) {
    return new AppError(400, 'INVALID_SUBMISSION_INPUT', 'Submission input is required and must be at most 2000 characters');
  }

  if (issueFields.has('inputType')) {
    return new AppError(400, 'INVALID_SUBMISSION_INPUT_TYPE', 'inputType must be TEXT, URL or PROVIDER_ID');
  }

  if (issueFields.has('catalogGameId') || issueFields.has('submissionId') || issueFields.has('selectedCatalogGameId')) {
    return new AppError(400, 'INVALID_IDENTIFIER', 'The supplied identifier must be a UUID');
  }

  if (issueFields.has('fieldPath')) {
    return new AppError(400, 'UNCORRECTABLE_FIELD', 'One or more field paths cannot be corrected');
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed',
    error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
}

module.exports = {
  buildCatalogValidationError,
  catalogGameParamsSchema,
  catalogSearchQuerySchema,
  confirmSubmissionSchema,
  followGameSchema,
  previewSubmissionSchema,
  submissionParamsSchema,
  submitCorrectionsSchema
};
