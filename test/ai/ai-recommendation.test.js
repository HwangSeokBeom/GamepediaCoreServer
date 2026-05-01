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
const { rankCandidateDetails, rankCandidates } = require('../../src/modules/recommendation/recommendation-ranker');
const {
  buildPreferenceProfileFromData
} = require('../../src/modules/recommendation/user-personalization.service');
const {
  normalizeLimit,
  validateLlmReviewSummaryResponse,
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
    personalization: true,
    includeOwned: false,
    includeReviewed: true,
    includeFavorites: false,
    limit: 10
  });

  assert.equal(parsed.query, '퇴근하고 30분 정도 할 수 있는 힐링 게임 추천해줘');
  assert.deepEqual(parsed.platforms, ['PC', 'Nintendo Switch']);
  assert.deepEqual(parsed.preferredGenres, ['Simulation', 'Adventure']);
  assert.deepEqual(parsed.excludedGameIds, [123, '456']);
  assert.equal(parsed.personalization, true);
  assert.equal(parsed.includeOwned, false);
  assert.equal(parsed.includeReviewed, true);
  assert.equal(parsed.includeFavorites, false);
  assert.equal(parsed.limit, 10);
});

test('AI request validation rejects invalid payloads', () => {
  assert.throws(() => aiGameRecommendationRequestSchema.parse({
    query: '',
    limit: -1
  }));
});

test('AI review summary validator accepts the iOS response contract', () => {
  const summary = validateLlmReviewSummaryResponse({
    rawContent: JSON.stringify({
      summary: '플레이어들은 짧게 즐기기 좋은 진행과 편안한 분위기를 장점으로 언급합니다.',
      highlights: ['짧은 세션', '편안한 분위기'],
      pros: ['짧은 플레이 세션', '편안한 분위기'],
      cons: ['콘텐츠 양은 제한적일 수 있음']
    }),
    reviewCount: 3
  });

  assert.equal(summary.summary, '플레이어들은 짧게 즐기기 좋은 진행과 편안한 분위기를 장점으로 언급합니다.');
  assert.equal(summary.reviewCount, 3);
  assert.deepEqual(summary.highlights, ['짧은 세션', '편안한 분위기']);
  assert.deepEqual(summary.pros, ['짧은 플레이 세션', '편안한 분위기']);
});

