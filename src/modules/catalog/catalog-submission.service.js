const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const { compactTitle, fingerprintInput, normalizeTitle, titleSimilarity } = require('./catalog-title.util');
const { parseProviderIdentity } = require('./catalog-input.parser');
const catalogAiExtractor = require('./catalog-ai.extractor');
const catalogIdentityService = require('./catalog-identity.service');
const { mapCatalogGameSummary } = require('./catalog.mapper');
const { persistedDraftSchema } = require('./catalog-submission.schema');
const {
  CATALOG_PREVIEW_MAX_CANDIDATES,
  FUZZY_MATCH_MIN_SIMILARITY,
  GLOBAL_REGION_KEY,
  MATCH_STAGE_CONFIDENCE
} = require('./catalog.constants');

// Quick add pipeline. Deterministic stages run first and short-circuit; the LLM
// is only reached when structure and the existing catalog cannot answer.
//
//   1. deterministic URL / app id / package id parsing
//   2. provider identity exact match
//   3. locale alias / normalized title exact match
//   4. fuzzy title + developer + platform + region ranking
//   5. LLM structured extraction (only if still unresolved)
//   6. Zod validation
//   7. write on explicit user confirmation
//
// Invariants enforced here:
//   * AI output is never a source: extracted fields are pinned to AI_INFERRED.
//   * Nothing is published or merged automatically.
//   * Raw natural language is never persisted; only its SHA-256 fingerprint and
//     the structured fields the user confirmed.
//   * Personal registration is immediate (PRIVATE); public visibility is
//     PENDING_REVIEW and the submitter's own confirmation never approves it.

const FUZZY_SCAN_LIMIT = 120;

const CANDIDATE_SELECT = {
  id: true,
  originalTitle: true,
  normalizedTitle: true,
  slug: true,
  developerName: true,
  publisherName: true,
  firstReleaseDate: true,
  genres: true,
  platforms: true,
  publicationStatus: true,
  titleProvenance: true,
  identities: {
    select: { provider: true, externalId: true, regionKey: true, provenance: true, confidence: true },
    orderBy: [{ provider: 'asc' }, { externalId: 'asc' }]
  }
};

function visibleToUser(userId) {
  return {
    mergedIntoCatalogGameId: null,
    OR: [{ publicationStatus: 'PUBLISHED' }, { createdByUserId: userId }]
  };
}

function buildCandidate({ game, reasonCodes, confidence }) {
  return {
    ...mapCatalogGameSummary(game),
    matchReasonCodes: [...new Set(reasonCodes)].sort(),
    matchConfidence: Number(confidence.toFixed(4))
  };
}

/// Deterministic ordering so two identical previews return identical candidates.
function rankCandidates(candidates) {
  return [...candidates]
    .sort((left, right) => {
      if (right.matchConfidence !== left.matchConfidence) {
        return right.matchConfidence - left.matchConfidence;
      }

      if (left.originalTitle !== right.originalTitle) {
        return left.originalTitle < right.originalTitle ? -1 : 1;
      }

      return left.catalogGameId < right.catalogGameId ? -1 : 1;
    })
    .slice(0, CATALOG_PREVIEW_MAX_CANDIDATES);
}

/// Looks up an existing canonical game for a parsed provider key.
///
/// A verified identity is a strong signal and earns full confidence. An
/// unverified row (a legacy backfill) is surfaced as a weaker candidate with its
/// own reason code, because parsing a URL proves nothing about the key.
async function findByProviderIdentity({ userId, claim }) {
  if (!claim) {
    return [];
  }

  const resolved = await catalogIdentityService.findCanonicalGameByIdentity(
    { provider: claim.provider, externalId: claim.externalId, regionKey: claim.regionKey },
    { requireVerified: false }
  );

  if (!resolved) {
    return [];
  }

  const game = await prisma.catalogGame.findFirst({
    where: { id: resolved.catalogGameId, ...visibleToUser(userId) },
    select: CANDIDATE_SELECT
  });

  if (!game) {
    return [];
  }

  const reasonCode = resolved.verified ? 'provider_identity_exact' : 'provider_identity_unverified';

  return [buildCandidate({
    game,
    reasonCodes: [reasonCode],
    confidence: MATCH_STAGE_CONFIDENCE[reasonCode]
  })];
}

