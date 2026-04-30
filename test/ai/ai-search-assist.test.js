const test = require('node:test');
const assert = require('node:assert/strict');
const tokenService = require('../../src/services/token.service');
const { app } = require('../../src/app');
const { AppError } = require('../../src/utils/error-response');
const { env } = require('../../src/config/env');
const { prisma } = require('../../src/config/prisma');
const { aiSearchAssistRequestSchema } = require('../../src/modules/ai/ai-search-assist.schema');
const aiClient = require('../../src/modules/ai/ai.client');
const aiSearchAssistService = require('../../src/modules/ai/ai-search-assist.service');
const {
  normalizeLimit,
  validateLlmSearchAssistResponse
} = require('../../src/modules/ai/ai-search-assist.validator');

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

function fallbackContext() {
  return {
    query: '퇴근 후 30분 힐링 게임',
    platforms: ['PC', 'Nintendo Switch'],
    genres: ['Simulation', 'Adventure']
  };
}

test('AI search assist request validation accepts the public request contract', () => {
  const parsed = aiSearchAssistRequestSchema.parse({
    query: '퇴근 후 30분 정도 할 수 있는 힐링 게임',
    platforms: ['PC', 'Nintendo Switch'],
    genres: ['Simulation', 'Adventure'],
    limit: 10
  });

  assert.equal(parsed.query, '퇴근 후 30분 정도 할 수 있는 힐링 게임');
  assert.deepEqual(parsed.platforms, ['PC', 'Nintendo Switch']);
  assert.deepEqual(parsed.genres, ['Simulation', 'Adventure']);
  assert.equal(parsed.limit, 10);
});

test('AI search assist request validation rejects missing or short query', () => {
  assert.throws(() => aiSearchAssistRequestSchema.parse({
    platforms: ['PC']
  }));
  assert.throws(() => aiSearchAssistRequestSchema.parse({
    query: 'a'
  }));
});

test('AI search assist normalizeLimit clamps to the 5-20 range', () => {
  assert.equal(normalizeLimit(1), 5);
  assert.equal(normalizeLimit(12), 12);
  assert.equal(normalizeLimit(100), 20);
});

test('AI search assist cache key is scoped by userId query platforms genres and limit', () => {
  const firstKey = aiSearchAssistService.buildCacheKey({
    userId: 'user-a',
    query: '힐링 게임',
    platforms: ['PC'],
    genres: ['Simulation'],
    limit: 10
  });
  const secondKey = aiSearchAssistService.buildCacheKey({
    userId: 'user-b',
    query: '힐링 게임',
    platforms: ['PC'],
    genres: ['Simulation'],
    limit: 10
  });
  const thirdKey = aiSearchAssistService.buildCacheKey({
    userId: 'user-a',
    query: '힐링 게임',
    platforms: ['Nintendo Switch'],
    genres: ['Simulation'],
    limit: 10
  });
  const fourthKey = aiSearchAssistService.buildCacheKey({
    userId: 'user-a',
    query: '힐링 게임',
    platforms: ['PC'],
    genres: ['Adventure'],
    limit: 10
  });
  const fifthKey = aiSearchAssistService.buildCacheKey({
    userId: 'user-a',
    query: '힐링 게임',
    platforms: ['PC'],
    genres: ['Simulation'],
    limit: 20
  });

  assert.notEqual(firstKey, secondKey);
  assert.notEqual(firstKey, thirdKey);
  assert.notEqual(firstKey, fourthKey);
  assert.notEqual(firstKey, fifthKey);
});

test('AI search assist validator removes outside and duplicate gameIds and repairs empty fields', () => {
  const validated = validateLlmSearchAssistResponse({
    rawContent: JSON.stringify({
      normalizedQuery: '',
      intent: {
        mood: ['relaxing'],
        unknownKey: ['must be removed']
      },
      suggestedQueries: ['짧게 즐기는 힐링 게임', 'a', '친구랑 같이 할 수 있는 스위치 게임', '스위치 감성 어드벤처 게임', '입문하기 좋은 로그라이크', '초과 제안'],
      items: [
        { gameId: '999', matchReason: '후보 밖 게임', matchTags: ['제거'], confidence: 2 },
        { gameId: '100', matchReason: '', matchTags: [], confidence: 2 },
        { gameId: '100', matchReason: '중복', matchTags: ['중복'], confidence: 0.1 },
        { gameId: '300', matchReason: '좋은 후보입니다.'.repeat(20), matchTags: ['퍼즐', '퍼즐', '짧은 세션', '스위치', '초과'], confidence: -1 }
      ]
    }),
    candidates: sampleCandidates,
    limit: 5,
    fallbackContext: fallbackContext()
  });

  assert.equal(validated.source, 'llm');
  assert.deepEqual(validated.items.map((item) => item.gameId), ['100', '300']);
  assert.equal(validated.items[0].confidence, 1);
  assert.equal(validated.items[1].confidence, 0);
  assert.ok(validated.items[0].matchReason.length > 0);
  assert.ok(validated.items[0].matchTags.length > 0);
  assert.ok(validated.items[1].matchReason.length <= 160);
  assert.ok(validated.items[1].matchTags.length <= 4);
  assert.equal(validated.intent.unknownKey, undefined);
  assert.ok(validated.suggestedQueries.length <= 5);
  assert.ok(validated.suggestedQueries.every((query) => query.length >= 2 && query.length <= 60));
});

