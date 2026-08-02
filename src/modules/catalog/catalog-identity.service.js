const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const { isWellFormedUnicode } = require('../../utils/unicode-text');
const { clampTitle, normalizeTitle } = require('./catalog-title.util');
const {
  GLOBAL_REGION_KEY,
  IDENTITY_VERIFICATION_SOURCES,
  LEGACY_SOURCE_TO_PROVIDER,
  isVerifiedProvenance
} = require('./catalog.constants');

// Canonical identity resolution and the trust boundary around it.
//
// `game_external_identities` is the *global* identity table: one provider key
// resolves to exactly one canonical game, enforced by a unique index. A row in it
// may be verified (`verifiedAt` set, by a real provider response or an editor) or
// unverified (a legacy backfill row whose origin cannot be proven). Trust-
// sensitive callers ask for verified rows only.
//
// An unverified *claim* a user typed — a quick-add provider id, a manual library
// id — never enters this table, because occupying the globally unique slot would
// let one account squat a provider key and capture another account's future real
// provider sync. Those live in `game_identity_claims`, which is scoped per
// catalog game and cannot block a verified attachment.
//
// A merge leaves the source row behind as a tombstone
// (`merged_into_catalog_game_id`), so historical ids stay resolvable. Every read
// resolves through the tombstone chain.

const MAX_MERGE_CHAIN_DEPTH = 8;

function isUniqueViolation(error) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function assertWellFormedPersistedText(fields) {
  const invalidFields = fields
    .filter(([, value]) => typeof value === 'string' && !isWellFormedUnicode(value))
    .map(([field]) => field);

  if (invalidFields.length > 0) {
    throw new AppError(400, 'INVALID_UNICODE_TEXT',
      'Persisted text must not contain an unpaired UTF-16 surrogate',
      invalidFields.map((field) => ({ field, message: 'unpaired_surrogate' })));
  }
}

/// Follows merged_into_catalog_game_id to the surviving canonical game. Bounded
/// so a cycle introduced by bad data cannot hang a request.
async function resolveCanonicalGameId(catalogGameId, { client = prisma } = {}) {
  let currentId = catalogGameId;
  const visited = new Set();

  for (let depth = 0; depth < MAX_MERGE_CHAIN_DEPTH; depth += 1) {
    if (!currentId || visited.has(currentId)) {
      return currentId ?? null;
    }

    visited.add(currentId);

    const game = await client.catalogGame.findUnique({
      where: { id: currentId },
      select: { id: true, mergedIntoCatalogGameId: true }
    });

    if (!game) {
      return null;
    }

    if (!game.mergedIntoCatalogGameId) {
      return game.id;
    }

    currentId = game.mergedIntoCatalogGameId;
  }

  logger.warn('catalog-merge-chain-too-deep', { depth: MAX_MERGE_CHAIN_DEPTH });

  return currentId;
}

/// Looks up a canonical game by provider key.
///
/// `requireVerified` (the default) only returns identities a real provider
/// response or an editor established. Pass false only where an unverified legacy
/// row is acceptable, and never to grant trust.
async function findCanonicalGameByIdentity(
  { provider, externalId, regionKey = GLOBAL_REGION_KEY },
  { client = prisma, requireVerified = true } = {}
) {
  const identity = await client.gameExternalIdentity.findUnique({
    where: {
      provider_externalId_regionKey: {
        provider,
        externalId: String(externalId),
        regionKey
      }
    },
    select: {
      catalogGameId: true,
      provenance: true,
      confidence: true,
      verifiedAt: true,
      verificationSource: true
    }
  });

  if (!identity) {
    return null;
  }

  const verified = identity.verifiedAt !== null && isVerifiedProvenance(identity.provenance);

  if (requireVerified && !verified) {
    return null;
  }

  const canonicalId = await resolveCanonicalGameId(identity.catalogGameId, { client });

  return canonicalId
    ? {
      catalogGameId: canonicalId,
      provenance: identity.provenance,
      confidence: identity.confidence,
      verified,
      verifiedAt: identity.verifiedAt,
      verificationSource: identity.verificationSource
    }
    : null;
}

/// Resolves a legacy (gameSource, externalGameId) pair. Verified-only by default.
async function findCanonicalGameByLegacyIdentity(
  { gameSource, externalGameId },
  { client = prisma, requireVerified = true } = {}
) {
  const provider = LEGACY_SOURCE_TO_PROVIDER[String(gameSource ?? '').toUpperCase()];
  const trimmedId = String(externalGameId ?? '').trim();

  if (!provider || trimmedId.length === 0) {
    return null;
  }

  return findCanonicalGameByIdentity(
    { provider, externalId: trimmedId, regionKey: GLOBAL_REGION_KEY },
    { client, requireVerified }
  );
}

