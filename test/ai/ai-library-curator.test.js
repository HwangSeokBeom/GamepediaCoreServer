const test = require('node:test');
const assert = require('node:assert/strict');
const tokenService = require('../../src/services/token.service');
const { app } = require('../../src/app');
const { env } = require('../../src/config/env');
const { prisma } = require('../../src/config/prisma');
const aiClient = require('../../src/modules/ai/ai.client');
const {
  libraryCuratorRequestSchema
} = require('../../src/modules/ai/ai-library-curator.schema');
const {
  buildLlmCandidatePayload,
  createLibraryCuratorRecommendation
} = require('../../src/modules/ai/ai-library-curator.service');
const {
  validateLlmLibraryCuratorResponse
} = require('../../src/modules/ai/ai-library-curator.validator');

const USER_ID = '00000000-0000-0000-0000-000000000000';

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

function buildOwnedRow(overrides = {}) {
  return {
    gameSource: 'IGDB',
    externalGameId: '100',
    gameName: 'Server Library Title',
    coverUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg',
    playtimeMinutes: 240,
    lastPlayedAt: new Date('2026-04-20T00:00:00.000Z'),
    updatedAt: new Date('2026-04-21T00:00:00.000Z'),
    ...overrides
  };
}

function buildReviewRow(overrides = {}) {
  return {
    gameId: '100',
    rating: 4.5,
    content: '좋았던 점이 많고 짧게 다시 즐기기에도 괜찮았습니다. '.repeat(20),
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-02T00:00:00.000Z'),
    ...overrides
  };
}

async function withLibraryCuratorStubs({
  libraryEntries = [buildOwnedRow()],
  favoriteRows = [{ gameId: '100', createdAt: new Date('2026-04-03T00:00:00.000Z') }],
  reviewRows = [buildReviewRow()],
  mappingRows = [],
  createChatCompletion,
  callback
}) {
  const originals = {
    apiKey: env.llmApiKey,
    twitchClientId: env.twitchClientId,
    twitchClientSecret: env.twitchClientSecret,
    cacheTtl: env.aiLibraryCuratorCacheTtlSeconds,
    logCreate: prisma.aiRecommendationLog.create,
    libraryFindMany: prisma.userGameLibrary.findMany,
    favoriteFindMany: prisma.favoriteGame.findMany,
    reviewFindMany: prisma.review.findMany,
    mappingFindMany: prisma.steamIgdbMapping.findMany,
    createChatCompletion: aiClient.createChatCompletion
  };

  env.llmApiKey = 'test-key';
  env.twitchClientId = null;
  env.twitchClientSecret = null;
  env.aiLibraryCuratorCacheTtlSeconds = 0;
  prisma.aiRecommendationLog.create = async () => ({ id: 'log-id' });
  prisma.userGameLibrary.findMany = async () => libraryEntries;
  prisma.favoriteGame.findMany = async () => favoriteRows;
  prisma.review.findMany = async () => reviewRows;
  prisma.steamIgdbMapping.findMany = async () => mappingRows;
  aiClient.createChatCompletion = createChatCompletion ?? (async () => ({
    content: null,
    model: 'mock-rule-based',
    promptTokens: 0,
    completionTokens: 0,
    skipped: true,
    skipReason: 'missing_api_key'
  }));

  try {
    return await callback();
  } finally {
    env.llmApiKey = originals.apiKey;
    env.twitchClientId = originals.twitchClientId;
    env.twitchClientSecret = originals.twitchClientSecret;
    env.aiLibraryCuratorCacheTtlSeconds = originals.cacheTtl;
    prisma.aiRecommendationLog.create = originals.logCreate;
    prisma.userGameLibrary.findMany = originals.libraryFindMany;
    prisma.favoriteGame.findMany = originals.favoriteFindMany;
    prisma.review.findMany = originals.reviewFindMany;
    prisma.steamIgdbMapping.findMany = originals.mappingFindMany;
    aiClient.createChatCompletion = originals.createChatCompletion;
  }
}

test('library curator request schema applies defaults and locale fallback', () => {
  const parsed = libraryCuratorRequestSchema.parse({
    locale: 'fr',
    excludedGameIds: [' 100 ', 200, null, '']
  });

  assert.equal(parsed.mode, 'overview');
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.locale, 'ko');
  assert.equal(parsed.candidateScope, 'mixed');
  assert.deepEqual(parsed.excludedGameIds, ['100', '200']);
  assert.throws(() => libraryCuratorRequestSchema.parse({ limit: 11 }));
  assert.throws(() => libraryCuratorRequestSchema.parse({ mode: 'anything' }));
});