async function findByExactTitle({ userId, input, locale, regionCode }) {
  const normalized = normalizeTitle(input);

  if (normalized.length === 0) {
    return [];
  }

  const [localizationHits, titleHits] = await Promise.all([
    prisma.gameLocalization.findMany({
      where: {
        normalizedTitle: normalized,
        catalogGame: visibleToUser(userId)
      },
      select: {
        languageCode: true,
        regionCode: true,
        catalogGame: { select: CANDIDATE_SELECT }
      },
      take: FUZZY_SCAN_LIMIT
    }),
    prisma.catalogGame.findMany({
      where: { normalizedTitle: normalized, ...visibleToUser(userId) },
      select: CANDIDATE_SELECT,
      take: FUZZY_SCAN_LIMIT
    })
  ]);

  const byId = new Map();

  for (const hit of localizationHits) {
    const localeMatch = hit.languageCode === locale || hit.languageCode === 'und';
    const regionMatch = hit.regionCode === 'GLOBAL' || hit.regionCode === regionCode;
    const reasonCodes = ['locale_alias_exact'];

    if (localeMatch) {
      reasonCodes.push('normalized_title_exact');
    }

    if (regionMatch && hit.regionCode !== 'GLOBAL') {
      reasonCodes.push('region_match');
    }

    byId.set(hit.catalogGame.id, buildCandidate({
      game: hit.catalogGame,
      reasonCodes,
      confidence: MATCH_STAGE_CONFIDENCE.locale_alias_exact
    }));
  }

  for (const game of titleHits) {
    if (!byId.has(game.id)) {
      byId.set(game.id, buildCandidate({
        game,
        reasonCodes: ['normalized_title_exact'],
        confidence: MATCH_STAGE_CONFIDENCE.normalized_title_exact
      }));
    }
  }

  return [...byId.values()];
}

async function findByFuzzyTitle({ userId, input, regionCode, platformHint }) {
  const normalized = normalizeTitle(input);
  const compact = compactTitle(input);

  if (normalized.length === 0) {
    return [];
  }

  const firstToken = normalized.split(' ')[0];
  const pool = await prisma.catalogGame.findMany({
    where: {
      ...visibleToUser(userId),
      OR: [
        { normalizedTitle: { contains: firstToken } },
        { normalizedTitle: { startsWith: normalized.slice(0, 6) } }
      ]
    },
    select: CANDIDATE_SELECT,
    take: FUZZY_SCAN_LIMIT
  });

  const candidates = [];

  for (const game of pool) {
    const similarity = titleSimilarity(normalized, game.normalizedTitle);
    const compactExact = compactTitle(game.originalTitle) === compact && compact.length > 0;

    if (!compactExact && similarity < FUZZY_MATCH_MIN_SIMILARITY) {
      continue;
    }

    const reasonCodes = compactExact ? ['compact_title_exact'] : ['fuzzy_title_similar'];
    let confidence = compactExact
      ? MATCH_STAGE_CONFIDENCE.compact_title_exact
      : MATCH_STAGE_CONFIDENCE.fuzzy_title_similar * similarity;

    if (platformHint && (game.platforms ?? []).includes(platformHint)) {
      reasonCodes.push('platform_match');
      confidence += 0.05;
    }

    if (regionCode && (game.identities ?? []).some((identity) => identity.regionKey === regionCode)) {
      reasonCodes.push('region_match');
      confidence += 0.03;
    }

    candidates.push(buildCandidate({ game, reasonCodes, confidence: Math.min(confidence, 0.79) }));
  }

  return candidates;
}

