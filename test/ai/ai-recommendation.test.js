const test = require('node:test');
const assert = require('node:assert/strict');
const tokenService = require('../../src/services/token.service');
const { app } = require('../../src/app');
const { AppError } = require('../../src/utils/error-response');
const { env } = require('../../src/config/env');
const { prisma } = require('../../src/config/prisma');
const { aiGameRecommendationRequestSchema } = require('../../src/modules/ai/ai.schema');
const aiClient = require('../../src/modules/ai/ai.client');
const aiService = require('../../src/modules/ai/ai.service');
const { mergeCandidates } = require('../../src/modules/recommendation/game-candidate.provider');
const { rankCandidates } = require('../../src/modules/recommendation/recommendation-ranker');
const {
  normalizeLimit,
  validateLlmRecommendationResponse
} = require('../../src/modules/ai/ai.validator');

const sampleCandidates = [
  {
    gameId: '100',
    title: 'Cozy Farm',
    coverUrl: 'https://example.com/cozy.jpg',
    platforms: ['PC', 'Nintendo Switch'],
    genres: ['Simulation', 'Adventure'],
    rating: 90,
    summary: 'A cozy relaxing farming game for short sessions.'
  },
  {
    gameId: '200',
    title: 'Space Tactics',
    coverUrl: null,
    platforms: ['PC'],
    genres: ['Strategy'],
    rating: 80,
    summary: 'A long strategy game.'
  },
  {
    gameId: '300',
    title: 'Puzzle Room',
    coverUrl: null,
    platforms: ['Nintendo Switch'],
    genres: ['Puzzle', 'Adventure'],
    rating: 75,
    summary: 'A short puzzle adventure.'
  }
];