test('AI review summary validator parses fenced and mixed JSON responses', () => {
  const fenced = validateLlmReviewSummaryResponse({
    rawContent: '```json\n{ "summary": "코드블럭 JSON도 처리합니다.", "highlights": [] }\n```',
    reviewCount: 3
  });
  const mixed = validateLlmReviewSummaryResponse({
    rawContent: '요약입니다.\n{ "summary": "설명 텍스트 사이 JSON도 처리합니다.", "pros": ["장점"], "cons": [] }\n감사합니다.',
    reviewCount: 4
  });

  assert.equal(fenced.summary, '코드블럭 JSON도 처리합니다.');
  assert.equal(mixed.summary, '설명 텍스트 사이 JSON도 처리합니다.');
  assert.deepEqual(mixed.pros, ['장점']);
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

test('personalization profile is empty but usable without user data', () => {
  const profile = buildPreferenceProfileFromData({
    userId: '00000000-0000-0000-0000-000000000000'
  });

  assert.equal(profile.personalizationAvailable, false);
  assert.deepEqual(profile.likedGameIds, []);
  assert.deepEqual(profile.reviewedGameIds, []);
  assert.deepEqual(profile.playedGameIds, []);
  assert.deepEqual(profile.topGenres, []);
});

test('high-rated and favorite genre overlap boosts similar candidates', () => {
  const profile = buildPreferenceProfileFromData({
    userId: '00000000-0000-0000-0000-000000000000',
    favorites: [{ gameId: '900', createdAt: new Date('2026-01-01T00:00:00Z') }],
    reviews: [{
      gameId: '901',
      rating: 5,
      content: '힐링되고 농장 운영이 좋았습니다.',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z')
    }],
    metadataByGameId: new Map([
      ['900', { gameId: '900', title: 'Liked Farm', genres: ['Simulation'], platforms: ['PC'] }],
      ['901', { gameId: '901', title: 'Great Farm', genres: ['Simulation'], platforms: ['PC'] }]
    ])
  });
  const ranked = rankCandidateDetails({
    candidates: sampleCandidates,
    query: '추천',
    personalizationProfile: profile
  });

  assert.equal(ranked[0].candidate.gameId, '100');
  assert.ok(ranked[0].personalizationSignals.includes('highRatedGenreMatch'));
  assert.ok(ranked[0].scoreBreakdown.personalization > 0);
});

test('low-rated genre overlap applies a personalization penalty', () => {
  const profile = buildPreferenceProfileFromData({
    userId: '00000000-0000-0000-0000-000000000000',
    reviews: [{
      gameId: '902',
      rating: 1.5,
      content: '전략 장르는 너무 피곤했습니다.',
      createdAt: new Date('2026-01-03T00:00:00Z'),
      updatedAt: new Date('2026-01-03T00:00:00Z')
    }],
    metadataByGameId: new Map([
      ['902', { gameId: '902', title: 'Bad Strategy', genres: ['Strategy'], platforms: ['PC'] }]
    ])
  });
  const ranked = rankCandidateDetails({
    candidates: sampleCandidates,
    query: '추천',
    personalizationProfile: profile
  });
  const strategyCandidate = ranked.find((item) => item.candidate.gameId === '200');

  assert.ok(strategyCandidate.personalizationSignals.includes('lowRatedGenrePenalty'));
  assert.ok(strategyCandidate.scoreBreakdown.negativePersonalization > 0);
  assert.notEqual(ranked[0].candidate.gameId, '200');
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
        { gameId: '100', reason: '좋은 후보입니다.'.repeat(20), matchTags: ['relaxing visual novel', 'ShortInteractiveStory', 'Visual Novel', 'single_player', 'low'], confidence: 1.5 },
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
  assert.deepEqual(validated.items[0].rawMatchTags, ['relaxing visual novel', 'ShortInteractiveStory', 'Visual Novel', 'single_player', 'low']);
  assert.deepEqual(validated.items[0].canonicalTags, ['relaxing_visual_novel', 'short_interactive_story', 'visual_novel', 'singleplayer', 'low_difficulty']);
  assert.deepEqual(validated.items[0].matchTags, validated.items[0].canonicalTags);
  assert.deepEqual(validated.items[0].displayTags, ['Relaxing Visual Novel', 'Short Interactive Story', 'Visual Novel', 'Singleplayer', 'Low Difficulty']);
  assert.ok(validated.items[1].reason.length > 0);
  assert.ok(validated.items[1].matchTags.length > 0);
  assert.ok(validated.items[1].canonicalTags.length > 0);
  assert.ok(validated.items[1].displayTags.every((tag) => !/[가-힣]/.test(tag)));
});

test('recommendation fallback items keep stable normalized tag schema', () => {
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
  assert.ok(validated.items.length > 0);
  assert.ok(validated.items.every((item) => Array.isArray(item.rawMatchTags)));
  assert.ok(validated.items.every((item) => Array.isArray(item.canonicalTags) && item.canonicalTags.length > 0));
  assert.ok(validated.items.every((item) => item.matchTags.every((tag) => /^[a-z0-9_]+$/.test(tag))));
  assert.ok(validated.items.every((item) => item.displayTags.every((tag) => !/[가-힣]/.test(tag))));
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
      retryCount: 0,
      maxTokens: 500
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
    assert.equal(requestBody.max_tokens, 500);
    assert.equal(requestBody.response_format, undefined);
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

test('LLM client sanitizes provider error bodies before logging', () => {
  const sanitized = aiClient.sanitizeLLMErrorBody({
    error: 'bad request Bearer abc.def-456',
    authorization: 'Bearer abc.def-123',
    api_key: 'secret-key',
    access_token: 'access-secret',
    refresh_token: 'refresh-secret'
  });

  assert.match(sanitized, /Bearer <redacted>/);
  assert.match(sanitized, /"apiKey":"<redacted>"/);
  assert.match(sanitized, /"authorization":"<redacted>"/);
  assert.match(sanitized, /"accessToken":"<redacted>"/);
  assert.match(sanitized, /"refreshToken":"<redacted>"/);
  assert.doesNotMatch(sanitized, /secret-key|access-secret|refresh-secret|abc\.def-123|abc\.def-456/);
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

test('LLM client falls back on provider timeouts', async () => {
  const originalFetch = global.fetch;
  const originalProvider = env.llmProvider;
  const originalApiKey = env.llmApiKey;
  const originalBaseUrl = env.llmBaseUrl;
  const originalModel = env.llmModel;
  const originalTimeoutMs = env.llmTimeoutMs;
  let abortObserved = false;

  env.llmProvider = 'openai';
  env.llmApiKey = 'test-key';
  env.llmBaseUrl = 'https://api.openai.com/v1';
  env.llmModel = 'gpt-4o-mini';
  env.llmTimeoutMs = 1;
  global.fetch = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      abortObserved = true;
      reject(new Error('aborted'));
    });
  });

  try {
    const response = await aiClient.createChatCompletion({
      systemPrompt: 'system',
      userPrompt: '{}',
      retryCount: 0
    });

    assert.equal(abortObserved, true);
    assert.equal(response.skipped, true);
    assert.equal(response.model, 'mock-rule-based');
  } finally {
    global.fetch = originalFetch;
    env.llmProvider = originalProvider;
    env.llmApiKey = originalApiKey;
    env.llmBaseUrl = originalBaseUrl;
    env.llmModel = originalModel;
    env.llmTimeoutMs = originalTimeoutMs;
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
      personalization: false,
      limit: 10
    });

    assert.match(response.requestId, /^ai-rec-/);
    assert.equal(response.disclaimer, 'AI 추천은 참고용이며 실제 취향과 다를 수 있습니다.');
    assert.ok(response.items.length > 0);
    assert.ok(response.items.every((item) => !['123', '456'].includes(String(item.gameId))));
    assert.ok(response.items.every((item) => Array.isArray(item.rawMatchTags)));
    assert.ok(response.items.every((item) => Array.isArray(item.canonicalTags) && item.canonicalTags.length > 0));
    assert.ok(response.items.every((item) => item.matchTags.every((tag) => /^[a-z0-9_]+$/.test(tag))));
    assert.ok(response.items.every((item) => item.displayTags.every((tag) => !/[가-힣]/.test(tag))));
  } finally {
    env.llmApiKey = originalApiKey;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
    prisma.aiRecommendationLog.create = originalCreate;
  }
});