/// Shares the existing per-user, per-day AI budget. Increment-then-check inside a
/// transaction so two concurrent previews cannot both slip past the limit.
async function assertAndIncrementQuickAddUsage({ userId, now = new Date() }) {
  const usageDateText = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  const usageDate = new Date(`${usageDateText}T00:00:00.000Z`);

  await prisma.$transaction(async (tx) => {
    const usage = await tx.aiUsageLimit.upsert({
      where: { userId_usageDate: { userId, usageDate } },
      create: { userId, usageDate, quickAddCount: 1 },
      update: { quickAddCount: { increment: 1 } },
      select: { quickAddCount: true }
    });

    if (usage.quickAddCount > env.aiQuickAddDailyLimit) {
      throw new AppError(429, 'AI_DAILY_LIMIT_EXCEEDED', 'Daily AI quick add limit exceeded');
    }
  });
}

/// Builds the draft the user will confirm. AI-derived values are always
/// AI_INFERRED; deterministic parsing keeps PROVIDER_VERIFIED.
///
/// The raw `input` is deliberately NOT used as a fallback title. Persisting it
/// would put the user's unconfirmed natural-language text in the database, so a
/// draft with no extracted title is stored with `originalTitle: null` and
/// `requiresTitleConfirmation: true`, and confirmation must supply the title.
function buildDraft({ parsedIdentityClaim, extraction }) {
  const extracted = extraction?.extracted ?? null;
  const confidenceByPath = new Map((extraction?.fieldConfidence ?? [])
    .map((entry) => [entry.fieldPath, entry.confidence]));
  const originalTitle = extracted?.originalTitle ?? null;
  const fieldProvenance = [];

  function record(fieldPath, fromAi) {
    fieldProvenance.push({
      fieldPath,
      // A field the model produced can never be anything but AI_INFERRED here.
      provenance: fromAi ? 'AI_INFERRED' : 'USER_CONFIRMED',
      confidence: fromAi ? (confidenceByPath.get(fieldPath) ?? 0.4) : 0.5
    });
  }

  if (originalTitle) {
    record('originalTitle', true);
  }

  for (const fieldPath of ['developerName', 'publisherName', 'firstReleaseDate', 'supportsSinglePlayer', 'supportsMultiplayer']) {
    if (extracted && extracted[fieldPath] !== null && extracted[fieldPath] !== undefined) {
      record(fieldPath, true);
    }
  }

  if ((extracted?.genres ?? []).length > 0) {
    record('genres', true);
  }

  if ((extracted?.platforms ?? []).length > 0) {
    record('platforms', true);
  }

  for (const [index] of (extracted?.regionalReleases ?? []).entries()) {
    record(`regionalReleases.${index}`, true);
  }

  const identities = parsedIdentityClaim
    ? [{
      provider: parsedIdentityClaim.provider,
      externalId: parsedIdentityClaim.externalId,
      regionKey: parsedIdentityClaim.regionKey
    }]
    : [];

  if (parsedIdentityClaim) {
    // The user supplied this key and the server only parsed its syntax. That is a
    // user claim, not a provider fact, so it can never be PROVIDER_VERIFIED and
    // can never carry confidence 1.
    fieldProvenance.push({
      fieldPath: `identities.${parsedIdentityClaim.provider}`,
      provenance: 'USER_CONFIRMED',
      confidence: 0.5
    });
  }

  return persistedDraftSchema.parse({
    version: 2,
    game: {
      originalTitle,
      requiresTitleConfirmation: originalTitle === null,
      developerName: extracted?.developerName ?? null,
      publisherName: extracted?.publisherName ?? null,
      firstReleaseDate: extracted?.firstReleaseDate ?? null,
      genres: extracted?.genres ?? [],
      platforms: extracted?.platforms ?? [],
      supportsSinglePlayer: extracted?.supportsSinglePlayer ?? null,
      supportsMultiplayer: extracted?.supportsMultiplayer ?? null,
      typicalSessionMinutes: null,
      localizations: extracted?.localizations ?? [],
      regionalReleases: extracted?.regionalReleases ?? [],
      identities,
      fieldProvenance
    },
    parsedIdentityClaim: parsedIdentityClaim
      ? {
        provider: parsedIdentityClaim.provider,
        externalId: parsedIdentityClaim.externalId,
        regionKey: parsedIdentityClaim.regionKey
      }
      : null,
    aiUsed: Boolean(extraction?.aiUsed),
    aiFallbackUsed: Boolean(extraction?.aiFallbackUsed),
    degradedToManual: Boolean(extraction?.aiFallbackUsed)
  });
}

