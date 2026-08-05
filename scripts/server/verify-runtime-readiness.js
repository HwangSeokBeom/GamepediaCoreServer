#!/usr/bin/env node

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;

const PROBES = Object.freeze([
  {
    name: 'health',
    path: '/health',
    validate(payload) {
      return payload?.success === true &&
        payload?.data?.status === 'ok' &&
        payload?.data?.igdb?.configured === true;
    }
  },
  {
    name: 'IGDB highlights',
    path: '/games/highlights?limit=1',
    validate(payload) {
      return payload?.success === true && Array.isArray(payload?.data?.games);
    }
  }
]);

function parsePositiveInteger(rawValue, optionName) {
  const parsedValue = Number(rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }

  return parsedValue;
}

function normalizeBaseUrl(rawValue) {
  let parsedUrl;

  try {
    parsedUrl = new URL(rawValue);
  } catch (error) {
    throw new Error('--base-url must be a valid absolute URL');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('--base-url must use http or https');
  }

  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error('--base-url must not include credentials, a query, or a fragment');
  }

  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
  return parsedUrl;
}

function parseArgs(argv) {
  const values = {
    baseUrl: null,
    attempts: DEFAULT_ATTEMPTS,
    intervalMs: DEFAULT_INTERVAL_MS
  };

  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const rawValue = argv[index + 1];

    if (!rawValue) {
      throw new Error(`${option ?? 'option'} requires a value`);
    }

    if (option === '--base-url') {
      values.baseUrl = normalizeBaseUrl(rawValue);
    } else if (option === '--attempts') {
      values.attempts = parsePositiveInteger(rawValue, option);
    } else if (option === '--interval-ms') {
      values.intervalMs = parsePositiveInteger(rawValue, option);
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }

  if (!values.baseUrl) {
    throw new Error('--base-url is required');
  }

  return values;
}

function buildProbeUrl(baseUrl, probePath) {
  const basePath = baseUrl.pathname === '/' ? '' : baseUrl.pathname;
  return new URL(`${basePath}${probePath}`, baseUrl.origin);
}

async function probeRuntime({ baseUrl, fetchImpl = fetch }) {
  for (const probe of PROBES) {
    const response = await fetchImpl(buildProbeUrl(baseUrl, probe.path), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`${probe.name} returned HTTP ${response.status}`);
    }

    let payload;

    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`${probe.name} returned invalid JSON`);
    }

    if (!probe.validate(payload)) {
      throw new Error(`${probe.name} returned an unexpected response shape`);
    }
  }
}

async function verifyRuntimeReadiness({
  baseUrl,
  attempts = DEFAULT_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = fetch,
  wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await probeRuntime({ baseUrl, fetchImpl });
      return;
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        await wait(intervalMs);
      }
    }
  }

  throw new Error(`runtime readiness failed after ${attempts} attempt(s): ${lastError?.message ?? 'unknown failure'}`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    await verifyRuntimeReadiness(options);
    console.log(`Runtime readiness verified: ${PROBES.map((probe) => probe.name).join(', ')}`);
  } catch (error) {
    console.error(`Deployment aborted: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  PROBES,
  buildProbeUrl,
  normalizeBaseUrl,
  parseArgs,
  probeRuntime,
  verifyRuntimeReadiness
};