test('service succeeds with personalization enabled when the user has no profile data', async () => {
  const originalApiKey = env.llmApiKey;
  const originalTwitchClientId = env.twitchClientId;
  const originalTwitchClientSecret = env.twitchClientSecret;
  const originalCacheTtlSeconds = env.aiRecommendationCacheTtlSeconds;
  const originalCreate = prisma.aiRecommendationLog.create;
  const originalFavoriteFindMany = prisma.favoriteGame.findMany;
  const originalReviewFindMany = prisma.review.findMany;
  const originalLibraryFindMany = prisma.userGameLibrary.findMany;
  const originalMappingFindMany = prisma.steamIgdbMapping.findMany;

  env.llmApiKey = null;
  env.twitchClientId = null;
  env.twitchClientSecret = null;
  env.aiRecommendationCacheTtlSeconds = 0;
  prisma.aiRecommendationLog.create = async () => ({ id: 'log-id' });
  prisma.favoriteGame.findMany = async () => [];
  prisma.review.findMany = async () => [];
  prisma.userGameLibrary.findMany = async () => [];
  prisma.steamIgdbMapping.findMany = async () => [];

  try {
    const response = await aiService.createGameRecommendations({
      userId: '00000000-0000-0000-0000-000000000000',
      query: '짧게 즐길 인디 게임',
      platforms: ['PC'],
      preferredGenres: ['Indie'],
      excludedGameIds: [],
      personalization: true,
      limit: 5
    });

    assert.ok(response.items.length > 0);
    assert.equal(response.meta.personalizationAvailable, false);
    assert.equal(response.meta.personalizationUsed, false);
    assert.equal(response.meta.fallbackUsed, true);
    assert.equal(response.meta.source, 'rule_based_fallback');
    assert.ok(response.items.every((item) => item.source === 'rule_based'));
    assert.ok(response.items.every((item) => Array.isArray(item.canonicalTags) && item.canonicalTags.length > 0));
  } finally {
    env.llmApiKey = originalApiKey;
    env.twitchClientId = originalTwitchClientId;
    env.twitchClientSecret = originalTwitchClientSecret;
    env.aiRecommendationCacheTtlSeconds = originalCacheTtlSeconds;
    prisma.aiRecommendationLog.create = originalCreate;
    prisma.favoriteGame.findMany = originalFavoriteFindMany;
    prisma.review.findMany = originalReviewFindMany;
    prisma.userGameLibrary.findMany = originalLibraryFindMany;
    prisma.steamIgdbMapping.findMany = originalMappingFindMany;
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
      personalization: false,
      limit: 10
    });

    assert.match(response.requestId, /^ai-rec-/);
    assert.ok(response.items.length > 0);
    assert.ok(response.items.every((item) => Array.isArray(item.rawMatchTags)));
    assert.ok(response.items.every((item) => Array.isArray(item.canonicalTags) && item.canonicalTags.length > 0));
    assert.ok(response.items.every((item) => item.matchTags.every((tag) => /^[a-z0-9_]+$/.test(tag))));
    assert.ok(response.items.every((item) => item.displayTags.every((tag) => !/[가-힣]/.test(tag))));
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
      personalization: false,
      limit: 5
    });

    assert.deepEqual(response.items.map((item) => item.gameId), [17000, 132181]);
    assert.deepEqual(response.items[0].canonicalTags.slice(0, 2), ['relaxing', 'short_session']);
    assert.deepEqual(response.items[0].matchTags, response.items[0].canonicalTags);
    assert.ok(response.items[0].displayTags.every((tag) => !/[가-힣]/.test(tag)));
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

