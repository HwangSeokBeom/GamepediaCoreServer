const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const { normalizeTitle } = require('./catalog-title.util');
const { GLOBAL_REGION_KEY, LEGACY_SOURCE_TO_PROVIDER } = require('./catalog.constants');

// Canonical identity resolution.
//
// A merge leaves the source row behind as a tombstone (merged_into_catalog_game_id
// set), so historical ids stay resolvable. Every read therefore resolves through
// the tombstone chain, and nothing outside CONFIRMED Steam↔IGDB mappings or an
// explicit editor decision ever writes one.

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

/// Looks up an existing canonical game by provider key. Returns null when the
/// provider key has never been seen.
async function findCanonicalGameByIdentity({ provider, externalId, regionKey = GLOBAL_REGION_KEY }, { client = prisma } = {}) {
  const identity = await client.gameExternalIdentity.findUnique({
    where: {
      provider_externalId_regionKey: {
        provider,
        externalId: String(externalId),
        regionKey
      }
    },
    select: { catalogGameId: true, provenance: true, confidence: true }
  });

  if (!identity) {
    return null;
  }

  const canonicalId = await resolveCanonicalGameId(identity.catalogGameId, { client });

  return canonicalId
    ? { catalogGameId: canonicalId, provenance: identity.provenance, confidence: identity.confidence }
    : null;
}

/// Resolves a legacy (gameSource, externalGameId) pair. A `GLOBAL` region key is
/// used because legacy identities were never region scoped.
async function findCanonicalGameByLegacyIdentity({ gameSource, externalGameId }, { client = prisma } = {}) {
  const provider = LEGACY_SOURCE_TO_PROVIDER[String(gameSource ?? '').toUpperCase()];
  const trimmedId = String(externalGameId ?? '').trim();

  if (!provider || trimmedId.length === 0) {
    return null;
  }

  return findCanonicalGameByIdentity({ provider, externalId: trimmedId, regionKey: GLOBAL_REGION_KEY }, { client });
}

/// Attaches a provider key to a canonical game. Concurrency safe: if another
/// request wins the unique index, the already-stored mapping is returned instead
/// of failing, and a conflicting mapping is reported rather than overwritten.
async function attachIdentity({
  client = prisma,
  catalogGameId,
  provider,
  externalId,
  regionKey = GLOBAL_REGION_KEY,
  regionalReleaseId = null,
  provenance = 'UNKNOWN',
  confidence = 0
}) {
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
        confidence
      },
      select: { id: true, catalogGameId: true }
    });

    return { identity: created, created: true, conflict: false };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const existing = await client.gameExternalIdentity.findUnique({
      where: {
        provider_externalId_regionKey: { provider, externalId: normalizedExternalId, regionKey }
      },
      select: { id: true, catalogGameId: true }
    });

    return {
      identity: existing,
      created: false,
      // A provider key already bound to a *different* canonical game is a merge
      // decision, never an automatic overwrite.
      conflict: Boolean(existing) && existing.catalogGameId !== catalogGameId
    };
  }
}

/// Creates the canonical game for a provider key that has never been seen, or
/// returns the existing one when a concurrent request created it first.
async function ensureCanonicalGameForIdentity({
  client = prisma,
  provider,
  externalId,
  regionKey = GLOBAL_REGION_KEY,
  title,
  publicationStatus = 'PUBLISHED',
  titleProvenance = 'PROVIDER_VERIFIED',
  identityProvenance = 'PROVIDER_VERIFIED',
  platforms = []
}) {
  const existing = await findCanonicalGameByIdentity({ provider, externalId, regionKey }, { client });

  if (existing) {
    return { catalogGameId: existing.catalogGameId, created: false };
  }

  const resolvedTitle = typeof title === 'string' && title.trim().length > 0
    ? title.trim().slice(0, 300)
    : `${provider}:${externalId}`;
  const hasRealTitle = typeof title === 'string' && title.trim().length > 0;

  const game = await client.catalogGame.create({
    data: {
      originalTitle: resolvedTitle,
      normalizedTitle: normalizeTitle(resolvedTitle),
      developerName: null,
      genres: [],
      steamTags: [],
      platforms,
      publicationStatus,
      titleProvenance: hasRealTitle ? titleProvenance : 'UNKNOWN'
    },
    select: { id: true }
  });

  const attached = await attachIdentity({
    client,
    catalogGameId: game.id,
    provider,
    externalId,
    regionKey,
    provenance: identityProvenance,
    confidence: 1
  });

  // Lost the race: another request already bound this provider key. Drop the row
  // this request just created and use the winner so the key stays single-valued.
  if (!attached.created && attached.identity) {
    await client.catalogGame.delete({ where: { id: game.id } }).catch(() => null);

    const canonicalId = await resolveCanonicalGameId(attached.identity.catalogGameId, { client });

    return { catalogGameId: canonicalId, created: false };
  }

  return { catalogGameId: game.id, created: true };
}

/// Dual write used by legacy write paths. The legacy identity columns are already
/// persisted by the caller; this only fills in the additive canonical index, so a
/// failure must never surface to the client.
async function linkLegacyIdentity({ gameSource, externalGameId, title = null }) {
  const provider = LEGACY_SOURCE_TO_PROVIDER[String(gameSource ?? '').toUpperCase()];
  const trimmedId = String(externalGameId ?? '').trim();

  if (!provider || trimmedId.length === 0) {
    return null;
  }

  const { catalogGameId } = await ensureCanonicalGameForIdentity({
    provider,
    externalId: trimmedId,
    title,
    platforms: provider === 'STEAM' ? ['STEAM'] : []
  });

  return catalogGameId;
}

/// Best-effort variant for existing endpoints: resolves (and creates when
/// missing) the canonical id, returning null instead of throwing so an existing
/// game-search, Steam, review or library write can never fail because of the
/// catalog.
async function resolveCanonicalGameIdForLegacyWrite({ gameSource, externalGameId, title = null }) {
  try {
    return await linkLegacyIdentity({ gameSource, externalGameId, title });
  } catch (error) {
    logger.warn('catalog-legacy-dual-write-skipped', {
      provider: LEGACY_SOURCE_TO_PROVIDER[String(gameSource ?? '').toUpperCase()] ?? null,
      errorCategory: error?.code ?? error?.name ?? 'unknown'
    });

    return null;
  }
}

module.exports = {
  attachIdentity,
  ensureCanonicalGameForIdentity,
  findCanonicalGameByIdentity,
  findCanonicalGameByLegacyIdentity,
  linkLegacyIdentity,
  resolveCanonicalGameId,
  resolveCanonicalGameIdForLegacyWrite
};