async function withTestServer(callback) {
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test('AI request validation accepts the public request contract', () => {
  const parsed = aiGameRecommendationRequestSchema.parse({
    query: '퇴근하고 30분 정도 할 수 있는 힐링 게임 추천해줘',
    platforms: ['PC', 'Nintendo Switch'],
    preferredGenres: ['Simulation', 'Adventure'],
    excludedGameIds: [123, '456'],
    limit: 10
  });

  assert.equal(parsed.query, '퇴근하고 30분 정도 할 수 있는 힐링 게임 추천해줘');
  assert.deepEqual(parsed.platforms, ['PC', 'Nintendo Switch']);
  assert.deepEqual(parsed.preferredGenres, ['Simulation', 'Adventure']);
  assert.deepEqual(parsed.excludedGameIds, [123, '456']);
  assert.equal(parsed.limit, 10);
});

test('AI request validation rejects invalid payloads', () => {
  assert.throws(() => aiGameRecommendationRequestSchema.parse({
    query: '',
    limit: -1
  }));
});

test('normalizeLimit clamps recommendations to the 5-10 range', () => {
  assert.equal(normalizeLimit(1), 5);
  assert.equal(normalizeLimit(7), 7);
  assert.equal(normalizeLimit(30), 10);
});

test('AI cache key is scoped by userId and excludedGameIds', () => {
  const firstKey = aiService.buildCacheKey({
    userId: 'user-a',
    query: '힐링 게임',
    platforms: ['PC'],
    preferredGenres: ['Simulation'],
    excludedGameIds: [1, 2],
    limit: 10
  });
  const secondKey = aiService.buildCacheKey({
    userId: 'user-b',
    query: '힐링 게임',
    platforms: ['PC'],
    preferredGenres: ['Simulation'],
    excludedGameIds: [1, 2],
    limit: 10
  });
  const thirdKey = aiService.buildCacheKey({
    userId: 'user-a',
    query: '힐링 게임',
    platforms: ['PC'],
    preferredGenres: ['Simulation'],
    excludedGameIds: [2, 3],
    limit: 10
  });

  assert.notEqual(firstKey, secondKey);
  assert.notEqual(firstKey, thirdKey);
});

test('candidate merge removes excludedGameIds and duplicates', () => {
  const candidates = mergeCandidates([
    [{ id: 100, name: 'Cozy Farm', platforms: ['PC'], genres: ['Simulation'] }],
    [{ id: 100, name: 'Cozy Farm Duplicate' }],
    [{ id: 200, name: 'Space Tactics' }]
  ], [200]);

  assert.deepEqual(candidates.map((candidate) => candidate.gameId), ['100']);
});

test('fallback ranker returns stable recommendation items', () => {
  const rankedItems = rankCandidates({
    candidates: sampleCandidates,
    query: '30분 힐링 게임',
    platforms: ['Nintendo Switch'],
    preferredGenres: ['Simulation'],
    limit: 2
  });

  assert.equal(rankedItems.length, 2);
  assert.equal(rankedItems[0].gameId, '100');
  assert.ok(rankedItems[0].confidence >= 0 && rankedItems[0].confidence <= 1);
  assert.ok(rankedItems[0].matchTags.length > 0);
});

test('invalid LLM JSON uses fallback ranking', () => {
  const validated = validateLlmRecommendationResponse({
    rawContent: '{invalid json',
    candidates: sampleCandidates,
    limit: 2,
    fallbackContext: {
      query: '30분 힐링 게임',
      platforms: ['Nintendo Switch'],
      preferredGenres: ['Simulation']
    }
  });

  assert.equal(validated.source, 'fallback');
  assert.equal(validated.items.length, 3);
  assert.equal(validated.items[0].gameId, '100');
});

test('validator removes gameIds outside candidates and duplicate gameIds', () => {
  const validated = validateLlmRecommendationResponse({
    rawContent: JSON.stringify({
      items: [
        { gameId: '999', reason: '후보 밖 게임', matchTags: ['제거'], confidence: 1.5 },
        { gameId: '100', reason: '좋은 후보입니다.'.repeat(20), matchTags: ['힐링', '힐링', '짧은 세션', '싱글', '초과'], confidence: 1.5 },
        { gameId: '100', reason: '중복', matchTags: [], confidence: 0.2 },
        { gameId: '300', reason: '', matchTags: [], confidence: -1 }
      ]
    }),
    candidates: sampleCandidates,
    limit: 5,
    fallbackContext: {
      query: '힐링',
      platforms: [],
      preferredGenres: []
    }
  });

  assert.equal(validated.source, 'llm');
  assert.deepEqual(validated.items.map((item) => item.gameId), ['100', '300']);
  assert.equal(validated.items[0].confidence, 1);
  assert.equal(validated.items[1].confidence, 0);
  assert.ok(validated.items[0].reason.length <= 160);
  assert.ok(validated.items[0].matchTags.length <= 4);
  assert.ok(validated.items[1].reason.length > 0);
  assert.ok(validated.items[1].matchTags.length > 0);
});

test('daily usage limit throws AI_DAILY_LIMIT_EXCEEDED', async () => {
  const originalTransaction = prisma.$transaction;
  const originalLimit = env.aiRecommendationDailyLimit;

  env.aiRecommendationDailyLimit = 1;
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ recommendationCount: 2 })
    }
  });

  try {
    await assert.rejects(
      () => aiService.assertAndIncrementDailyUsage({ userId: '00000000-0000-0000-0000-000000000000' }),
      (error) => error instanceof AppError && error.code === 'AI_DAILY_LIMIT_EXCEEDED'
    );
  } finally {
    prisma.$transaction = originalTransaction;
    env.aiRecommendationDailyLimit = originalLimit;
  }
});

test('recommendation logging stores expected fields', async () => {
  const originalCreate = prisma.aiRecommendationLog.create;
  let storedPayload = null;

  prisma.aiRecommendationLog.create = async (payload) => {
    storedPayload = payload;
    return { id: 'log-id' };
  };

  try {
    await aiService.writeRecommendationLog({
      userId: '00000000-0000-0000-0000-000000000000',
      query: '힐링 게임',
      normalizedQuery: '힐링 게임',
      intent: { mood: ['relaxing'] },
      items: [{ gameId: 100 }, { gameId: '300' }],
      model: 'mock',
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 12
    });

    assert.equal(storedPayload.data.query, '힐링 게임');
    assert.deepEqual(storedPayload.data.resultGameIds, ['100', '300']);
    assert.equal(storedPayload.data.latencyMs, 12);
  } finally {
    prisma.aiRecommendationLog.create = originalCreate;
  }
});

test('LLM client returns mock response without an API key', async () => {
  const originalApiKey = env.llmApiKey;

  env.llmApiKey = null;

  try {
    const response = await aiClient.createChatCompletion({
      systemPrompt: 'system',
      userPrompt: '{}'
    });

    assert.equal(response.skipped, true);
    assert.equal(response.model, 'mock-rule-based');
  } finally {
    env.llmApiKey = originalApiKey;
  }
});