test('AI review summary route is registered at GET /api/v1/ai/games/:gameId/review-summary', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/ai/games/245754/review-summary`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'UNAUTHORIZED');
    assert.doesNotMatch(payload.error.message, /Route GET|was not found/);
  });
});

test('AI review summary route returns 200 with a fixed empty DTO when a game has no reviews', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;
  const originalReviewFindMany = prisma.review.findMany;
  const originalReviewAggregate = prisma.review.aggregate;

  tokenService.verifyAccessToken = () => ({
    type: 'access',
    sub: '00000000-0000-0000-0000-000000000000'
  });
  prisma.user.findUnique = async () => ({
    id: '00000000-0000-0000-0000-000000000000',
    email: 'test@example.com',
    status: 'ACTIVE'
  });
  prisma.review.findMany = async () => [];
  prisma.review.aggregate = async () => ({
    _count: { id: 0 },
    _avg: { rating: null }
  });

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ai/games/245754/review-summary`, {
        headers: {
          Authorization: 'Bearer fake-access-token'
        }
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.gameId, '245754');
      assert.equal(payload.data.status, 'empty');
      assert.equal(payload.data.reason, 'NO_REVIEWS');
      assert.equal(payload.data.reviewCount, 0);
      assert.equal(payload.data.fallbackUsed, false);
      assert.equal(payload.data.summary, '아직 요약할 리뷰가 없어요.');
      assert.deepEqual(payload.data.highlights, []);
      assert.deepEqual(payload.data.pros, []);
      assert.deepEqual(payload.data.cons, []);
      assert.match(payload.data.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
    prisma.review.findMany = originalReviewFindMany;
    prisma.review.aggregate = originalReviewAggregate;
  }
});

