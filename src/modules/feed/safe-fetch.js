const dns = require('node:dns/promises');
const net = require('node:net');
const { env } = require('../../config/env');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');

// Outbound fetch boundary for editorial source adapters.
//
// Only an administrator-configured host allowlist is reachable, only over HTTPS,
// with a bounded timeout, a bounded response size, no redirect following, and a
// DNS check that rejects private, loopback, link-local and unique-local
// addresses. User-supplied URLs never reach this function: quick add and
// corrections store URLs as evidence without fetching them.

const BLOCKED_IPV4_TESTS = [
  (parts) => parts[0] === 0,
  (parts) => parts[0] === 10,
  (parts) => parts[0] === 127,
  (parts) => parts[0] === 169 && parts[1] === 254,
  (parts) => parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31,
  (parts) => parts[0] === 192 && parts[1] === 168,
  (parts) => parts[0] === 192 && parts[1] === 0 && parts[2] === 0,
  (parts) => parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127,
  (parts) => parts[0] >= 224
];

function isBlockedIpv4(address) {
  const parts = address.split('.').map(Number);

  return parts.length !== 4
    || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    || BLOCKED_IPV4_TESTS.some((test) => test(parts));
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase();

  if (normalized === '::' || normalized === '::1') {
    return true;
  }

  // IPv4-mapped (::ffff:a.b.c.d) inherits the IPv4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);

  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }

  // fc00::/7 unique local, fe80::/10 link local.
  return /^f[cd][0-9a-f]{2}:/.test(normalized) || /^fe[89ab][0-9a-f]:/.test(normalized);
}

function isBlockedAddress(address) {
  if (net.isIPv4(address)) {
    return isBlockedIpv4(address);
  }

  if (net.isIPv6(address)) {
    return isBlockedIpv6(address);
  }

  return true;
}

/// Validates scheme, host allowlist and literal-IP hosts. Returns the parsed URL.
function assertAllowedSourceUrl(rawUrl, { allowlist = env.editorialSourceAllowlist } = {}) {
  let url;

  try {
    url = new URL(String(rawUrl));
  } catch (error) {
    throw new AppError(400, 'SOURCE_URL_INVALID', 'The source URL could not be parsed');
  }

  if (url.protocol !== 'https:') {
    throw new AppError(400, 'SOURCE_SCHEME_NOT_ALLOWED', 'Only https source URLs may be fetched');
  }

  if (url.username || url.password) {
    throw new AppError(400, 'SOURCE_URL_INVALID', 'Source URLs must not embed credentials');
  }

  const hostname = url.hostname.toLowerCase();

  // A literal IP host bypasses the hostname allowlist, so it is rejected outright.
  if (net.isIP(hostname) !== 0) {
    throw new AppError(403, 'SOURCE_HOST_NOT_ALLOWED', 'Literal IP source hosts are not allowed');
  }

  const allowed = allowlist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));

  if (!allowed) {
    throw new AppError(403, 'SOURCE_HOST_NOT_ALLOWED', 'The source host is not on the configured allowlist');
  }

  return url;
}

async function assertResolvesToPublicAddress(hostname, { lookup = dns.lookup } = {}) {
  let records;

  try {
    records = await lookup(hostname, { all: true });
  } catch (error) {
    throw new AppError(502, 'SOURCE_DNS_FAILED', 'The source host could not be resolved');
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new AppError(502, 'SOURCE_DNS_FAILED', 'The source host could not be resolved');
  }

  // Every resolved address must be public: one private answer is enough to make
  // the request a potential internal probe.
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new AppError(403, 'SOURCE_ADDRESS_BLOCKED', 'The source host resolves to a non-public address');
    }
  }

  return records;
}

/// Reads at most `maxBytes` from the response body, aborting as soon as the limit
/// is exceeded so a hostile endpoint cannot stream unbounded data.
async function readBoundedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppError(413, 'SOURCE_RESPONSE_TOO_LARGE', 'The source response exceeded the configured size limit');
  }

  if (!response.body) {
    return '';
  }

  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  let received = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    received += value.byteLength;

    if (received > maxBytes) {
      await reader.cancel().catch(() => null);
      throw new AppError(413, 'SOURCE_RESPONSE_TOO_LARGE', 'The source response exceeded the configured size limit');
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

/// Fetches an allowlisted editorial source. `fetchImpl` and `lookupImpl` are
/// injectable so fixture tests never touch the network.
async function fetchAllowlistedSource(rawUrl, {
  allowlist = env.editorialSourceAllowlist,
  timeoutMs = env.editorialSourceFetchTimeoutMs,
  maxBytes = env.editorialSourceMaxBytes,
  fetchImpl = globalThis.fetch,
  lookupImpl = dns.lookup
} = {}) {
  const url = assertAllowedSourceUrl(rawUrl, { allowlist });
  await assertResolvesToPublicAddress(url.hostname, { lookup: lookupImpl });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      // Never follow a redirect: a 30x could otherwise walk out of the allowlist.
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/rss+xml, application/xml, application/json, text/xml' }
    });

    if (response.status >= 300 && response.status < 400) {
      throw new AppError(502, 'SOURCE_REDIRECT_BLOCKED', 'The source responded with a redirect, which is not followed');
    }

    if (!response.ok) {
      throw new AppError(502, 'SOURCE_FETCH_FAILED', 'The source responded with an error status');
    }

    const body = await readBoundedText(response, maxBytes);

    logger.info('editorial-source-fetched', {
      host: url.hostname,
      status: response.status,
      byteLength: Buffer.byteLength(body, 'utf8'),
      redirectFollowed: false
    });

    return { status: response.status, body, url: url.toString() };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    const aborted = error?.name === 'AbortError';

    logger.warn('editorial-source-fetch-failed', {
      host: url.hostname,
      errorCategory: aborted ? 'timeout' : (error?.name ?? 'request_failed')
    });

    throw new AppError(504, aborted ? 'SOURCE_FETCH_TIMEOUT' : 'SOURCE_FETCH_FAILED',
      aborted ? 'The source fetch timed out' : 'The source could not be fetched');
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  assertAllowedSourceUrl,
  assertResolvesToPublicAddress,
  fetchAllowlistedSource,
  isBlockedAddress,
  readBoundedText
};