test('library curator validator removes gameIds outside the server candidate set', () => {
  const validated = validateLlmLibraryCuratorResponse({
    rawContent: JSON.stringify({
      summary: {
        title: '오늘의 선택',
        body: '후보 안에서만 고릅니다.',
        bullets: ['후보 제한']
      },
      tasteProfile: {
        topGenres: ['Indie'],
        topThemes: [],
        preferredSession: 'short',
        playStyleTags: ['short_session'],
        ratingStyle: null
      },
      sections: [{
        id: 'today',
        title: '오늘',
        description: '오늘 할 게임',
        items: [
          { gameId: '999', reason: '없는 후보', matchTags: ['bad'], confidence: 0.9 },
          { gameId: '100', reason: '있는 후보', matchTags: ['good'], confidence: 1.5 },
          { gameId: '100', reason: '중복 후보', matchTags: ['dup'], confidence: 0.5 }
        ]
      }]
    }),
    candidates: [{ gameId: '100' }],
    limit: 5,
    localeText: {
      fallbackTitle: 'fallback',
      fallbackBody: 'fallback',
      sectionTitle: 'section',
      sectionDescription: 'description',
      defaultReason: 'reason'
    }
  });

  assert.equal(validated.source, 'llm');
  assert.deepEqual(validated.data.sections[0].items.map((item) => item.gameId), ['100']);
  assert.equal(validated.data.sections[0].items[0].confidence, 1);
});

test('library curator returns empty fallback when there are no candidates', async () => {
  await withLibraryCuratorStubs({
    libraryEntries: [],
    favoriteRows: [],
    reviewRows: [],
    callback: async () => {
      const response = await createLibraryCuratorRecommendation({
        userId: USER_ID,
        mode: 'overview',
        locale: 'ko',
        candidateScope: 'mixed',
        limit: 5
      });

      assert.equal(response.source, 'fallback');
      assert.equal(response.meta.fallbackReason, 'NO_CANDIDATES');
      assert.equal(response.meta.candidateCount, 0);
      assert.equal(response.meta.selectedCount, 0);
      assert.deepEqual(response.sections, []);
      assert.deepEqual(response.games, []);
    }
  });
});

test('library curator accepts valid LLM candidate gameIds and assembles game data from server candidates', async () => {
  let capturedPrompt = null;

  await withLibraryCuratorStubs({
    createChatCompletion: async ({ userPrompt }) => {
      capturedPrompt = JSON.parse(userPrompt);
      return {
        content: JSON.stringify({
          summary: {
            title: '오늘은 이 게임',
            body: '서버 후보 중에서 골랐습니다.',
            bullets: ['짧은 세션']
          },
          tasteProfile: {
            topGenres: ['Indie'],
            topThemes: [],
            preferredSession: 'short',
            playStyleTags: ['reviewed'],
            ratingStyle: '높은 평점을 주는 편'
          },
          sections: [{
            id: 'today',
            title: '오늘',
            description: '오늘 이어가기',
            items: [{
              gameId: '100',
              reason: '최근 기록과 리뷰가 좋아 오늘 다시 이어가기 좋습니다.',
              matchTags: ['recent', 'reviewed'],
              confidence: 0.88
            }]
          }]
        }),
        model: 'llama-3.1-8b-instant',
        promptTokens: 10,
        completionTokens: 5,
        skipped: false
      };
    },
    callback: async () => {
      const response = await createLibraryCuratorRecommendation({
        userId: USER_ID,
        query: '오늘 30분만 할 게임',
        mode: 'today',
        locale: 'ko',
        candidateScope: 'mixed',
        limit: 5
      });

      assert.equal(response.source, 'llm');
      assert.equal(response.meta.fallbackReason, null);
      assert.equal(response.sections[0].items[0].gameId, '100');
      assert.equal(response.games[0].gameId, '100');
      assert.equal(response.games[0].title, 'Server Library Title');
      assert.equal(response.games[0].isFavorite, true);
      assert.equal(response.games[0].hasReview, true);
      assert.equal(response.games[0].userRating, 4.5);
      assert.equal(capturedPrompt.candidateGames.length, 1);
      assert.ok(capturedPrompt.candidateGames[0].reviewExcerpt.length <= 200);
      assert.equal(capturedPrompt.candidateGames[0].title, 'Server Library Title');
    }
  });
});