test('AI search assist validator uses fallback ranking on invalid JSON', () => {
  const validated = validateLlmSearchAssistResponse({
    rawContent: 'not-json',
    candidates: sampleCandidates,
    limit: 2,
    fallbackContext: fallbackContext()
  });

  assert.equal(validated.source, 'fallback');
  assert.ok(validated.items.length <= 5);
  assert.equal(validated.items[0].gameId, '100');
  assert.ok(validated.suggestedQueries.length > 0);
});

test('AI search assist daily usage limit throws AI_SEARCH_DAILY_LIMIT_EXCEEDED', async () => {
  const originalTransaction = prisma.$transaction;
  const originalLimit = env.aiSearchDailyLimit;

  env.aiSearchDailyLimit = 1;
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ searchAssistCount: 2 })
    }
  });

  try {
    await assert.rejects(
      () => aiSearchAssistService.assertAndIncrementDailyUsage({ userId: '00000000-0000-0000-0000-000000000000' }),
      (error) => error instanceof AppError && error.code === 'AI_SEARCH_DAILY_LIMIT_EXCEEDED'
    );
  } finally {
    prisma.$transaction = originalTransaction;
    env.aiSearchDailyLimit = originalLimit;
  }
});

test('AI search assist logging stores expected fields', async () => {
  const originalCreate = prisma.aiSearchLog.create;
  let storedPayload = null;

  prisma.aiSearchLog.create = async (payload) => {
    storedPayload = payload;
    return { id: 'log-id' };
  };

  try {
    await aiSearchAssistService.writeSearchLog({
      userId: '00000000-0000-0000-0000-000000000000',
      query: '힐링 게임',
      normalizedQuery: '짧게 즐길 수 있는 힐링 게임',
      intent: { mood: ['relaxing'] },
      items: [{ gameId: 100 }, { gameId: '300' }],
      model: 'mock-rule-based',
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 12,
      fallbackUsed: true
    });

    assert.equal(storedPayload.data.query, '힐링 게임');
    assert.equal(storedPayload.data.normalizedQuery, '짧게 즐길 수 있는 힐링 게임');
    assert.deepEqual(storedPayload.data.resultGameIds, [100, 300]);
    assert.equal(storedPayload.data.model, 'mock-rule-based');
    assert.equal(storedPayload.data.fallbackUsed, true);
    assert.equal(storedPayload.data.latencyMs, 12);
  } finally {
    prisma.aiSearchLog.create = originalCreate;
  }
});

test('AI search assist service returns fallback success without an LLM API key', async () => {
  const originalApiKey = env.llmApiKey;
  const originalTwitchClientId = env.twitchClientId;
  const originalTwitchClientSecret = env.twitchClientSecret;
  const originalCacheTtlSeconds = env.aiSearchCacheTtlSeconds;
  const originalCreate = prisma.aiSearchLog.create;

  env.llmApiKey = null;
  env.twitchClientId = null;
  env.twitchClientSecret = null;
  env.aiSearchCacheTtlSeconds = 0;
  prisma.aiSearchLog.create = async () => ({ id: 'log-id' });

  try {
    const response = await aiSearchAssistService.createSearchAssist({
      userId: '00000000-0000-0000-0000-000000000000',
      query: '퇴근 후 30분 정도 할 수 있는 힐링 게임',
      platforms: ['PC', 'Nintendo Switch'],
      genres: ['Simulation', 'Adventure'],
      limit: 10
    });

    assert.match(response.requestId, /^ai-search-/);
    assert.equal(response.originalQuery, '퇴근 후 30분 정도 할 수 있는 힐링 게임');
    assert.equal(response.fallbackUsed, true);
    assert.ok(response.items.length > 0);
    assert.equal(response.disclaimer, 'AI 검색 보조 결과는 참고용이며 실제 검색 결과와 다를 수 있습니다.');
  } finally {
    env.llmApiKey = originalApiKey;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
    env.aiSearchCacheTtlSeconds = originalCacheTtlSeconds;
    prisma.aiSearchLog.create = originalCreate;
  }
});