test('AI review summary route returns insufficient reviews DTO without calling LLM', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;
  const originalReviewFindMany = prisma.review.findMany;
  const originalReviewAggregate = prisma.review.aggregate;
  const originalCreateChatCompletion = aiClient.createChatCompletion;
  let llmCalled = false;

  tokenService.verifyAccessToken = () => ({
    type: 'access',
    sub: '00000000-0000-0000-0000-000000000000'
  });
  prisma.user.findUnique = async () => ({
    id: '00000000-0000-0000-0000-000000000000',
    email: 'test@example.com',
    status: 'ACTIVE'
  });
  prisma.review.findMany = async () => [
    {
      id: 'review-1',
      rating: 5,
      content: '짧게 즐기기 좋습니다.',
      createdAt: new Date()
    },
    {
      id: 'review-2',
      rating: 4,
      content: '분위기가 편안합니다.',
      createdAt: new Date()
    }
  ];
  prisma.review.aggregate = async () => ({
    _count: { id: 2 },
    _avg: { rating: 4.5 }
  });
  aiClient.createChatCompletion = async () => {
    llmCalled = true;
    return { content: null, skipped: true };
  };

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ai/games/245754/review-summary`, {
        headers: {
          Authorization: 'Bearer fake-access-token'
        }
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.gameId, '245754');
      assert.equal(payload.data.status, 'empty');
      assert.equal(payload.data.reason, 'INSUFFICIENT_REVIEWS');
      assert.equal(payload.data.reviewCount, 2);
      assert.equal(payload.data.fallbackUsed, false);
      assert.equal(payload.data.summary, '아직 AI 요약을 만들기에는 리뷰가 조금 부족해요.');
      assert.deepEqual(payload.data.highlights, []);
      assert.deepEqual(payload.data.pros, []);
      assert.deepEqual(payload.data.cons, []);
      assert.equal(llmCalled, false);
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
    prisma.review.findMany = originalReviewFindMany;
    prisma.review.aggregate = originalReviewAggregate;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});

test('AI review summary route returns a fixed iOS-decodable DTO when LLM succeeds', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;
  const originalReviewFindMany = prisma.review.findMany;
  const originalReviewAggregate = prisma.review.aggregate;
  const originalCreateChatCompletion = aiClient.createChatCompletion;

  tokenService.verifyAccessToken = () => ({
    type: 'access',
    sub: '00000000-0000-0000-0000-000000000000'
  });
  prisma.user.findUnique = async () => ({
    id: '00000000-0000-0000-0000-000000000000',
    email: 'test@example.com',
    status: 'ACTIVE'
  });
  prisma.review.findMany = async () => [
    {
      id: 'review-1',
      rating: 5,
      content: '짧게 즐기기 좋고 분위기가 편안합니다.',
      createdAt: new Date()
    },
    {
      id: 'review-2',
      rating: 4,
      content: '진입 장벽이 낮아서 부담이 적었습니다.',
      createdAt: new Date()
    },
    {
      id: 'review-3',
      rating: 4,
      content: '친구에게 추천할 만큼 만족스러웠습니다.',
      createdAt: new Date()
    },
    {
      id: 'review-4',
      rating: 5,
      content: '기대보다 오래 즐길 수 있었습니다.',
      createdAt: new Date()
    },
    {
      id: 'review-5',
      rating: 4.5,
      content: '전반적으로 만족도가 높았습니다.',
      createdAt: new Date()
    }
  ];
  prisma.review.aggregate = async () => ({
    _count: { id: 5 },
    _avg: { rating: 4.7 }
  });
  aiClient.createChatCompletion = async () => ({
    content: JSON.stringify({
      summary: '플레이어들은 부담 없는 진행과 편안한 분위기를 주로 장점으로 언급합니다.',
      highlights: ['부담 없는 진행', '편안한 분위기'],
      pros: ['짧은 플레이 세션', '편안한 분위기'],
      cons: []
    }),
    model: 'test-model',
    promptTokens: 12,
    completionTokens: 8,
    skipped: false
  });

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ai/games/328386/review-summary`, {
        headers: {
          Authorization: 'Bearer fake-access-token'
        }
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.gameId, '328386');
      assert.equal(payload.data.status, 'success');
      assert.equal(payload.data.reason, null);
      assert.equal(payload.data.reviewCount, 5);
      assert.equal(payload.data.fallbackUsed, false);
      assert.equal(payload.data.summary, '플레이어들은 부담 없는 진행과 편안한 분위기를 주로 장점으로 언급합니다.');
      assert.deepEqual(payload.data.highlights, ['부담 없는 진행', '편안한 분위기']);
      assert.deepEqual(payload.data.pros, ['짧은 플레이 세션', '편안한 분위기']);
      assert.deepEqual(payload.data.cons, []);
      assert.match(payload.data.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
    prisma.review.findMany = originalReviewFindMany;
    prisma.review.aggregate = originalReviewAggregate;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});