test('library curator localizes Korean fallback text and supplements LLM selections to the requested limit', async () => {
  const libraryEntries = Array.from({ length: 5 }, (_, index) => buildOwnedRow({
    externalGameId: String(100 + index),
    gameName: `Server Title ${index + 1}`,
    playtimeMinutes: 100 + index * 50
  }));

  await withLibraryCuratorStubs({
    libraryEntries,
    favoriteRows: [],
    reviewRows: [],
    createChatCompletion: async () => ({
      content: JSON.stringify({
        summary: {
          title: 'Personalized Library Insight',
          body: 'Based on your gaming history, we recommend the following games:',
          bullets: ['Recommended Games']
        },
        tasteProfile: {
          topGenres: [],
          topThemes: [],
          preferredSession: 'unknown',
          playStyleTags: ['review_driven', 'short_session'],
          ratingStyle: null
        },
        sections: [{
          id: 'overview',
          title: 'Recommended Games',
          description: 'Selected from your library signals.',
          items: [
            { gameId: '999', reason: 'Outside candidate', matchTags: ['competitive'], confidence: 0.9 },
            { gameId: '100', reason: 'This candidate fits your library signals.', matchTags: ['reviewed'], confidence: 0.8 },
            { gameId: '101', reason: 'Good pick for today.', matchTags: ['played'], confidence: 0.7 },
            { gameId: '100', reason: 'Duplicate pick.', matchTags: ['reviewed'], confidence: 0.6 },
            { gameId: '102', reason: 'Worth rediscovering.', matchTags: ['high_user_rating'], confidence: 0.6 }
          ]
        }]
      }),
      model: 'llama-3.1-8b-instant',
      promptTokens: 10,
      completionTokens: 5,
      skipped: false
    }),
    callback: async () => {
      const response = await createLibraryCuratorRecommendation({
        userId: USER_ID,
        mode: 'overview',
        locale: 'ko',
        candidateScope: 'mixed',
        limit: 5
      });

      assert.equal(response.source, 'llm');
      assert.equal(response.selectedCount, 5);
      assert.equal(response.candidateCount, 5);
      assert.equal(response.items.length, 5);
      assert.equal(response.meta.validatedSelectionCount, 3);
      assert.equal(response.meta.removedOutOfScope, 1);
      assert.equal(response.meta.removedDuplicate, 1);
      assert.equal(response.meta.supplementedCount, 2);
      assert.equal(response.summary.title, '라이브러리 전체 분석');
      assert.match(response.summary.body, /보유 게임|라이브러리/);
      assert.ok(response.sections[0].items.every((item) => /[가-힣]/u.test(item.reason)));
      assert.ok(response.sections[0].items.flatMap((item) => item.matchTags).every((tag) => /[가-힣]|RPG/u.test(tag)));
      assert.deepEqual(response.items.map((item) => item.gameId).sort(), ['100', '101', '102', '103', '104']);
    }
  });
});

test('library curator reports insufficientCandidates when fewer candidates exist than requested limit', async () => {
  const libraryEntries = Array.from({ length: 3 }, (_, index) => buildOwnedRow({
    externalGameId: String(200 + index),
    gameName: `Small Pool ${index + 1}`
  }));

  await withLibraryCuratorStubs({
    libraryEntries,
    favoriteRows: [],
    reviewRows: [],
    createChatCompletion: async () => ({
      content: JSON.stringify({
        summary: {
          title: '오늘 이어가기 좋은 게임',
          body: '후보 안에서만 골랐어요.',
          bullets: ['플레이 기록을 반영했어요.']
        },
        tasteProfile: {
          topGenres: [],
          topThemes: [],
          preferredSession: 'unknown',
          playStyleTags: [],
          ratingStyle: null
        },
        sections: [{
          id: 'today',
          title: '오늘',
          description: '오늘 이어가기',
          items: [{ gameId: '200', reason: '지금 바로 이어가기 좋은 후보예요.', matchTags: ['플레이 기록'], confidence: 0.8 }]
        }]
      }),
      model: 'llama-3.1-8b-instant',
      promptTokens: 10,
      completionTokens: 5,
      skipped: false
    }),
    callback: async () => {
      const response = await createLibraryCuratorRecommendation({
        userId: USER_ID,
        mode: 'today',
        locale: 'ko',
        candidateScope: 'mixed',
        limit: 5
      });

      assert.equal(response.selectedCount, 3);
      assert.equal(response.meta.supplementedCount, 2);
      assert.equal(response.meta.insufficientCandidates, true);
      assert.deepEqual(response.items.map((item) => item.gameId).sort(), ['200', '201', '202']);
    }
  });
});

test('library curator falls back on invalid JSON', async () => {
  await withLibraryCuratorStubs({
    createChatCompletion: async () => ({
      content: 'not-json',
      model: 'llama-3.1-8b-instant',
      promptTokens: 10,
      completionTokens: 5,
      skipped: false
    }),
    callback: async () => {
      const response = await createLibraryCuratorRecommendation({
        userId: USER_ID,
        mode: 'today',
        locale: 'ko',
        candidateScope: 'mixed',
        limit: 5
      });

      assert.equal(response.source, 'fallback');
      assert.equal(response.meta.fallbackReason, 'LLM_INVALID_JSON');
      assert.equal(response.meta.selectedCount, 1);
    }
  });
});

