const path = require('path');
const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');
const {
  getLibraryRequestMemoEntry,
  memoizeLibraryRequestValue,
  setLibraryRequestMemoEntry
} = require('./library-request-context');

const IMAGE_FETCH_TIMEOUT_MS = 5000;
const IMAGE_RESOLVER_ROUTE_PATH = '/library/images/resolve';
const PLACEHOLDER_IMAGE_ROUTE_PATH = '/uploads/placeholders/game-cover-placeholder.svg';
const PLACEHOLDER_IMAGE_FILE_PATH = path.resolve(process.cwd(), 'uploads/placeholders/game-cover-placeholder.svg');
const IGDB_IMAGE_HOSTS = new Set(['images.igdb.com']);

function getPublicBaseUrl() {
  return env.apiPublicBaseUrl ?? env.appWebBaseUrl ?? null;
}

function getPlaceholderImageUrl() {
  const publicBaseUrl = getPublicBaseUrl();

  if (!publicBaseUrl) {
    return PLACEHOLDER_IMAGE_ROUTE_PATH;
  }

  return new URL(PLACEHOLDER_IMAGE_ROUTE_PATH, publicBaseUrl).toString();
}

function normalizeGameSource(gameSource) {
  if (gameSource === 'steam' || gameSource === 'STEAM') {
    return 'steam';
  }

  return 'igdb';
}

function normalizeExternalGameId(externalGameId) {
  if (typeof externalGameId === 'number' && Number.isSafeInteger(externalGameId) && externalGameId > 0) {
    return String(externalGameId);
  }

  if (typeof externalGameId !== 'string') {
    return null;
  }

  const normalizedValue = externalGameId.trim();

  return normalizedValue.length > 0 ? normalizedValue : null;
}

function sanitizeIgdbCoverUrl(igdbCoverUrl) {
  if (typeof igdbCoverUrl !== 'string' || !igdbCoverUrl.trim()) {
    return null;
  }

  try {
    const normalizedUrl = new URL(igdbCoverUrl.trim());

    if (!IGDB_IMAGE_HOSTS.has(normalizedUrl.hostname)) {
      return null;
    }

    return normalizedUrl.toString();
  } catch (error) {
    return null;
  }
}

function buildSteamImageCandidates(externalGameId, igdbCoverUrl) {
  const normalizedAppId = normalizeExternalGameId(externalGameId);
  const candidates = [];

  if (igdbCoverUrl) {
    candidates.push({
      source: 'igdb-cover',
      url: igdbCoverUrl
    });
  }

  if (!normalizedAppId || !/^\d+$/.test(normalizedAppId)) {
    return candidates;
  }

  candidates.push(
    {
      source: 'steam-header',
      url: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${normalizedAppId}/header.jpg`
    },
    {
      source: 'steam-header-cdn',
      url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${normalizedAppId}/header.jpg`
    },
    {
      source: 'steam-library-600x900-2x',
      url: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${normalizedAppId}/library_600x900_2x.jpg`
    },
    {
      source: 'steam-library-600x900',
      url: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${normalizedAppId}/library_600x900.jpg`
    },
    {
      source: 'steam-library-capsule',
      url: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${normalizedAppId}/library_capsule.jpg`
    },
    {
      source: 'steam-capsule',
      url: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${normalizedAppId}/capsule_616x353.jpg`
    }
  );

  return candidates;
}

function buildImageCandidates({ gameSource, externalGameId, igdbCoverUrl }) {
  const normalizedSource = normalizeGameSource(gameSource);
  const sanitizedIgdbCoverUrl = sanitizeIgdbCoverUrl(igdbCoverUrl);

  if (normalizedSource === 'steam') {
    return buildSteamImageCandidates(externalGameId, sanitizedIgdbCoverUrl);
  }

  return sanitizedIgdbCoverUrl
    ? [{
      source: 'igdb-cover',
      url: sanitizedIgdbCoverUrl
    }]
    : [];
}

