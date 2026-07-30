const { z } = require('zod');
const {
  CATALOG_IDENTITY_PROVIDERS,
  CATALOG_PROVENANCE_VALUES,
  CATALOG_SERVICE_STATUSES
} = require('./catalog.constants');
const {
  countCodePoints,
  isWellFormedUnicode,
  UNPAIRED_SURROGATE_MESSAGE
} = require('../../utils/unicode-text');

// Bounds every stored text field by Unicode code points rather than UTF-16 units,
// so API validation and the varchar(n) column mean the same thing. `.max(300)`
// alone would accept 300 UTF-16 units, which can be 300 astral characters that a
// varchar(300) column rejects — or reject 300 astral characters it would accept.
function boundedText(maxCodePoints, { min = 1 } = {}) {
  return z.string().trim().min(min)
    .refine((value) => countCodePoints(value) <= maxCodePoints,
      `must be at most ${maxCodePoints} Unicode code points`)
    .refine(isWellFormedUnicode, UNPAIRED_SURROGATE_MESSAGE);
}

// Every AI response is parsed through these schemas before anything is stored.
// The model can only ever fill *these* fields, with these types and bounds, so a
// malformed or adversarial completion becomes a validation failure rather than a
// catalog write.

const shortText = boundedText(200);
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO YYYY-MM-DD date');

const regionalReleaseDraftSchema = z.object({
  countryCode: z.string().trim().regex(/^[A-Z]{2}$/, 'Expected a two-letter uppercase country code'),
  languageCode: boundedText(16, { min: 2 }),
  platform: boundedText(40),
  operatorName: shortText.nullish(),
  serverRegion: boundedText(60, { min: 0 }).nullish(),
  releaseDate: isoDate.nullish(),
  shutdownDate: isoDate.nullish(),
  serviceStatus: z.enum(CATALOG_SERVICE_STATUSES)
}).strict();

const localizationDraftSchema = z.object({
  kind: z.enum(['ORIGINAL_TITLE', 'REGIONAL_TITLE', 'ALIAS']),
  languageCode: boundedText(16, { min: 2 }),
  regionCode: z.string().trim().regex(/^[A-Z]{2}$/).nullish(),
  title: boundedText(300)
}).strict();

const identityDraftSchema = z.object({
  provider: z.enum(CATALOG_IDENTITY_PROVIDERS),
  externalId: boundedText(200),
  regionKey: boundedText(16).default('GLOBAL')
}).strict();

/// Per-field provenance and confidence. An AI-produced field is pinned to
/// AI_INFERRED at the extractor boundary regardless of what the model claims.
const fieldProvenanceSchema = z.object({
  fieldPath: boundedText(120),
  provenance: z.enum(CATALOG_PROVENANCE_VALUES),
  confidence: z.number().min(0).max(1)
}).strict();

const gameDraftSchema = z.object({
  /// Null until a title exists as a *structured* field — either extracted by the
  /// model or supplied by the user at confirmation time. The raw natural-language
  /// input is never stored here as a fallback.
  originalTitle: boundedText(300).nullable(),
  requiresTitleConfirmation: z.boolean().default(false),
  developerName: shortText.nullish(),
  publisherName: shortText.nullish(),
  firstReleaseDate: isoDate.nullish(),
  genres: z.array(boundedText(60)).max(12).default([]),
  platforms: z.array(boundedText(40)).max(12).default([]),
  supportsSinglePlayer: z.boolean().nullish(),
  supportsMultiplayer: z.boolean().nullish(),
  typicalSessionMinutes: z.number().int().min(1).max(1440).nullish(),
  localizations: z.array(localizationDraftSchema).max(12).default([]),
  regionalReleases: z.array(regionalReleaseDraftSchema).max(8).default([]),
  identities: z.array(identityDraftSchema).max(8).default([]),
  fieldProvenance: z.array(fieldProvenanceSchema).max(64).default([])
}).strict();

/// Exact contract for the LLM completion. `strict()` rejects extra keys, so a
/// model that decides to add prose alongside the JSON fails validation.
const aiExtractionResponseSchema = z.object({
  originalTitle: boundedText(300),
  developerName: shortText.nullish(),
  publisherName: shortText.nullish(),
  firstReleaseDate: isoDate.nullish(),
  genres: z.array(boundedText(60)).max(12).default([]),
  platforms: z.array(boundedText(40)).max(12).default([]),
  supportsSinglePlayer: z.boolean().nullish(),
  supportsMultiplayer: z.boolean().nullish(),
  localizations: z.array(localizationDraftSchema).max(12).default([]),
  regionalReleases: z.array(regionalReleaseDraftSchema).max(8).default([]),
  // At most one clarifying question may be returned to the client.
  clarifyingQuestion: boundedText(300).nullish(),
  fieldConfidence: z.array(z.object({
    fieldPath: boundedText(120),
    confidence: z.number().min(0).max(1)
  }).strict()).max(64).default([])
}).strict();

/// Shape persisted in game_submissions.draft. Re-validated on read so a row
/// written by an older revision can never be applied blindly.
///
/// `parsedIdentityClaim` is the result of parsing the *syntax* of a store URL or
/// package id. Parsing a string is not verification of anything, so the field is
/// named as a claim and is only ever written to game_identity_claims.
const persistedDraftSchema = z.object({
  version: z.literal(2),
  game: gameDraftSchema,
  parsedIdentityClaim: identityDraftSchema.nullish(),
  aiUsed: z.boolean(),
  aiFallbackUsed: z.boolean(),
  degradedToManual: z.boolean()
}).strict();

module.exports = {
  aiExtractionResponseSchema,
  boundedText,
  gameDraftSchema,
  identityDraftSchema,
  localizationDraftSchema,
  persistedDraftSchema,
  regionalReleaseDraftSchema
};
