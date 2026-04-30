const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');

const DEFAULT_RETRY_COUNT = 1;
const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GROQ_OPENAI_BASE_URL = 'https://api.groq.com/openai/v1';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const SUPPORTED_PROVIDERS = new Set(['openai', 'gemini', 'groq']);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildMockResponse() {
  return {
    content: null,
    model: 'mock-rule-based',
    promptTokens: 0,
    completionTokens: 0,
    skipped: true
  };
}

function getLlmConfig() {
  const provider = typeof env.llmProvider === 'string' ? env.llmProvider.toLowerCase() : 'openai';
  const supported = SUPPORTED_PROVIDERS.has(provider);
  const normalizedProvider = supported ? provider : 'openai';
  const fallbackBaseUrlByProvider = {
    gemini: GEMINI_OPENAI_BASE_URL,
    groq: GROQ_OPENAI_BASE_URL,
    openai: OPENAI_BASE_URL
  };
  const fallbackModelByProvider = {
    gemini: 'gemini-2.5-flash',
    groq: 'llama-3.1-8b-instant',
    openai: 'gpt-4o-mini'
  };

  return {
    provider,
    supported,
    apiKey: env.llmApiKey,
    baseUrl: env.llmBaseUrl || fallbackBaseUrlByProvider[normalizedProvider],
    model: env.llmModel || fallbackModelByProvider[normalizedProvider],
    timeoutMs: env.llmTimeoutMs
  };
}

function buildChatCompletionsUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function createChatCompletion({
  systemPrompt,
  userPrompt,
  retryCount = DEFAULT_RETRY_COUNT
}) {
  const llmConfig = getLlmConfig();

  if (!llmConfig.supported) {
    logger.warn('LLM request skipped; AI recommendation will use fallback ranking', {
      provider: llmConfig.provider,
      model: llmConfig.model,
      status: null,
      timeoutMs: llmConfig.timeoutMs,
      reason: 'unsupported_provider'
    });

    return buildMockResponse();
  }

  if (!llmConfig.apiKey) {
    logger.warn('LLM request skipped; AI recommendation will use fallback ranking', {
      provider: llmConfig.provider,
      model: llmConfig.model,
      status: null,
      timeoutMs: llmConfig.timeoutMs,
      reason: 'missing_api_key'
    });

    return buildMockResponse();
  }

  const startedAt = Date.now();
  let lastError = null;
  const requestUrl = buildChatCompletionsUrl(llmConfig.baseUrl);

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const response = await fetchWithTimeout(requestUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${llmConfig.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: llmConfig.model,
          response_format: { type: 'json_object' },
          temperature: 0.2,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      }, llmConfig.timeoutMs);

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        const error = new Error(`LLM request failed with status ${response.status}`);
        error.status = response.status;
        error.body = responseText.slice(0, 500);
        throw error;
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;

      return {
        content: typeof content === 'string' ? content : null,
        model: payload?.model ?? llmConfig.model,
        promptTokens: Number(payload?.usage?.prompt_tokens ?? 0),
        completionTokens: Number(payload?.usage?.completion_tokens ?? 0),
        skipped: false,
        upstreamLatencyMs: Date.now() - startedAt
      };
    } catch (error) {
      lastError = error;

      if (attempt < retryCount) {
        await sleep(250 * (attempt + 1));
      }
    }
  }

  logger.warn('LLM request failed; AI recommendation will use fallback ranking', {
    provider: llmConfig.provider,
    model: llmConfig.model,
    timeoutMs: llmConfig.timeoutMs,
    message: lastError?.message ?? 'unknown',
    status: lastError?.status ?? null
  });

  return buildMockResponse();
}

module.exports = {
  createChatCompletion,
  getLlmConfig
};