test('LLM client resolves Gemini OpenAI-compatible defaults', () => {
  const originalProvider = env.llmProvider;
  const originalBaseUrl = env.llmBaseUrl;
  const originalModel = env.llmModel;
  const originalTimeoutMs = env.llmTimeoutMs;

  env.llmProvider = 'gemini';
  env.llmBaseUrl = null;
  env.llmModel = null;
  env.llmTimeoutMs = 1234;

  try {
    const config = aiClient.getLlmConfig();

    assert.equal(config.provider, 'gemini');
    assert.equal(config.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(config.model, 'gemini-2.5-flash');
    assert.equal(config.timeoutMs, 1234);
  } finally {
    env.llmProvider = originalProvider;
    env.llmBaseUrl = originalBaseUrl;
    env.llmModel = originalModel;
    env.llmTimeoutMs = originalTimeoutMs;
  }
});

test('LLM client resolves Groq OpenAI-compatible defaults and request shape', async () => {
  const originalFetch = global.fetch;
  const originalProvider = env.llmProvider;
  const originalApiKey = env.llmApiKey;
  const originalBaseUrl = env.llmBaseUrl;
  const originalModel = env.llmModel;
  const originalTimeoutMs = env.llmTimeoutMs;
  let requestedUrl = null;
  let requestedOptions = null;

  env.llmProvider = 'groq';
  env.llmApiKey = 'groq-test-key';
  env.llmBaseUrl = null;
  env.llmModel = null;
  env.llmTimeoutMs = 1234;
  global.fetch = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;

    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama-3.1-8b-instant',
        choices: [
          {
            message: {
              content: '{"items":[]}'
            }
          }
        ],
        usage: {
          prompt_tokens: 31,
          completion_tokens: 7
        }
      })
    };
  };

  try {
    const config = aiClient.getLlmConfig();
    const response = await aiClient.createChatCompletion({
      systemPrompt: 'system prompt',
      userPrompt: '{"query":"cozy"}',
      retryCount: 0
    });
    const requestBody = JSON.parse(requestedOptions.body);

    assert.equal(config.provider, 'groq');
    assert.equal(config.supported, true);
    assert.equal(config.baseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(config.model, 'llama-3.1-8b-instant');
    assert.equal(requestedUrl, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(requestedOptions.method, 'POST');
    assert.equal(requestedOptions.headers.Authorization, 'Bearer groq-test-key');
    assert.equal(requestBody.model, 'llama-3.1-8b-instant');
    assert.equal(requestBody.temperature, 0.2);
    assert.deepEqual(requestBody.response_format, { type: 'json_object' });
    assert.deepEqual(requestBody.messages, [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '{"query":"cozy"}' }
    ]);
    assert.equal(response.content, '{"items":[]}');
    assert.equal(response.model, 'llama-3.1-8b-instant');
    assert.equal(response.promptTokens, 31);
    assert.equal(response.completionTokens, 7);
    assert.equal(response.skipped, false);
  } finally {
    global.fetch = originalFetch;
    env.llmProvider = originalProvider;
    env.llmApiKey = originalApiKey;
    env.llmBaseUrl = originalBaseUrl;
    env.llmModel = originalModel;
    env.llmTimeoutMs = originalTimeoutMs;
  }
});

test('LLM client falls back on unsupported providers', async () => {
  const originalFetch = global.fetch;
  const originalProvider = env.llmProvider;
  const originalApiKey = env.llmApiKey;
  let fetchCalled = false;

  env.llmProvider = 'unknown-provider';
  env.llmApiKey = 'test-key';
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  };

  try {
    const response = await aiClient.createChatCompletion({
      systemPrompt: 'system',
      userPrompt: '{}',
      retryCount: 0
    });

    assert.equal(fetchCalled, false);
    assert.equal(response.skipped, true);
    assert.equal(response.model, 'mock-rule-based');
  } finally {
    global.fetch = originalFetch;
    env.llmProvider = originalProvider;
    env.llmApiKey = originalApiKey;
  }
});