function buildGameImageResolverUrl({ gameSource, externalGameId, igdbCoverUrl }) {
  const normalizedGameSource = normalizeGameSource(gameSource);
  const normalizedExternalGameId = normalizeExternalGameId(externalGameId);
  const sanitizedIgdbCoverUrl = sanitizeIgdbCoverUrl(igdbCoverUrl);
  const requestMemoKey = normalizedExternalGameId
    ? [normalizedGameSource, normalizedExternalGameId].join('|')
    : [
      normalizedGameSource,
      normalizedExternalGameId ?? '',
      sanitizedIgdbCoverUrl ?? ''
    ].join('|');
  const coverCandidatePriority = sanitizedIgdbCoverUrl ? 1 : 0;

  if (normalizedExternalGameId) {
    const existingEntry = getLibraryRequestMemoEntry('imageUrlByExternalGameId', requestMemoKey);

    logger.info('library-request-cache', {
      cacheType: 'imageUrlByExternalGameId',
      cacheKey: requestMemoKey,
      hit: Boolean(existingEntry)
    });

    if (existingEntry && existingEntry.priority >= coverCandidatePriority) {
      return existingEntry.value;
    }
  }

  const buildUrl = ({ suppressGeneratedLog = false } = {}) => {
    const publicBaseUrl = getPublicBaseUrl();

    if (!publicBaseUrl) {
      if (!suppressGeneratedLog) {
        logger.warn('Game image url generated without public base URL', {
          gameSource: normalizedGameSource,
          externalGameId: normalizedExternalGameId,
          fallbackReason: 'missing_public_base_url'
        });
      }

      return getPlaceholderImageUrl();
    }

    const url = new URL(IMAGE_RESOLVER_ROUTE_PATH, publicBaseUrl);
    url.searchParams.set('gameSource', normalizedGameSource);

    if (normalizedExternalGameId) {
      url.searchParams.set('externalGameId', normalizedExternalGameId);
    }

    if (sanitizedIgdbCoverUrl) {
      url.searchParams.set('igdbCoverUrl', sanitizedIgdbCoverUrl);
    }

    const generatedUrl = url.toString();

    if (!suppressGeneratedLog) {
      logger.info('Game image url generated', {
        gameSource: normalizedGameSource,
        externalGameId: normalizedExternalGameId,
        imageUrlGenerated: generatedUrl,
        hasIgdbCoverUrlCandidate: Boolean(sanitizedIgdbCoverUrl),
        note: sanitizedIgdbCoverUrl
          ? 'igdb_cover_candidate_present_for_image_resolution_only'
          : 'steam_only_image_candidates'
      });
    }

    return generatedUrl;
  };

  if (!normalizedExternalGameId) {
    return memoizeLibraryRequestValue('imageUrlByExternalGameId', requestMemoKey, () => buildUrl());
  }

  const existingEntry = getLibraryRequestMemoEntry('imageUrlByExternalGameId', requestMemoKey);
  const generatedUrl = buildUrl({
    suppressGeneratedLog: Boolean(existingEntry)
  });

  setLibraryRequestMemoEntry('imageUrlByExternalGameId', requestMemoKey, {
    value: generatedUrl,
    priority: coverCandidatePriority
  });

  return generatedUrl;
}

function extractUsableIgdbCoverUrl(coverUrl) {
  return sanitizeIgdbCoverUrl(coverUrl);
}

async function fetchImageCandidate(candidate) {
  let response;

  try {
    response = await fetch(candidate.url, {
      method: 'GET',
      headers: {
        Accept: 'image/*'
      },
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    return {
      ok: false,
      fallbackReason: 'network_error'
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      fallbackReason: `http_${response.status}`
    };
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

  if (!contentType.startsWith('image/')) {
    return {
      ok: false,
      fallbackReason: 'invalid_content_type'
    };
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer());

  if (imageBuffer.length === 0) {
    return {
      ok: false,
      fallbackReason: 'empty_image'
    };
  }

  return {
    ok: true,
    contentType,
    imageBuffer
  };
}

async function sendResolvedGameImage({ res, gameSource, externalGameId, igdbCoverUrl }) {
  const candidates = buildImageCandidates({
    gameSource,
    externalGameId,
    igdbCoverUrl
  });

  for (const candidate of candidates) {
    const result = await fetchImageCandidate(candidate);

    if (!result.ok) {
      logger.warn('Game image fallback candidate skipped', {
        gameSource: normalizeGameSource(gameSource),
        externalGameId: normalizeExternalGameId(externalGameId),
        sourceSelected: candidate.source,
        imageUrlGenerated: candidate.url,
        fallbackReason: result.fallbackReason
      });
      continue;
    }

    logger.info('Game image source selected', {
      gameSource: normalizeGameSource(gameSource),
      externalGameId: normalizeExternalGameId(externalGameId),
      sourceSelected: candidate.source,
      imageUrlGenerated: candidate.url
    });

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.status(200).send(result.imageBuffer);
    return;
  }

  logger.warn('Game image source selected', {
    gameSource: normalizeGameSource(gameSource),
    externalGameId: normalizeExternalGameId(externalGameId),
    sourceSelected: 'placeholder',
    imageUrlGenerated: getPlaceholderImageUrl(),
    fallbackReason: candidates.length === 0 ? 'no_candidates' : 'all_candidates_failed'
  });

  res.setHeader('Cache-Control', 'public, max-age=21600');
  res.sendFile(PLACEHOLDER_IMAGE_FILE_PATH);
}

module.exports = {
  buildGameImageResolverUrl,
  extractUsableIgdbCoverUrl,
  getPlaceholderImageUrl,
  sendResolvedGameImage
};
