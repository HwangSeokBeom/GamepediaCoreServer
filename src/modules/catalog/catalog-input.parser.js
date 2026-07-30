const { GLOBAL_REGION_KEY } = require('./catalog.constants');

// Stage 1 of quick add: deterministic parsing. A store URL, an Apple app id, a
// Google Play package id or an explicit `provider:id` string resolves to a
// provider identity with zero AI involvement and zero outbound requests.
//
// The server never fetches a user-supplied URL. Only the URL *structure* is
// read, so a submitted link cannot be used to make the server reach an internal
// address, and page contents can never become an instruction to the model.

const STORE_URL_PARSERS = [
  {
    hostPattern: /^(?:www\.)?store\.steampowered\.com$/i,
    parse(url) {
      const match = /^\/(?:agecheck\/)?app\/(\d{1,12})(?:\/|$)/.exec(url.pathname);
      return match ? { provider: 'STEAM', externalId: match[1], regionKey: GLOBAL_REGION_KEY } : null;
    }
  },
  {
    hostPattern: /^(?:www\.)?steamcommunity\.com$/i,
    parse(url) {
      const match = /^\/app\/(\d{1,12})(?:\/|$)/.exec(url.pathname);
      return match ? { provider: 'STEAM', externalId: match[1], regionKey: GLOBAL_REGION_KEY } : null;
    }
  },
  {
    hostPattern: /^(?:www\.)?apps\.apple\.com$/i,
    parse(url) {
      const match = /^\/([a-z]{2})\/app\/(?:[^/]+\/)?id(\d{4,15})(?:\/|$)/i.exec(url.pathname);

      if (match) {
        return {
          provider: 'APPLE_APP_STORE',
          externalId: match[2],
          // Apple listings are storefront scoped, so the storefront becomes the
          // region key instead of being flattened into GLOBAL.
          regionKey: match[1].toUpperCase()
        };
      }

      const bareMatch = /^\/app\/(?:[^/]+\/)?id(\d{4,15})(?:\/|$)/i.exec(url.pathname);
      return bareMatch
        ? { provider: 'APPLE_APP_STORE', externalId: bareMatch[1], regionKey: GLOBAL_REGION_KEY }
        : null;
    }
  },
  {
    hostPattern: /^(?:www\.)?play\.google\.com$/i,
    parse(url) {
      if (!/^\/store\/apps\/details\/?$/.test(url.pathname)) {
        return null;
      }

      const packageId = url.searchParams.get('id');

      if (!isPackageId(packageId)) {
        return null;
      }

      const country = url.searchParams.get('gl');

      return {
        provider: 'GOOGLE_PLAY',
        externalId: packageId,
        regionKey: /^[A-Za-z]{2}$/.test(country ?? '') ? country.toUpperCase() : GLOBAL_REGION_KEY
      };
    }
  },
  {
    hostPattern: /^(?:www\.)?igdb\.com$/i,
    parse(url) {
      const match = /^\/games\/([a-z0-9][a-z0-9-]{0,120})(?:\/|$)/i.exec(url.pathname);
      return match
        ? { provider: 'IGDB', externalId: match[1].toLowerCase(), regionKey: GLOBAL_REGION_KEY }
        : null;
    }
  }
];

const PROVIDER_PREFIX_ALIASES = new Map([
  ['steam', 'STEAM'],
  ['steamapp', 'STEAM'],
  ['appid', 'STEAM'],
  ['igdb', 'IGDB'],
  ['apple', 'APPLE_APP_STORE'],
  ['appstore', 'APPLE_APP_STORE'],
  ['ios', 'APPLE_APP_STORE'],
  ['googleplay', 'GOOGLE_PLAY'],
  ['play', 'GOOGLE_PLAY'],
  ['android', 'GOOGLE_PLAY']
]);

const PLATFORM_HINT_TO_PROVIDER = new Map([
  ['STEAM', 'STEAM'],
  ['PC', 'STEAM'],
  ['IOS', 'APPLE_APP_STORE'],
  ['APPLE', 'APPLE_APP_STORE'],
  ['ANDROID', 'GOOGLE_PLAY']
]);

function isPackageId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){1,8}$/i.test(value) && value.length <= 200;
}

function parseHttpsUrl(rawInput) {
  let url;

  try {
    url = new URL(rawInput.trim());
  } catch (error) {
    return null;
  }

  // Only https store links are recognised. http:// and every other scheme are
  // rejected outright rather than upgraded.
  return url.protocol === 'https:' ? url : null;
}

/// Deterministically resolves a provider identity, or returns null when the
/// input is not a recognised URL / provider id. Never throws.
function parseProviderIdentity({ inputType, input, platformHint = null }) {
  const trimmed = typeof input === 'string' ? input.trim() : '';

  if (trimmed.length === 0) {
    return null;
  }

  if (inputType === 'URL' || /^https:\/\//i.test(trimmed)) {
    const url = parseHttpsUrl(trimmed);

    if (!url) {
      return null;
    }

    for (const parser of STORE_URL_PARSERS) {
      if (!parser.hostPattern.test(url.hostname)) {
        continue;
      }

      const parsed = parser.parse(url);

      if (parsed) {
        return { ...parsed, matchedBy: 'store_url' };
      }
    }

    return null;
  }

  if (inputType !== 'PROVIDER_ID') {
    return null;
  }

  const prefixed = /^([a-z_]+)\s*[:#]\s*(.+)$/i.exec(trimmed);

  if (prefixed) {
    const provider = PROVIDER_PREFIX_ALIASES.get(prefixed[1].toLowerCase().replace(/_/g, ''));
    const identifier = prefixed[2].trim();

    if (provider && isValidExternalId(provider, identifier)) {
      return {
        provider,
        externalId: normalizeExternalId(provider, identifier),
        regionKey: GLOBAL_REGION_KEY,
        matchedBy: 'provider_prefix'
      };
    }

    return null;
  }

  if (isPackageId(trimmed)) {
    return {
      provider: 'GOOGLE_PLAY',
      externalId: trimmed,
      regionKey: GLOBAL_REGION_KEY,
      matchedBy: 'package_id'
    };
  }

  // A bare numeric id is ambiguous, so it is only accepted with a platform hint
  // that names the provider.
  if (/^\d{1,15}$/.test(trimmed)) {
    const provider = PLATFORM_HINT_TO_PROVIDER.get(String(platformHint ?? '').toUpperCase());

    return provider
      ? { provider, externalId: trimmed, regionKey: GLOBAL_REGION_KEY, matchedBy: 'numeric_with_platform_hint' }
      : null;
  }

  return null;
}

function isValidExternalId(provider, identifier) {
  if (identifier.length === 0 || identifier.length > 200) {
    return false;
  }

  if (provider === 'STEAM') {
    return /^\d{1,12}$/.test(identifier);
  }

  if (provider === 'APPLE_APP_STORE') {
    return /^\d{4,15}$/.test(identifier.replace(/^id/i, ''));
  }

  if (provider === 'GOOGLE_PLAY') {
    return isPackageId(identifier);
  }

  if (provider === 'IGDB') {
    return /^[a-z0-9][a-z0-9-]{0,120}$/i.test(identifier);
  }

  return false;
}

function normalizeExternalId(provider, identifier) {
  if (provider === 'APPLE_APP_STORE') {
    return identifier.replace(/^id/i, '');
  }

  if (provider === 'IGDB') {
    return identifier.toLowerCase();
  }

  return identifier;
}

module.exports = {
  isPackageId,
  parseProviderIdentity
};
