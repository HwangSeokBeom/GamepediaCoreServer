// New Product 2.2 DTOs. Existing response shapes are untouched: catalogGameId
// and identities only ever appear in these new payloads, so a deployed iOS
// client decoding a legacy endpoint sees exactly the fields it saw before.

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function toIsoDateTime(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapIdentity(identity) {
  return {
    provider: identity.provider,
    externalId: identity.externalId,
    regionKey: identity.regionKey,
    provenance: identity.provenance,
    confidence: Number(identity.confidence ?? 0)
  };
}

function mapLocalization(localization) {
  return {
    kind: localization.kind,
    languageCode: localization.languageCode,
    regionCode: localization.regionCode,
    title: localization.title,
    provenance: localization.provenance
  };
}

function mapRegionalRelease(release) {
  return {
    id: release.id,
    countryCode: release.countryCode,
    languageCode: release.languageCode,
    platform: release.platform,
    operatorName: release.operatorName ?? null,
    serverRegion: release.serverRegion ?? null,
    releaseDate: toIsoDate(release.releaseDate),
    shutdownDate: toIsoDate(release.shutdownDate),
    serviceStatus: release.serviceStatus,
    provenance: release.provenance
  };
}

/// Only assets with a resolved rights status may be offered as a public hero
/// image. UNKNOWN and RESTRICTED are returned with `usableAsPublicHero: false`
/// so a client cannot promote an uncleared image by accident.
function mapAsset(asset) {
  const clearedRights = ['PROVIDER_LICENSED', 'OFFICIAL_PRESS_KIT', 'CLEARED'];

  return {
    kind: asset.kind,
    url: asset.url,
    rightsStatus: asset.rightsStatus,
    provenance: asset.provenance,
    attribution: asset.attribution ?? null,
    usableAsPublicHero: clearedRights.includes(asset.rightsStatus)
  };
}

function mapFieldEvidence(evidence) {
  return {
    fieldPath: evidence.fieldPath,
    provenance: evidence.provenance,
    confidence: Number(evidence.confidence ?? 0),
    sourceType: evidence.sourceType,
    sourceUrl: evidence.sourceUrl ?? null,
    observedAt: toIsoDateTime(evidence.observedAt)
  };
}

function mapCatalogGameSummary(game) {
  return {
    catalogGameId: game.id,
    originalTitle: game.originalTitle,
    slug: game.slug ?? null,
    developerName: game.developerName ?? null,
    publisherName: game.publisherName ?? null,
    firstReleaseDate: toIsoDate(game.firstReleaseDate),
    genres: [...(game.genres ?? [])],
    platforms: [...(game.platforms ?? [])],
    publicationStatus: game.publicationStatus,
    titleProvenance: game.titleProvenance,
    identities: (game.identities ?? []).map(mapIdentity)
  };
}

function mapCatalogGameDetail(game) {
  return {
    ...mapCatalogGameSummary(game),
    steamTags: [...(game.steamTags ?? [])],
    supportsSinglePlayer: game.supportsSinglePlayer ?? null,
    supportsMultiplayer: game.supportsMultiplayer ?? null,
    typicalSessionMinutes: game.typicalSessionMinutes ?? null,
    localizations: (game.localizations ?? []).map(mapLocalization),
    regionalReleases: (game.regionalReleases ?? []).map(mapRegionalRelease),
    assets: (game.assets ?? []).map(mapAsset),
    fieldEvidence: (game.fieldEvidence ?? []).map(mapFieldEvidence),
    createdAt: toIsoDateTime(game.createdAt),
    updatedAt: toIsoDateTime(game.updatedAt)
  };
}

module.exports = {
  mapAsset,
  mapCatalogGameDetail,
  mapCatalogGameSummary,
  mapFieldEvidence,
  mapIdentity,
  mapLocalization,
  mapRegionalRelease,
  toIsoDate,
  toIsoDateTime
};
