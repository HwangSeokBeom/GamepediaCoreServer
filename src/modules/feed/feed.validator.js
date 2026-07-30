const { z } = require('zod');
const { AppError } = require('../../utils/error-response');
const { PRODUCT_EVENT_CODES } = require('../product/product.constants');

const uuidSchema = z.string().trim().uuid();
const localeSchema = z.string().trim().regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/, 'Expected a BCP-47 style locale');
const timezoneSchema = z.string().trim().min(1).max(64).regex(
  /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/,
  'timezone must be an IANA identifier such as Asia/Seoul'
);
const slugSchema = z.string().trim().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase kebab-case');
const httpsUrlSchema = z.string().trim().url().max(2000)
  .refine((value) => value.startsWith('https://'), 'Only https URLs are accepted');
const sha256Schema = z.string().trim().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest');

const todayQuerySchema = z.object({
  locale: localeSchema.optional(),
  timezone: timezoneSchema.default('UTC'),
  limit: z.coerce.number().int().min(1).max(8).default(8),
  cursor: z.string().trim().max(400).optional()
}).strict();

const articleSlugParamsSchema = z.object({
  slug: slugSchema
}).strict();

/// Source rows are limited to a headline, a short excerpt, the URL, timestamps
/// and a hash. There is no field for the full original text.
const articleSourceInputSchema = z.object({
  sourceType: z.enum(['OFFICIAL_RSS', 'STEAM_NEWS', 'OFFICIAL_SITE', 'EDITOR_MANUAL']),
  publisherKey: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/),
  headline: z.string().trim().min(1).max(300),
  excerpt: z.string().trim().max(400).nullish(),
  sourceUrl: httpsUrlSchema,
  publishedAt: z.string().trim().datetime({ offset: true }).nullish(),
  fetchedAt: z.string().trim().datetime({ offset: true }),
  contentHash: sha256Schema
}).strict();

const articleAssetInputSchema = z.object({
  kind: z.enum(['COVER', 'HERO', 'SCREENSHOT', 'LOGO']),
  url: httpsUrlSchema,
  rightsStatus: z.enum(['UNKNOWN', 'PROVIDER_LICENSED', 'OFFICIAL_PRESS_KIT', 'USER_SUBMITTED', 'CLEARED', 'RESTRICTED']),
  attribution: z.string().trim().max(300).nullish(),
  isHero: z.boolean().default(false)
}).strict();

const articleGameLinkInputSchema = z.object({
  catalogGameId: uuidSchema,
  relation: z.enum(['SUBJECT', 'MENTIONED', 'RELATED'])
}).strict();

// The body is CommonMark with HTML disabled. Raw HTML and script are rejected
// here rather than sanitized later, so a stored body can never carry markup, an
// event handler, or a remote resource of its own. Images belong to the
// rights-reviewed article assets, not to inline HTML.
const HTML_LIKE_PATTERN = /<\s*\/?\s*[a-zA-Z][^>]*>|<!--|javascript:|data:text\/html|on[a-z]+\s*=/i;

const bodyMarkdownSchema = z.string().trim().max(40000)
  .refine((value) => !HTML_LIKE_PATTERN.test(value),
    'bodyMarkdown must be CommonMark without embedded HTML, script or data URLs');

const createArticleSchema = z.object({
  slug: slugSchema,
  locale: localeSchema,
  headline: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().min(1).max(600),
  bodyMarkdown: bodyMarkdownSchema.nullish(),
  aiDraftUsed: z.boolean().default(false),
  sources: z.array(articleSourceInputSchema).max(10).default([]),
  relatedGames: z.array(articleGameLinkInputSchema).max(20).default([]),
  assets: z.array(articleAssetInputSchema).max(10).default([])
}).strict();

const updateArticleSchema = z.object({
  locale: localeSchema.optional(),
  headline: z.string().trim().min(1).max(200).optional(),
  excerpt: z.string().trim().min(1).max(600).optional(),
  // Omitted means "unchanged": the service carries the previous body forward.
  // An explicit null clears it.
  bodyMarkdown: bodyMarkdownSchema.nullish(),
  changeNote: z.string().trim().min(1).max(300).nullish(),
  // PUBLISHED / RETRACTED are reached through the dedicated endpoints so the
  // database role re-check cannot be bypassed by a status patch.
  status: z.enum(['DRAFT', 'FACT_CHECK', 'RIGHTS_REVIEW', 'SCHEDULED', 'CORRECTED']).optional(),
  scheduledFor: z.string().trim().datetime({ offset: true }).nullish(),
  aiDraftUsed: z.boolean().default(false),
  sources: z.array(articleSourceInputSchema).max(10).default([]),
  relatedGames: z.array(articleGameLinkInputSchema).max(20).default([]),
  assets: z.array(articleAssetInputSchema).max(10).default([])
}).strict();

const listArticlesQuerySchema = z.object({
  status: z.enum(['DRAFT', 'FACT_CHECK', 'RIGHTS_REVIEW', 'SCHEDULED', 'PUBLISHED', 'CORRECTED', 'RETRACTED']).optional(),
  locale: localeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

const retractArticleSchema = z.object({
  reasonCode: z.enum(['factual_error', 'rights_issue', 'duplicate', 'source_retracted', 'editorial_decision'])
}).strict();

const productEventSchema = z.object({
  // Client-generated idempotency key: a retried batch cannot double count.
  eventId: z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/),
  eventCode: z.enum(PRODUCT_EVENT_CODES),
  occurredAt: z.string().trim().datetime({ offset: true }).transform((value) => new Date(value)),
  // Allowlist-filtered downstream; free text never survives.
  properties: z.record(z.string().max(60), z.unknown()).optional()
}).strict();

const productEventBatchSchema = z.object({
  events: z.array(productEventSchema).min(1).max(50)
}).strict();

function buildFeedValidationError(error) {
  const issueFields = new Set(error.issues.map((issue) => issue.path.join('.')));

  if (issueFields.has('slug')) {
    return new AppError(400, 'INVALID_ARTICLE_SLUG', 'slug must be lowercase kebab-case and at most 200 characters');
  }

  if (issueFields.has('timezone')) {
    return new AppError(400, 'INVALID_TIMEZONE', 'timezone must be an IANA identifier such as Asia/Seoul');
  }

  if ([...issueFields].some((field) => field.endsWith('eventCode'))) {
    return new AppError(400, 'UNKNOWN_PRODUCT_EVENT_CODE', 'Product event code is not allowlisted');
  }

  if ([...issueFields].some((field) => field.endsWith('eventId'))) {
    return new AppError(400, 'INVALID_PRODUCT_EVENT_ID', 'eventId must be an opaque token of 8 to 120 characters');
  }

  if (issueFields.has('bodyMarkdown')) {
    return new AppError(400, 'INVALID_ARTICLE_BODY',
      'bodyMarkdown must be CommonMark without embedded HTML, script or data URLs');
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed',
    error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
}

module.exports = {
  articleSlugParamsSchema,
  buildFeedValidationError,
  createArticleSchema,
  listArticlesQuerySchema,
  productEventBatchSchema,
  retractArticleSchema,
  todayQuerySchema,
  updateArticleSchema
};