/// Attaches a verified provider key to a canonical game.
///
/// Trusted operation: provenance must be a verified value and verificationSource
/// must name a real provider response or an editor decision. Unverified claims use
/// recordIdentityClaim. Conflict-safe, so it never aborts a surrounding
/// transaction, and it never repoints or adopts another canonical game.
async function attachVerifiedIdentity({
  client = prisma,
  catalogGameId,
  provider,
  externalId,
  regionKey = GLOBAL_REGION_KEY,
  regionalReleaseId = null,
  provenance,
  verificationSource,
  confidence = 1,
  verifiedAt = new Date()
}) {
  assertWellFormedPersistedText([
    ['externalId', externalId],
    ['regionKey', regionKey],
    ['verificationSource', verificationSource]
  ]);

  if (!isVerifiedProvenance(provenance)) {
    throw new AppError(500, 'IDENTITY_PROVENANCE_NOT_VERIFIABLE',
      `A global identity cannot be attached with ${provenance} provenance`);
  }

  if (!IDENTITY_VERIFICATION_SOURCES.includes(verificationSource)) {
    throw new AppError(500, 'IDENTITY_VERIFICATION_SOURCE_INVALID',
      'A verified identity attachment must name a recognised verification source');
  }

  const normalizedExternalId = String(externalId).trim();

  const inserted = await client.$queryRaw`
    INSERT INTO "game_external_identities"
      ("id", "catalog_game_id", "regional_release_id", "provider", "external_id",
       "region_key", "provenance", "confidence", "verified_at", "verification_source",
       "created_at", "updated_at")
    VALUES (
      gen_random_uuid(),
      ${catalogGameId}::uuid,
      ${regionalReleaseId}::uuid,
      ${provider}::"CatalogIdentityProvider",
      ${normalizedExternalId},
      ${regionKey},
      ${provenance}::"CatalogProvenance",
      ${confidence},
      ${verifiedAt},
      ${verificationSource},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("provider", "external_id", "region_key") DO NOTHING
    RETURNING "id"
  `;

  if (Array.isArray(inserted) && inserted.length === 1) {
    return { identity: { id: inserted[0].id, catalogGameId }, created: true, conflict: false };
  }

  const existing = await client.gameExternalIdentity.findUnique({
    where: {
      provider_externalId_regionKey: { provider, externalId: normalizedExternalId, regionKey }
    },
    select: { id: true, catalogGameId: true, verifiedAt: true, provenance: true }
  });

  return {
    identity: existing,
    created: false,
    // A provider key already bound to a *different* canonical game is a merge
    // decision for an editor, never an automatic overwrite.
    conflict: Boolean(existing) && existing.catalogGameId !== catalogGameId
  };
}

/// Records an unverified provider-key claim against a catalog game.
///
/// Deliberately NOT the globally unique identity table: two accounts may claim
/// the same unverified key, and neither claim prevents a later real provider
/// response from attaching the verified identity elsewhere.
async function recordIdentityClaim({
  client = prisma,
  catalogGameId,
  submissionId = null,
  claimedByUserId = null,
  provider,
  externalId,
  regionKey = GLOBAL_REGION_KEY,
  provenance = 'USER_CONFIRMED',
  claimSource = 'quick_add_syntax_parse'
}) {
  assertWellFormedPersistedText([
    ['externalId', externalId],
    ['regionKey', regionKey],
    ['claimSource', claimSource]
  ]);

  if (isVerifiedProvenance(provenance)) {
    throw new AppError(500, 'IDENTITY_CLAIM_PROVENANCE_INVALID',
      'An identity claim cannot assert verified provenance');
  }

  const normalizedExternalId = String(externalId).trim();

  // INSERT ... ON CONFLICT DO NOTHING rather than catching a unique violation:
  // this runs inside the quick-add confirmation transaction, and a raised
  // constraint error there would abort the whole transaction (SQLSTATE 25P02).
  const inserted = await client.$queryRaw`
    INSERT INTO "game_identity_claims"
      ("id", "catalog_game_id", "submission_id", "claimed_by_user_id", "provider",
       "external_id", "region_key", "provenance", "claim_source", "created_at", "updated_at")
    VALUES (
      gen_random_uuid(),
      ${catalogGameId}::uuid,
      ${submissionId}::uuid,
      ${claimedByUserId}::uuid,
      ${provider}::"CatalogIdentityProvider",
      ${normalizedExternalId},
      ${regionKey},
      ${provenance}::"CatalogProvenance",
      ${claimSource},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("catalog_game_id", "provider", "external_id", "region_key") DO NOTHING
    RETURNING "id"
  `;

  if (Array.isArray(inserted) && inserted.length === 1) {
    return { claim: { id: inserted[0].id, catalogGameId }, created: true };
  }

  const existing = await client.gameIdentityClaim.findUnique({
    where: {
      catalogGameId_provider_externalId_regionKey: {
        catalogGameId,
        provider,
        externalId: normalizedExternalId,
        regionKey
      }
    },
    select: { id: true, catalogGameId: true }
  });

  return { claim: existing, created: false };
}

