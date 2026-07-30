const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const { normalizeTitle } = require('./catalog-title.util');
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

/// Attaches a provider key to a canonical game in the global identity table.
///
/// This is a trusted operation: `verificationSource` is mandatory and must name a
/// real provider response or an editor decision, and `provenance` must be a
/// verified value. Unverified claims must use recordIdentityClaim instead.
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
  if (!isVerifiedProvenance(provenance)) {
    throw new AppError(500, 'IDENTITY_PROVENANCE_NOT_VERIFIABLE',
      `A global identity cannot be attached with ${provenance} provenance`);
  }

  if (!IDENTITY_VERIFICATION_SOURCES.includes(verificationSource)) {
    throw new AppError(500, 'IDENTITY_VERIFICATION_SOURCE_INVALID',
      'A verified identity attachment must name a recognised verification source');
  }

  const normalizedExternalId = String(externalId).trim();

  try {
    const created = await client.gameExternalIdentity.create({
      data: {
        catalogGameId,
        regionalReleaseId,
        provider,
        externalId: normalizedExternalId,
        regionKey,
        provenance,
        confidence,
        verifiedAt,
        verificationSource
      },
      select: { id: true, catalogGameId: true, verifiedAt: true }
    });

    return { identity: created, created: true, conflict: false, promoted: false };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const existing = await client.gameExternalIdentity.findUnique({
      where: {
        provider_externalId_regionKey: { provider, externalId: normalizedExternalId, regionKey }
      },
      select: { id: true, catalogGameId: true, verifiedAt: true, provenance: true }
    });

    if (!existing) {
      throw error;
    }

    // The key already resolves to this same canonical game but was never
    // verified (a legacy backfill row). A real provider response is exactly what
    // is needed to promote it, so an unverified row must not block verification.
    if (existing.catalogGameId === catalogGameId && existing.verifiedAt === null) {
      const promoted = await client.gameExternalIdentity.update({
        where: { id: existing.id },
        data: { provenance, confidence, verifiedAt, verificationSource },
        select: { id: true, catalogGameId: true, verifiedAt: true }
      });

      return { identity: promoted, created: false, conflict: false, promoted: true };
    }

    return {
      identity: existing,
      created: false,
      // A provider key already bound to a *different* canonical game is a merge
      // decision, never an automatic overwrite.
      conflict: existing.catalogGameId !== catalogGameId,
      promoted: false
    };
  }
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

/// Creates the canonical game for a provider key that has never been verified.
///
/// Every trust-bearing field is mandatory: there is no default publication status
/// and no default provenance, because the previous defaults (PUBLISHED /
/// PROVIDER_VERIFIED) silently promoted whatever a caller happened to pass.
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
  assertPublicationTrust({ publicationStatus, titleProvenance, identityProvenance });

  if (!IDENTITY_VERIFICATION_SOURCES.includes(verificationSource)) {
    throw new AppError(500, 'IDENTITY_VERIFICATION_SOURCE_INVALID',
      'Creating a canonical game for a provider key requires a recognised verification source');
  }

  const existing = await findCanonicalGameByIdentity(
    { provider, externalId, regionKey },
    { client, requireVerified: false }
  );

  if (existing) {
    // The key is already bound. Promote the row when this call carries real
    // verification, then reuse the canonical game either way.
    if (!existing.verified) {
      await attachVerifiedIdentity({
        client,
        catalogGameId: existing.catalogGameId,
        provider,
        externalId,
        regionKey,
        provenance: identityProvenance,
        verificationSource,
        verifiedAt
      });
    }

    return { catalogGameId: existing.catalogGameId, created: false, promoted: !existing.verified };
  }

  const hasRealTitle = typeof title === 'string' && title.trim().length > 0;
  const resolvedTitle = hasRealTitle ? title.trim().slice(0, 300) : `${provider}:${externalId}`;
  // A synthetic placeholder title carries no verified information, so it can
  // never be published even when the identity itself is verified.
  const resolvedTitleProvenance = hasRealTitle ? titleProvenance : 'UNKNOWN';
  const resolvedPublicationStatus = hasRealTitle ? publicationStatus : 'PENDING_REVIEW';

  const game = await client.catalogGame.create({
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

  const attached = await attachVerifiedIdentity({
    client,
    catalogGameId: game.id,
    provider,
    externalId,
    regionKey,
    provenance: identityProvenance,
    verificationSource,
    verifiedAt
  });

  // Lost the race: another request already bound this provider key. Drop the row
  // this request just created and use the winner so the key stays single-valued.
  if (!attached.created && !attached.promoted && attached.identity) {
    await client.catalogGame.delete({ where: { id: game.id } }).catch(() => null);

    const canonicalId = await resolveCanonicalGameId(attached.identity.catalogGameId, { client });

    return { catalogGameId: canonicalId, created: false, promoted: false };
  }

  return { catalogGameId: game.id, created: true, promoted: false };
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