test('LLM client falls back on provider HTTP failures', async () => {
  const originalFetch = global.fetch;
  const originalProvider = env.llmProvider;
  const originalApiKey = env.llmApiKey;
  const originalBaseUrl = env.llmBaseUrl;
  const originalModel = env.llmModel;
  let requestedUrl = null;

  env.llmProvider = 'gemini';
  env.llmApiKey = 'test-key';
  env.llmBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
  env.llmModel = 'gemini-2.5-flash-lite';
  global.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: false,
      status: 429,
      text: async () => 'quota exceeded'
    };
  };

  try {
    const response = await aiClient.createChatCompletion({
      systemPrompt: 'system',
      userPrompt: '{}',
      retryCount: 0
    });

    assert.equal(requestedUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.equal(response.skipped, true);
    assert.equal(response.model, 'mock-rule-based');
  } finally {
    global.fetch = originalFetch;
    env.llmProvider = originalProvider;
    env.llmApiKey = originalApiKey;
    env.llmBaseUrl = originalBaseUrl;
    env.llmModel = originalModel;
  }
});

test('service returns fallback recommendations without an LLM API key', async () => {
  const originalApiKey = env.llmApiKey;
  const originalTwitchClientId = env.twitchClientId;
  const originalTwitchClientSecret = env.twitchClientSecret;
  const originalCreate = prisma.aiRecommendationLog.create;

  env.llmApiKey = null;
  env.twitchClientId = null;
  env.twitchClientSecret = null;
  prisma.aiRecommendationLog.create = async () => ({ id: 'log-id' });

  try {
    const response = await aiService.createGameRecommendations({
      userId: '00000000-0000-0000-0000-000000000000',
      query: '퇴근하고 30분 정도 할 수 있는 힐링 게임 추천해줘',
      platforms: ['PC', 'Nintendo Switch'],
      preferredGenres: ['Simulation', 'Adventure'],
      excludedGameIds: [123, 456],
      limit: 10
    });

    assert.match(response.requestId, /^ai-rec-/);
    assert.equal(response.disclaimer, 'AI 추천은 참고용이며 실제 취향과 다를 수 있습니다.');
    assert.ok(response.items.length > 0);
    assert.ok(response.items.every((item) => !['123', '456'].includes(String(item.gameId))));
  } finally {
    env.llmApiKey = originalApiKey;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
    prisma.aiRecommendationLog.create = originalCreate;
  }
});