/// Establishes the verified canonical game for a provider key.
///
/// TRUST. The lookup is verified-only. An unverified row can no longer exist in
/// game_external_identities at all (the successor migration moved every one into
/// game_identity_claims and a CHECK constraint blocks new ones), so there is
/// nothing here to "promote". The previous revision looked up with
/// requireVerified: false and promoted whatever it found, which meant a real Steam
/// sync adopted an attacker's legacy catalog game: their title stayed as the public
/// originalTitle, their PUBLISHED status and UNKNOWN provenance survived, and only
/// the identity row was upgraded. A user-chosen appid therefore captured another
/// account's provider sync.
///
/// ATOMICITY. The catalog game and its verified identity are created in one
/// transaction. Previously they were two independent statements, so an identity
/// failure that was not P2002 left a published orphan game behind and a retry
/// added another. The caller may pass its own transaction client to widen the unit
/// of work — linkVerifiedSteamOwnership does, so the library row update joins it.
///
/// A conflict-safe INSERT ... ON CONFLICT DO NOTHING is used rather than catching
/// P2002, because a raised constraint error aborts the surrounding PostgreSQL
/// transaction (SQLSTATE 25P02) and nothing after the catch could run.
async function ensureVerifiedCanonicalGameForIdentity({
  client = prisma,
  provider,
  externalId,
  regionKey = GLOBAL_REGION_KEY,
  title,
  publicationStatus,
  titleProvenance,
  identityProvenance,
  verificationSource,
  platforms = [],
  verifiedAt = new Date()
}) {
  assertWellFormedPersistedText([
    ['externalId', externalId],
    ['regionKey', regionKey],
    ['title', title],
    ['verificationSource', verificationSource],
    ...platforms.map((platform, index) => [`platforms.${index}`, platform])
  ]);

  assertPublicationTrust({ publicationStatus, titleProvenance, identityProvenance });

  if (!isVerifiedProvenance(identityProvenance)) {
    throw new AppError(500, 'IDENTITY_PROVENANCE_NOT_VERIFIABLE',
      `A global identity cannot be established with ${identityProvenance} provenance`);
  }

  if (!IDENTITY_VERIFICATION_SOURCES.includes(verificationSource)) {
    throw new AppError(500, 'IDENTITY_VERIFICATION_SOURCE_INVALID',
      'Creating a canonical game for a provider key requires a recognised verification source');
  }

  const normalizedExternalId = String(externalId).trim();

  const runInTransaction = (tx) => establishVerifiedIdentity({
    tx,
    provider,
    externalId: normalizedExternalId,
    regionKey,
    title,
    publicationStatus,
    titleProvenance,
    identityProvenance,
    verificationSource,
    platforms,
    verifiedAt
  });

  // Reuse the caller's transaction when one was supplied, so a wider unit of work
  // (game + identity + library linkage) commits or rolls back together.
  return client === prisma
    ? prisma.$transaction(runInTransaction)
    : runInTransaction(client);
}