test('AI search assist service returns fallback success when LLM returns invalid JSON', async () => {
  const originalApiKey = env.llmApiKey;
  const originalTwitchClientId = env.twitchClientId;
  const originalTwitchClientSecret = env.twitchClientSecret;
  const originalCacheTtlSeconds = env.aiSearchCacheTtlSeconds;
  const originalCreate = prisma.aiSearchLog.create;
  const originalCreateChatCompletion = aiClient.createChatCompletion;
  let storedPayload = null;

  env.llmApiKey = 'test-key';
  env.twitchClientId = null;
  env.twitchClientSecret = null;
  env.aiSearchCacheTtlSeconds = 0;
  prisma.aiSearchLog.create = async (payload) => {
    storedPayload = payload;
    return { id: 'log-id' };
  };
  aiClient.createChatCompletion = async () => ({
    content: '{invalid',
    model: 'gpt-4o-mini',
    promptTokens: 10,
    completionTokens: 5,
    skipped: false
  });

  try {
    const response = await aiSearchAssistService.createSearchAssist({
      userId: '00000000-0000-0000-0000-000000000000',
      query: 'invalid search assist fallback test',
      platforms: ['PC'],
      genres: ['Simulation'],
      limit: 10
    });

    assert.equal(response.fallbackUsed, true);
    assert.ok(response.items.length > 0);
    assert.equal(storedPayload.data.model, 'mock-rule-based');
    assert.equal(storedPayload.data.promptTokens, 0);
    assert.equal(storedPayload.data.completionTokens, 0);
    assert.equal(storedPayload.data.fallbackUsed, true);
  } finally {
    env.llmApiKey = originalApiKey;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
    env.aiSearchCacheTtlSeconds = originalCacheTtlSeconds;
    prisma.aiSearchLog.create = originalCreate;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});

test('AI search assist route requires access token at POST /api/v1/ai/search-assist', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/ai/search-assist`, {
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

test('AI search assist route returns validation errors for missing query and malformed JSON', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;

  tokenService.verifyAccessToken = () => ({
    type: 'access',
    sub: '00000000-0000-0000-0000-000000000000'
  });
  prisma.user.findUnique = async () => ({
    id: '00000000-0000-0000-0000-000000000000',
    email: 'test@example.com',
    status: 'ACTIVE'
  });

  try {
    await withTestServer(async (baseUrl) => {
      const validationResponse = await fetch(`${baseUrl}/api/v1/ai/search-assist`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer fake-access-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ limit: 10 })
      });
      const malformedResponse = await fetch(`${baseUrl}/api/v1/ai/search-assist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid-json'
      });
      const validationPayload = await validationResponse.json();
      const malformedPayload = await malformedResponse.json();

      assert.equal(validationResponse.status, 400);
      assert.equal(validationPayload.error.code, 'VALIDATION_FAILED');
      assert.equal(malformedResponse.status, 400);
      assert.equal(malformedPayload.error.code, 'VALIDATION_FAILED');
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
  }
});

test('AI search assist route returns wrapped success response and clamps limit 100 to at most 20 items', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;
  const originalApiKey = env.llmApiKey;
  const originalTwitchClientId = env.twitchClientId;
  const originalTwitchClientSecret = env.twitchClientSecret;
  const originalCacheTtlSeconds = env.aiSearchCacheTtlSeconds;
  const originalCreate = prisma.aiSearchLog.create;

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
      upsert: async () => ({ searchAssistCount: 1 })
    }
  });
  prisma.aiSearchLog.create = async () => ({ id: 'log-id' });
  env.llmApiKey = null;
  env.twitchClientId = null;
  env.twitchClientSecret = null;
  env.aiSearchCacheTtlSeconds = 0;

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ai/search-assist`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer fake-access-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: 'route search assist success wrapper test',
          platforms: ['PC', 'Nintendo Switch'],
          genres: ['Simulation', 'Adventure'],
          limit: 100
        })
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.match(payload.data.requestId, /^ai-search-/);
      assert.equal(payload.data.originalQuery, 'route search assist success wrapper test');
      assert.ok(Array.isArray(payload.data.items));
      assert.ok(payload.data.items.length <= 20);
      assert.ok(payload.data.items.every((item) => typeof item.gameId === 'number'));
      assert.ok(payload.data.items.every((item) => typeof item.matchReason === 'string' && item.matchReason.length > 0));
      assert.equal(payload.data.fallbackUsed, true);
      assert.equal(payload.data.disclaimer, 'AI 검색 보조 결과는 참고용이며 실제 검색 결과와 다를 수 있습니다.');
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
    prisma.$transaction = originalTransaction;
    env.llmApiKey = originalApiKey;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
    env.aiSearchCacheTtlSeconds = originalCacheTtlSeconds;
    prisma.aiSearchLog.create = originalCreate;
  }
});

test('AI search assist route maps daily limit errors to AI_SEARCH_DAILY_LIMIT_EXCEEDED', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;
  const originalLimit = env.aiSearchDailyLimit;

  tokenService.verifyAccessToken = () => ({
    type: 'access',
    sub: '00000000-0000-0000-0000-000000000000'
  });
  prisma.user.findUnique = async () => ({
    id: '00000000-0000-0000-0000-000000000000',
    email: 'test@example.com',
    status: 'ACTIVE'
  });
  env.aiSearchDailyLimit = 1;
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ searchAssistCount: 2 })
    }
  });

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ai/search-assist`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer fake-access-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: 'daily limit route test',
          limit: 10
        })
      });
      const payload = await response.json();

      assert.equal(response.status, 429);
      assert.equal(payload.success, false);
      assert.equal(payload.error.code, 'AI_SEARCH_DAILY_LIMIT_EXCEEDED');
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
    prisma.$transaction = originalTransaction;
    env.aiSearchDailyLimit = originalLimit;
  }
});