async function previewSubmission({ userId, inputType, input, locale, regionCode, platformHint = null, now = new Date() }) {
  // Syntax parsing only. This is a claim about a provider key, never a verified
  // identity, and it is never written to the globally unique identity table.
  const parsedIdentityClaim = parseProviderIdentity({ inputType, input, platformHint });

  const identityCandidates = await findByProviderIdentity({ userId, claim: parsedIdentityClaim });
  const exactCandidates = identityCandidates.length > 0
    ? []
    : await findByExactTitle({ userId, input, locale, regionCode });
  const fuzzyCandidates = identityCandidates.length > 0 || exactCandidates.length > 0
    ? []
    : await findByFuzzyTitle({ userId, input, regionCode, platformHint });

  const candidates = rankCandidates([...identityCandidates, ...exactCandidates, ...fuzzyCandidates]);
  const resolvedDeterministically = identityCandidates.length > 0
    || exactCandidates.length > 0
    || (parsedIdentityClaim !== null && inputType !== 'TEXT');

  let extraction = null;

  // Stage 5: the model is only consulted when structure and the catalog could not
  // answer, which keeps the AI budget for the cases that actually need it.
  if (!resolvedDeterministically) {
    await assertAndIncrementQuickAddUsage({ userId, now });
    extraction = await catalogAiExtractor.extractGameDraft({ input, locale, regionCode, platformHint });
  }

  const draft = buildDraft({ parsedIdentityClaim, extraction });
  const expiresAt = new Date(now.getTime() + env.catalogSubmissionPreviewTtlMinutes * 60_000);

  const submission = await prisma.gameSubmission.create({
    data: {
      userId,
      status: 'PREVIEW',
      inputType,
      // Only the fingerprint of what the user typed is stored, never the text.
      inputFingerprint: fingerprintInput(input),
      locale,
      regionCode,
      platformHint,
      draft,
      candidateSummary: {
        version: 1,
        candidateCount: candidates.length,
        catalogGameIds: candidates.map((candidate) => candidate.catalogGameId),
        reasonCodes: [...new Set(candidates.flatMap((candidate) => candidate.matchReasonCodes))].sort()
      },
      clarifyingQuestion: extraction?.clarifyingQuestion ?? null,
      aiModel: extraction?.model ?? null,
      aiFallbackUsed: Boolean(extraction?.aiFallbackUsed),
      publicReviewStatus: 'PRIVATE',
      expiresAt
    },
    select: { id: true, createdAt: true }
  });

  if (extraction?.extracted) {
    await prisma.gameFieldEvidence.createMany({
      data: draft.game.fieldProvenance
        .filter((entry) => entry.provenance === 'AI_INFERRED')
        .map((entry) => ({
          submissionId: submission.id,
          fieldPath: entry.fieldPath,
          provenance: 'AI_INFERRED',
          confidence: entry.confidence,
          sourceType: 'ai_extraction',
          sourceUrl: null,
          sourceInputHash: fingerprintInput(input),
          observedAt: now
        }))
    });
  }

  logger.info('catalog-quick-add-preview', {
    submissionInputType: inputType,
    candidateCount: candidates.length,
    parsedIdentityClaimFound: Boolean(parsedIdentityClaim),
    aiUsed: Boolean(extraction?.aiUsed),
    aiFallbackUsed: Boolean(extraction?.aiFallbackUsed),
    degradeReason: extraction?.degradeReason ?? null,
    hasClarifyingQuestion: Boolean(extraction?.clarifyingQuestion)
  });

  return {
    submissionId: submission.id,
    createdAt: submission.createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    existingCandidates: candidates,
    newGameDraft: {
      originalTitle: draft.game.originalTitle,
      // When no structured title could be derived, the client must collect one at
      // confirmation time; the server does not keep the raw input to fall back on.
      requiresTitleConfirmation: draft.game.requiresTitleConfirmation,
      developerName: draft.game.developerName,
      publisherName: draft.game.publisherName,
      firstReleaseDate: draft.game.firstReleaseDate,
      genres: draft.game.genres,
      platforms: draft.game.platforms,
      supportsSinglePlayer: draft.game.supportsSinglePlayer,
      supportsMultiplayer: draft.game.supportsMultiplayer,
      localizations: draft.game.localizations,
      regionalReleases: draft.game.regionalReleases,
      identities: draft.game.identities
    },
    fieldProvenance: draft.game.fieldProvenance,
    clarifyingQuestions: extraction?.clarifyingQuestion ? [extraction.clarifyingQuestion] : [],
    resolution: {
      stage: identityCandidates.length > 0
        ? 'provider_identity_exact'
        : exactCandidates.length > 0
          ? 'title_exact'
          : fuzzyCandidates.length > 0
            ? 'fuzzy_title'
            : extraction?.extracted
              ? 'ai_extraction'
              : 'manual_draft',
      aiUsed: Boolean(extraction?.aiUsed),
      aiFallbackUsed: Boolean(extraction?.aiFallbackUsed),
      degradeReason: extraction?.degradeReason ?? null
    },
    // Personal registration is always available; public listing never is.
    personalRegistrationAvailable: true,
    publicReviewStatus: 'PENDING_REVIEW'
  };
}