test('AI review summary route always returns fallback summary with fixed DTO when LLM is unavailable', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;
  const originalReviewFindMany = prisma.review.findMany;
  const originalReviewAggregate = prisma.review.aggregate;
  const originalCreateChatCompletion = aiClient.createChatCompletion;

  tokenService.verifyAccessToken = () => ({
    type: 'access',
    sub: '00000000-0000-0000-0000-000000000000'
  });
  prisma.user.findUnique = async () => ({
    id: '00000000-0000-0000-0000-000000000000',
    email: 'test@example.com',
    status: 'ACTIVE'
  });
  prisma.review.findMany = async () => [
    {
      id: 'review-1',
      rating: 5,
      content: '가볍게 하기 좋고 조작이 쉽습니다.',
      createdAt: new Date()
    },
    {
      id: 'review-2',
      rating: 2,
      content: '콘텐츠가 조금 부족하게 느껴졌습니다.',
      createdAt: new Date()
    },
    {
      id: 'review-3',
      rating: 4,
      content: '취향에 맞으면 계속 손이 갑니다.',
      createdAt: new Date()
    }
  ];
  prisma.review.aggregate = async () => ({
    _count: { id: 3 },
    _avg: { rating: 3.7 }
  });
  aiClient.createChatCompletion = async () => ({
    content: null,
    model: 'mock-rule-based',
    promptTokens: 0,
    completionTokens: 0,
    skipped: true
  });

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ai/games/376092/review-summary`, {
        headers: {
          Authorization: 'Bearer fake-access-token'
        }
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.gameId, '376092');
      assert.equal(payload.data.status, 'fallback');
      assert.equal(payload.data.reason, 'AI_SUMMARY_UNAVAILABLE');
      assert.equal(payload.data.reviewCount, 3);
      assert.equal(payload.data.fallbackUsed, true);
      assert.equal(payload.data.summary, 'AI 요약을 일시적으로 생성하지 못했어요. 등록된 리뷰를 기준으로 다시 시도할 수 있습니다.');
      assert.deepEqual(payload.data.highlights, []);
      assert.deepEqual(payload.data.pros, []);
      assert.deepEqual(payload.data.cons, []);
      assert.match(payload.data.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
    prisma.review.findMany = originalReviewFindMany;
    prisma.review.aggregate = originalReviewAggregate;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});

test('unknown routes return a normalized JSON not found envelope', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/ai/games/245754/missing-route`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'NOT_FOUND');
    assert.equal(payload.error.message, '요청한 리소스를 찾을 수 없습니다.');
    assert.doesNotMatch(payload.error.message, /Route GET|was not found/);
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
      assert.ok(payload.data.items.every((item) => Array.isArray(item.rawMatchTags)));
      assert.ok(payload.data.items.every((item) => Array.isArray(item.canonicalTags) && item.canonicalTags.length > 0));
      assert.ok(payload.data.items.every((item) => item.matchTags.every((tag) => /^[a-z0-9_]+$/.test(tag))));
      assert.ok(payload.data.items.every((item) => item.displayTags.every((tag) => !/[가-힣]/.test(tag))));
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