test('service returns fallback recommendations when LLM returns invalid JSON', async () => {
  const originalApiKey = env.llmApiKey;
  const originalTwitchClientId = env.twitchClientId;
  const originalTwitchClientSecret = env.twitchClientSecret;
  const originalCreate = prisma.aiRecommendationLog.create;
  const originalCreateChatCompletion = aiClient.createChatCompletion;
  let storedPayload = null;

  env.llmApiKey = 'test-key';
  env.twitchClientId = null;
  env.twitchClientSecret = null;
  prisma.aiRecommendationLog.create = async (payload) => {
    storedPayload = payload;
    return { id: 'log-id' };
  };
  aiClient.createChatCompletion = async () => ({
    content: 'not-json',
    model: 'gemini-2.5-flash',
    promptTokens: 12,
    completionTokens: 4,
    skipped: false
  });

  try {
    const response = await aiService.createGameRecommendations({
      userId: '00000000-0000-0000-0000-000000000000',
      query: 'invalid json fallback test',
      platforms: ['PC'],
      preferredGenres: ['Simulation'],
      excludedGameIds: [],
      limit: 10
    });

    assert.match(response.requestId, /^ai-rec-/);
    assert.ok(response.items.length > 0);
    assert.equal(storedPayload.data.model, 'mock-rule-based');
    assert.equal(storedPayload.data.promptTokens, 0);
    assert.equal(storedPayload.data.completionTokens, 0);
    assert.ok(storedPayload.data.resultGameIds.length > 0);
  } finally {
    env.llmApiKey = originalApiKey;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
    prisma.aiRecommendationLog.create = originalCreate;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});

test('service stores Groq model and usage tokens on successful LLM recommendations', async () => {
  const originalApiKey = env.llmApiKey;
  const originalProvider = env.llmProvider;
  const originalModel = env.llmModel;
  const originalTwitchClientId = env.twitchClientId;
  const originalTwitchClientSecret = env.twitchClientSecret;
  const originalCacheTtlSeconds = env.aiRecommendationCacheTtlSeconds;
  const originalCreate = prisma.aiRecommendationLog.create;
  const originalCreateChatCompletion = aiClient.createChatCompletion;
  let storedPayload = null;

  env.llmProvider = 'groq';
  env.llmApiKey = 'test-key';
  env.llmModel = 'llama-3.1-8b-instant';
  env.twitchClientId = null;
  env.twitchClientSecret = null;
  env.aiRecommendationCacheTtlSeconds = 0;
  prisma.aiRecommendationLog.create = async (payload) => {
    storedPayload = payload;
    return { id: 'log-id' };
  };
  aiClient.createChatCompletion = async () => ({
    content: JSON.stringify({
      normalizedQuery: 'short cozy games',
      intent: {
        mood: ['cozy'],
        sessionLength: 'short',
        playMode: 'single-player',
        difficulty: 'low',
        platforms: ['PC']
      },
      items: [
        {
          gameId: '17000',
          reason: '짧은 세션과 힐링 분위기에 잘 맞습니다.',
          matchTags: ['힐링', '짧은 세션'],
          confidence: 0.91
        },
        {
          gameId: '132181',
          reason: '차분한 퍼즐 진행이 요청과 잘 맞습니다.',
          matchTags: ['퍼즐', '차분함'],
          confidence: 0.84
        }
      ]
    }),
    model: 'llama-3.1-8b-instant',
    promptTokens: 55,
    completionTokens: 21,
    skipped: false
  });

  try {
    const response = await aiService.createGameRecommendations({
      userId: '00000000-0000-0000-0000-000000000000',
      query: 'groq success log test',
      platforms: ['PC'],
      preferredGenres: ['Simulator'],
      excludedGameIds: [],
      limit: 5
    });

    assert.deepEqual(response.items.map((item) => item.gameId), [17000, 132181]);
    assert.equal(storedPayload.data.model, 'llama-3.1-8b-instant');
    assert.equal(storedPayload.data.promptTokens, 55);
    assert.equal(storedPayload.data.completionTokens, 21);
    assert.deepEqual(storedPayload.data.resultGameIds, ['17000', '132181']);
  } finally {
    env.llmApiKey = originalApiKey;
    env.llmProvider = originalProvider;
    env.llmModel = originalModel;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
    env.aiRecommendationCacheTtlSeconds = originalCacheTtlSeconds;
    prisma.aiRecommendationLog.create = originalCreate;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});

test('route requires access token at the documented /api/v1 path', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/ai/game-recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '힐링 게임 추천',
        limit: 10
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'UNAUTHORIZED');
  });
});

test('route returns validation error for malformed JSON', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/ai/game-recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid-json'
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'VALIDATION_FAILED');
  });
});

test('route returns wrapped success response and clamps limit 100 to at most 10 items', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;
  const originalCreate = prisma.aiRecommendationLog.create;
  const originalApiKey = env.llmApiKey;
  const originalTwitchClientId = env.twitchClientId;
  const originalTwitchClientSecret = env.twitchClientSecret;

  tokenService.verifyAccessToken = () => ({
    type: 'access',
    sub: '00000000-0000-0000-0000-000000000000'
  });
  prisma.user.findUnique = async () => ({
    id: '00000000-0000-0000-0000-000000000000',
    email: 'test@example.com',
    status: 'ACTIVE'
  });
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ recommendationCount: 1 })
    }
  });
  prisma.aiRecommendationLog.create = async () => ({ id: 'log-id' });
  env.llmApiKey = null;
  env.twitchClientId = null;
  env.twitchClientSecret = null;

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ai/game-recommendations`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer fake-access-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: 'route success wrapper test',
          platforms: ['PC', 'Nintendo Switch'],
          preferredGenres: ['Simulation', 'Adventure'],
          excludedGameIds: [123, 456],
          limit: 100
        })
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.match(payload.data.requestId, /^ai-rec-/);
      assert.ok(Array.isArray(payload.data.items));
      assert.ok(payload.data.items.length <= 10);
      assert.ok(payload.data.items.every((item) => typeof item.gameId === 'number'));
      assert.ok(payload.data.items.every((item) => ![123, 456].includes(item.gameId)));
      assert.equal(payload.data.disclaimer, 'AI 추천은 참고용이며 실제 취향과 다를 수 있습니다.');
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
    prisma.$transaction = originalTransaction;
    prisma.aiRecommendationLog.create = originalCreate;
    env.llmApiKey = originalApiKey;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
  }
});