async function getSubmission({ userId, submissionId }) {
  const submission = await prisma.gameSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      userId: true,
      status: true,
      inputType: true,
      locale: true,
      regionCode: true,
      platformHint: true,
      draft: true,
      candidateSummary: true,
      clarifyingQuestion: true,
      aiFallbackUsed: true,
      personalCatalogGameId: true,
      publicReviewStatus: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true
    }
  });

  // Ownership check before anything is returned: another account's submission is
  // reported as missing rather than as forbidden.
  if (!submission || submission.userId !== userId) {
    throw new AppError(404, 'SUBMISSION_NOT_FOUND', 'Game submission could not be found');
  }

  const parsedDraft = persistedDraftSchema.safeParse(submission.draft);

  return {
    submissionId: submission.id,
    status: submission.status,
    inputType: submission.inputType,
    locale: submission.locale,
    regionCode: submission.regionCode,
    platformHint: submission.platformHint,
    newGameDraft: parsedDraft.success ? parsedDraft.data.game : null,
    draftReadable: parsedDraft.success,
    candidateSummary: submission.candidateSummary ?? null,
    clarifyingQuestions: submission.clarifyingQuestion ? [submission.clarifyingQuestion] : [],
    aiFallbackUsed: submission.aiFallbackUsed,
    catalogGameId: submission.personalCatalogGameId,
    publicReviewStatus: submission.publicReviewStatus,
    expiresAt: submission.expiresAt.toISOString(),
    expired: submission.expiresAt.getTime() <= Date.now(),
    createdAt: submission.createdAt.toISOString(),
    updatedAt: submission.updatedAt.toISOString()
  };
}