async function establishVerifiedIdentity({
  tx,
  provider,
  externalId,
  regionKey,
  title,
  publicationStatus,
  titleProvenance,
  identityProvenance,
  verificationSource,
  platforms,
  verifiedAt
}) {
  // Verified-only. An unverified claim never satisfies this and never yields its
  // catalog game, its title, or its localizations.
  const verified = await findCanonicalGameByIdentity(
    { provider, externalId, regionKey },
    { client: tx, requireVerified: true }
  );

  if (verified) {
    return { catalogGameId: verified.catalogGameId, created: false, promoted: false };
  }

  const hasRealTitle = typeof title === 'string' && title.trim().length > 0;
  // clampTitle counts code points, matching varchar(300).
  const resolvedTitle = hasRealTitle ? clampTitle(title) : `${provider}:${externalId}`;
  // A synthetic placeholder title carries no verified information, so it can
  // never be published even when the identity itself is verified.
  const resolvedTitleProvenance = hasRealTitle ? titleProvenance : 'UNKNOWN';
  const resolvedPublicationStatus = hasRealTitle ? publicationStatus : 'PENDING_REVIEW';

  const game = await tx.catalogGame.create({
    data: {
      originalTitle: resolvedTitle,
      normalizedTitle: normalizeTitle(resolvedTitle),
      developerName: null,
      genres: [],
      steamTags: [],
      platforms,
      publicationStatus: resolvedPublicationStatus,
      titleProvenance: resolvedTitleProvenance
    },
    select: { id: true }
  });

  // The provider title is also recorded as the original-title localization, with
  // the same verified provenance the identity carries.
  await tx.gameLocalization.create({
    data: {
      catalogGameId: game.id,
      kind: 'ORIGINAL_TITLE',
      languageCode: 'und',
      regionCode: GLOBAL_REGION_KEY,
      title: resolvedTitle,
      normalizedTitle: normalizeTitle(resolvedTitle),
      provenance: resolvedTitleProvenance
    },
    select: { id: true }
  });

  const inserted = await tx.$queryRaw`
    INSERT INTO "game_external_identities"
      ("id", "catalog_game_id", "regional_release_id", "provider", "external_id",
       "region_key", "provenance", "confidence", "verified_at", "verification_source",
       "created_at", "updated_at")
    VALUES (
      gen_random_uuid(),
      ${game.id}::uuid,
      NULL,
      ${provider}::"CatalogIdentityProvider",
      ${externalId},
      ${regionKey},
      ${identityProvenance}::"CatalogProvenance",
      1,
      ${verifiedAt},
      ${verificationSource},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("provider", "external_id", "region_key") DO NOTHING
    RETURNING "id"
  `;

  if (Array.isArray(inserted) && inserted.length === 1) {
    return { catalogGameId: game.id, created: true, promoted: false };
  }

  // Lost the race. The occupant can only be a verified identity, because the CHECK
  // constraint forbids an unverified row in this table. Drop the game this
  // transaction just created and adopt the winner.
  const occupant = await tx.gameExternalIdentity.findUnique({
    where: { provider_externalId_regionKey: { provider, externalId, regionKey } },
    select: { catalogGameId: true, provenance: true, verifiedAt: true }
  });

  if (!occupant) {
    throw new AppError(500, 'IDENTITY_CONFLICT_UNRESOLVABLE',
      'The provider key conflicted but no identity row could be read');
  }

  if (occupant.verifiedAt === null || !isVerifiedProvenance(occupant.provenance)) {
    // Defence in depth: should be unreachable while the CHECK constraint holds.
    // Refuse rather than inherit an unverified row's canonical game.
    throw new AppError(409, 'IDENTITY_UNVERIFIED_OCCUPANT',
      'The provider key is held by an unverified identity and needs editor review');
  }

  await tx.gameLocalization.deleteMany({ where: { catalogGameId: game.id } });
  await tx.catalogGame.delete({ where: { id: game.id } });

  const canonicalId = await resolveCanonicalGameId(occupant.catalogGameId, { client: tx });

  return { catalogGameId: canonicalId, created: false, promoted: false };
}

/// Runtime invariant: a publicly visible catalog game must be backed by verified
/// provenance. USER_CONFIRMED, COMMUNITY_CONFIRMED, AI_INFERRED, UNKNOWN and
/// DISPUTED information can only ever produce a PRIVATE or PENDING_REVIEW game.
function assertPublicationTrust({ publicationStatus, titleProvenance, identityProvenance }) {
  if (publicationStatus !== 'PUBLISHED') {
    return;
  }

  const untrusted = [
    ['titleProvenance', titleProvenance],
    ['identityProvenance', identityProvenance]
  ].filter(([, provenance]) => !isVerifiedProvenance(provenance));

  if (untrusted.length > 0) {
    throw new AppError(500, 'CATALOG_PUBLICATION_TRUST_VIOLATION',
      'A PUBLISHED catalog game requires verified provenance',
      untrusted.map(([field, provenance]) => ({ field, message: String(provenance) })));
  }
}

/// Read-only resolution for a legacy write path.
///
/// Manual library / review / favorite writes may *link* to an already verified
/// identity, but they may never create one, because the identifier came from the
/// request body. When nothing verified exists the caller keeps catalogGameId null
/// and the legacy identity columns remain the only record.
async function resolveVerifiedCanonicalGameIdForLegacyWrite({ gameSource, externalGameId }) {
  try {
    const resolved = await findCanonicalGameByLegacyIdentity(
      { gameSource, externalGameId },
      { requireVerified: true }
    );

    return resolved?.catalogGameId ?? null;
  } catch (error) {
    logger.warn('catalog-legacy-identity-lookup-skipped', {
      provider: LEGACY_SOURCE_TO_PROVIDER[String(gameSource ?? '').toUpperCase()] ?? null,
      errorCategory: error?.code ?? error?.name ?? 'unknown'
    });

    return null;
  }
}

module.exports = {
  assertPublicationTrust,
  attachVerifiedIdentity,
  ensureVerifiedCanonicalGameForIdentity,
  findCanonicalGameByIdentity,
  findCanonicalGameByLegacyIdentity,
  recordIdentityClaim,
  resolveCanonicalGameId,
  resolveVerifiedCanonicalGameIdForLegacyWrite
};