test('library curator falls back on provider request failures such as HTTP 400', async () => {
  await withLibraryCuratorStubs({
    createChatCompletion: async () => ({
      content: null,
      model: 'mock-rule-based',
      promptTokens: 0,
      completionTokens: 0,
      skipped: true,
      skipReason: 'request_failed',
      status: 400
    }),
    callback: async () => {
      const response = await createLibraryCuratorRecommendation({
        userId: USER_ID,
        mode: 'short_session',
        locale: 'ko',
        candidateScope: 'mixed',
        limit: 5
      });

      assert.equal(response.source, 'fallback');
      assert.equal(response.meta.fallbackReason, 'LLM_REQUEST_FAILED');
      assert.equal(response.meta.selectedCount, 1);
    }
  });
});

test('library curator applies excludedGameIds before LLM selection', async () => {
  await withLibraryCuratorStubs({
    createChatCompletion: async () => {
      throw new Error('LLM should not be called without candidates');
    },
    callback: async () => {
      const response = await createLibraryCuratorRecommendation({
        userId: USER_ID,
        mode: 'overview',
        locale: 'ko',
        candidateScope: 'mixed',
        excludedGameIds: ['100'],
        limit: 5
      });

      assert.equal(response.source, 'fallback');
      assert.equal(response.meta.fallbackReason, 'NO_CANDIDATES');
      assert.equal(response.meta.candidateCount, 0);
    }
  });
});

test('library curator LLM payload limits review excerpts to 200 characters', () => {
  const payload = buildLlmCandidatePayload([{
    candidateId: '100',
    gameId: '100',
    title: 'Server Library Title',
    genres: ['Indie'],
    themes: [],
    platforms: ['PC'],
    playtimeMinutes: 10,
    lastPlayedAt: null,
    isFavorite: false,
    hasReview: true,
    userRating: 4,
    reviewExcerpt: 'a'.repeat(500)
  }]);

  assert.equal(payload[0].reviewExcerpt.length, 200);
});

test('library curator route requires an access token at POST /api/v1/ai/library-curator', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/ai/library-curator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'overview' })
    });
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'UNAUTHORIZED');
    assert.doesNotMatch(payload.error.message, /Route POST|was not found/);
  });
});

test('library curator authenticated route returns fixed response envelope', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;

  tokenService.verifyAccessToken = () => ({
    type: 'access',
    sub: USER_ID
  });
  prisma.user.findUnique = async () => ({
    id: USER_ID,
    email: 'test@example.com',
    status: 'ACTIVE'
  });
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ recommendationCount: 1 })
    }
  });

  try {
    await withLibraryCuratorStubs({
      libraryEntries: [],
      favoriteRows: [],
      reviewRows: [],
      callback: async () => withTestServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ai/library-curator`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer fake-access-token',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            mode: 'overview',
            locale: 'en'
          })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.mode, 'overview');
        assert.equal(payload.data.source, 'fallback');
        assert.equal(payload.data.meta.fallbackReason, 'NO_CANDIDATES');
        assert.equal(payload.data.meta.locale, 'en');
      })
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
    prisma.$transaction = originalTransaction;
  }
});

test('library curator daily limit response includes Korean message and reset metadata', async () => {
  const originalVerifyAccessToken = tokenService.verifyAccessToken;
  const originalFindUnique = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;
  const originalDailyLimit = env.aiLibraryCuratorDailyLimit;

  tokenService.verifyAccessToken = () => ({
    type: 'access',
    sub: USER_ID
  });
  prisma.user.findUnique = async () => ({
    id: USER_ID,
    email: 'test@example.com',
    status: 'ACTIVE'
  });
  env.aiLibraryCuratorDailyLimit = 1;
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ recommendationCount: 2 })
    }
  });

  try {
    await withLibraryCuratorStubs({
      callback: async () => withTestServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/v1/ai/library-curator`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer fake-access-token',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            mode: 'overview',
            locale: 'ko',
            limit: 5
          })
        });
        const payload = await response.json();

        assert.equal(response.status, 429);
        assert.equal(payload.success, false);
        assert.equal(payload.error.code, 'AI_LIBRARY_CURATOR_DAILY_LIMIT_EXCEEDED');
        assert.match(payload.error.message, /오늘의 AI 라이브러리 분석 한도/);
        assert.equal(typeof payload.error.retryAfterSeconds, 'number');
        assert.match(payload.error.resetAt, /T00:00:00\+09:00$/);
        assert.equal(payload.error.details, undefined);
      })
    });
  } finally {
    tokenService.verifyAccessToken = originalVerifyAccessToken;
    prisma.user.findUnique = originalFindUnique;
    prisma.$transaction = originalTransaction;
    env.aiLibraryCuratorDailyLimit = originalDailyLimit;
  }
});