/// Applies the user's confirmation. Either links an existing candidate or creates
/// a PRIVATE canonical game owned by the submitter. `requestPublicReview` moves
/// the submission to PENDING_REVIEW and never to PUBLISHED.
/// Reads the committed outcome of a submission whose PREVIEW claim this request
/// lost. Safe to call after the winning transaction committed, because the losing
/// conditional update blocked on that row until it did.
async function readConfirmedOutcome({ userId, submissionId }) {
  const submission = await prisma.gameSubmission.findFirst({
    where: { id: submissionId, userId },
    select: { id: true, status: true, personalCatalogGameId: true, publicReviewStatus: true }
  });

  if (!submission) {
    throw new AppError(404, 'SUBMISSION_NOT_FOUND', 'Game submission could not be found');
  }

  return {
    submissionId: submission.id,
    status: submission.status,
    catalogGameId: submission.personalCatalogGameId,
    createdNewGame: false,
    idempotentReplay: true,
    publicReviewStatus: submission.publicReviewStatus,
    identityConflict: null
  };
}

/// Applies the user's confirmation.
///
/// Concurrency: the PREVIEW -> confirmed transition is claimed with a conditional
/// UPDATE ... WHERE status = 'PREVIEW' *inside* the same transaction that creates
/// the game, so exactly one concurrent request can win. A loser's conditional
/// update blocks on the row lock until the winner commits, then matches zero rows
/// and returns the winner's committed result as an idempotent replay. Nothing here
/// relies on a process-local lock, and no partial game can survive a rollback
/// because every write shares the transaction.
///
/// Trust: a new game is always PRIVATE and owned by the submitter. The parsed
/// provider key is recorded as an identity *claim*, never as a globally unique
/// verified identity, so a submission cannot squat a provider key and capture
/// another account's future real provider sync.
async function confirmSubmission({
  userId,
  submissionId,
  selectedCatalogGameId = null,
  confirmedFields = null,
  requestPublicReview = false,
  now = new Date()
}) {
  const nextStatus = requestPublicReview ? 'PENDING_REVIEW' : 'PERSONAL_CONFIRMED';
  const nextPublicReviewStatus = requestPublicReview ? 'PENDING_REVIEW' : 'PRIVATE';

  const outcome = await prisma.$transaction(async (tx) => {
    const submission = await tx.gameSubmission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        userId: true,
        status: true,
        draft: true,
        expiresAt: true,
        personalCatalogGameId: true,
        locale: true,
        regionCode: true
      }
    });

    if (!submission || submission.userId !== userId) {
      throw new AppError(404, 'SUBMISSION_NOT_FOUND', 'Game submission could not be found');
    }

    // Confirming an already-confirmed submission returns the first result.
    if (submission.status !== 'PREVIEW') {
      return { lostClaim: true };
    }

    if (submission.expiresAt.getTime() <= now.getTime()) {
      await tx.gameSubmission.updateMany({
        where: { id: submission.id, status: 'PREVIEW' },
        data: { status: 'EXPIRED' }
      });

      throw new AppError(409, 'SUBMISSION_EXPIRED', 'This preview expired; request a new preview before confirming');
    }

    const parsedDraft = persistedDraftSchema.safeParse(submission.draft);

    if (!parsedDraft.success) {
      throw new AppError(422, 'SUBMISSION_DRAFT_INVALID', 'The stored draft is no longer valid; request a new preview');
    }

    const draft = parsedDraft.data;

    if (selectedCatalogGameId) {
      const canonicalId = await catalogIdentityService.resolveCanonicalGameId(selectedCatalogGameId, { client: tx });

      if (!canonicalId) {
        throw new AppError(400, 'CATALOG_GAME_NOT_FOUND', 'The selected catalog game could not be found');
      }

      const visible = await tx.catalogGame.findFirst({
        where: { id: canonicalId, ...visibleToUser(userId) },
        select: { id: true }
      });

      if (!visible) {
        throw new AppError(400, 'CATALOG_GAME_NOT_FOUND', 'The selected catalog game could not be found');
      }

      // Conditional claim: only the request that flips PREVIEW proceeds.
      const claimed = await tx.gameSubmission.updateMany({
        where: { id: submission.id, status: 'PREVIEW' },
        data: {
          status: 'PERSONAL_CONFIRMED',
          personalCatalogGameId: canonicalId,
          publicReviewStatus: 'PRIVATE',
          reviewedByUserId: null,
          reviewedAt: null
        }
      });

      if (claimed.count === 0) {
        return { lostClaim: true };
      }

      return {
        lostClaim: false,
        submissionId: submission.id,
        status: 'PERSONAL_CONFIRMED',
        catalogGameId: canonicalId,
        createdNewGame: false,
        idempotentReplay: false,
        publicReviewStatus: 'PRIVATE',
        identityConflict: null
      };
    }

    const game = confirmedFields ? { ...draft.game, ...confirmedFields } : draft.game;
    const titleFromUser = Boolean(confirmedFields?.originalTitle);

    // A draft with no structured title cannot be completed from stored state,
    // because the raw input was never persisted. The user must supply the title.
    if (!game.originalTitle) {
      throw new AppError(400, 'SUBMISSION_TITLE_REQUIRED',
        'confirmedFields.originalTitle is required because no structured title could be derived', [{
          field: 'confirmedFields.originalTitle',
          message: 'required'
        }]);
    }

    // Claim before creating anything, so a loser never reaches a create at all
    // and no orphan catalog game can be produced.
    const claimed = await tx.gameSubmission.updateMany({
      where: { id: submission.id, status: 'PREVIEW' },
      data: { status: nextStatus, publicReviewStatus: nextPublicReviewStatus, reviewedByUserId: null, reviewedAt: null }
    });

    if (claimed.count === 0) {
      return { lostClaim: true };
    }

    const createdGame = await tx.catalogGame.create({
      data: {
        originalTitle: game.originalTitle,
        normalizedTitle: normalizeTitle(game.originalTitle),
        developerName: game.developerName ?? null,
        publisherName: game.publisherName ?? null,
        firstReleaseDate: game.firstReleaseDate ? new Date(`${game.firstReleaseDate}T00:00:00.000Z`) : null,
        genres: game.genres ?? [],
        steamTags: [],
        platforms: game.platforms ?? [],
        supportsSinglePlayer: game.supportsSinglePlayer ?? null,
        supportsMultiplayer: game.supportsMultiplayer ?? null,
        typicalSessionMinutes: game.typicalSessionMinutes ?? null,
        // Immediately usable by the submitter, invisible to everyone else. A
        // submission can never produce a PUBLISHED game: the information behind it
        // is USER_CONFIRMED or AI_INFERRED at best.
        publicationStatus: 'PRIVATE',
        titleProvenance: titleFromUser ? 'USER_CONFIRMED' : 'AI_INFERRED',
        createdByUserId: userId
      },
      select: { id: true }
    });

    for (const localization of game.localizations ?? []) {
      await tx.gameLocalization.create({
        data: {
          catalogGameId: createdGame.id,
          kind: localization.kind,
          languageCode: localization.languageCode,
          // The AI contract allows a null regionCode; storage normalizes it to
          // the GLOBAL sentinel so the unique key always applies.
          regionCode: localization.regionCode ?? 'GLOBAL',
          title: localization.title,
          normalizedTitle: normalizeTitle(localization.title),
          provenance: 'AI_INFERRED'
        },
        select: { id: true }
      });
    }

    for (const release of game.regionalReleases ?? []) {
      await tx.regionalRelease.create({
        data: {
          catalogGameId: createdGame.id,
          countryCode: release.countryCode,
          languageCode: release.languageCode,
          platform: release.platform,
          operatorName: release.operatorName ?? null,
          serverRegion: release.serverRegion ?? null,
          releaseDate: release.releaseDate ? new Date(`${release.releaseDate}T00:00:00.000Z`) : null,
          shutdownDate: release.shutdownDate ? new Date(`${release.shutdownDate}T00:00:00.000Z`) : null,
          serviceStatus: release.serviceStatus,
          provenance: 'AI_INFERRED'
        },
        select: { id: true }
      });
    }

    let identityConflict = null;
    let identityClaimRecorded = false;

    if (draft.parsedIdentityClaim) {
      const claim = draft.parsedIdentityClaim;

      // Syntax parsing is not verification, so this is recorded as a claim in
      // game_identity_claims. It does not occupy the globally unique provider key,
      // which means it cannot capture another account's future real provider sync.
      await catalogIdentityService.recordIdentityClaim({
        client: tx,
        catalogGameId: createdGame.id,
        submissionId: submission.id,
        claimedByUserId: userId,
        provider: claim.provider,
        externalId: claim.externalId,
        regionKey: claim.regionKey ?? GLOBAL_REGION_KEY,
        provenance: 'USER_CONFIRMED',
        claimSource: 'quick_add_syntax_parse'
      });
      identityClaimRecorded = true;

      // Report, for the client's benefit, that a verified identity already exists
      // elsewhere. Nothing is repointed or merged.
      const verified = await catalogIdentityService.findCanonicalGameByIdentity(
        {
          provider: claim.provider,
          externalId: claim.externalId,
          regionKey: claim.regionKey ?? GLOBAL_REGION_KEY
        },
        { client: tx, requireVerified: true }
      );

      if (verified && verified.catalogGameId !== createdGame.id) {
        identityConflict = {
          provider: claim.provider,
          existingCatalogGameId: verified.catalogGameId,
          reasonCode: 'verified_identity_already_exists'
        };
      }
    }

    await tx.gameFieldEvidence.createMany({
      data: (game.fieldProvenance ?? []).map((entry) => ({
        catalogGameId: createdGame.id,
        submissionId: submission.id,
        fieldPath: entry.fieldPath,
        provenance: entry.provenance,
        confidence: entry.confidence,
        sourceType: entry.provenance === 'AI_INFERRED' ? 'ai_extraction' : 'user_confirmation',
        observedAt: now
      }))
    });

    await tx.gameSubmission.update({
      where: { id: submission.id },
      data: { personalCatalogGameId: createdGame.id },
      select: { id: true }
    });

    return {
      lostClaim: false,
      submissionId: submission.id,
      status: nextStatus,
      catalogGameId: createdGame.id,
      createdNewGame: true,
      idempotentReplay: false,
      publicReviewStatus: nextPublicReviewStatus,
      identityConflict,
      identityClaimRecorded
    };
  });

  if (outcome.lostClaim) {
    const replay = await readConfirmedOutcome({ userId, submissionId });

    logger.info('catalog-quick-add-confirm', {
      createdNewGame: false,
      linkedExistingCandidate: false,
      publicReviewRequested: requestPublicReview,
      idempotentReplay: true,
      claimLost: true
    });

    return replay;
  }

  logger.info('catalog-quick-add-confirm', {
    createdNewGame: outcome.createdNewGame,
    linkedExistingCandidate: !outcome.createdNewGame,
    publicReviewRequested: requestPublicReview,
    identityConflictDetected: Boolean(outcome.identityConflict),
    identityClaimRecorded: Boolean(outcome.identityClaimRecorded),
    idempotentReplay: false,
    claimLost: false
  });

  const { lostClaim: _lostClaim, identityClaimRecorded: _claimRecorded, ...response } = outcome;

  return response;
}

module.exports = {
  assertAndIncrementQuickAddUsage,
  buildDraft,
  confirmSubmission,
  getSubmission,
  previewSubmission,
  rankCandidates
};
