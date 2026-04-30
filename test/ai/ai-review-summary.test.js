const test = require('node:test');
const assert = require('node:assert/strict');
const { UserStatus } = require('@prisma/client');
const tokenService = require('../../src/services/token.service');
const { app } = require('../../src/app');
const { AppError } = require('../../src/utils/error-response');
const { env } = require('../../src/config/env');
const { prisma } = require('../../src/config/prisma');
const aiClient = require('../../src/modules/ai/ai.client');
const moderationService = require('../../src/modules/moderation/moderation.service');
const aiReviewSummaryService = require('../../src/modules/ai/ai-review-summary.service');
const {
  validateLlmReviewSummaryResponse
} = require('../../src/modules/ai/ai-review-summary.validator');

const TEST_USER_ID = '00000000-0000-0000-0000-000000000000';

function makeReview({
  id,
  content,
  rating = 4.5,
  createdAt = '2026-04-29T00:00:00.000Z',
  updatedAt = '2026-04-29T00:00:00.000Z'
}) {
  return {
    id,
    rating,
    content,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt)
  };
}

function makeReviews() {
  return [
    makeReview({
      id: '11111111-1111-1111-1111-111111111111',
      rating: 5,
      content: '힐링 분위기와 농장 관리가 좋고 탐험도 재미있습니다.'
    }),
    makeReview({
      id: '22222222-2222-2222-2222-222222222222',
      rating: 4,
      content: '자유도가 높고 혼자 오래 즐기기 좋은 게임입니다.',
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z'
    }),
    makeReview({
      id: '33333333-3333-3333-3333-333333333333',
      rating: 2,
      content: '초반에는 할 일이 많아서 복잡하게 느껴졌습니다.',
      createdAt: '2026-04-27T00:00:00.000Z',
      updatedAt: '2026-04-27T00:00:00.000Z'
    })
  ];
}

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

function buildAccessToken() {
  return tokenService.createTokenPair({
    id: TEST_USER_ID,
    email: 'review-summary@example.com'
  }).accessToken;
}

function buildSummaryRecord({ gameId = 1942n, sourceReviewHash = 'hash'.padEnd(64, 'a') } = {}) {
  return {
    id: 1n,
    gameId,
    summary: '대부분의 리뷰는 느긋한 플레이와 높은 자유도를 장점으로 언급합니다.',
    pros: ['농장 관리와 탐험의 균형이 좋다는 의견이 많습니다.'],
    cons: ['초반에는 해야 할 일이 많아 다소 복잡하게 느껴질 수 있습니다.'],
    recommendedFor: ['느긋한 게임을 선호하는 사용자'],
    notRecommendedFor: ['빠른 전투와 경쟁 중심 플레이를 원하는 사용자'],
    keywords: ['힐링', '자유도', '농장'],
    reviewCount: 3,
    sourceReviewHash,
    model: 'mock-rule-based',
    promptTokens: 0,
    completionTokens: 0,
    generatedAt: new Date('2026-04-30T00:00:00.000Z'),
    updatedAt: new Date('2026-04-30T00:00:00.000Z')
  };
}

test('review summary route requires access token', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/ai/games/1942/review-summary`);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'UNAUTHORIZED');
  });
});

test('review summary route rejects invalid gameId with VALIDATION_FAILED', async () => {
  const originalFindUnique = prisma.user.findUnique;

  prisma.user.findUnique = async () => ({
    id: TEST_USER_ID,
    email: 'review-summary@example.com',
    status: UserStatus.ACTIVE
  });

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ai/games/not-a-number/review-summary`, {
        headers: {
          Authorization: `Bearer ${buildAccessToken()}`
        }
      });
      const payload = await response.json();

      assert.equal(response.status, 400);
      assert.equal(payload.success, false);
      assert.equal(payload.error.code, 'VALIDATION_FAILED');
    });
  } finally {
    prisma.user.findUnique = originalFindUnique;
  }
});

test('review summary service rejects insufficient reviews without LLM call', async () => {
  const originalGetHiddenUserIds = moderationService.getHiddenUserIds;
  const originalFindMany = prisma.review.findMany;
  const originalCreateChatCompletion = aiClient.createChatCompletion;
  let llmCalled = false;

  moderationService.getHiddenUserIds = async () => [];
  prisma.review.findMany = async () => makeReviews().slice(0, 2);
  aiClient.createChatCompletion = async () => {
    llmCalled = true;
    throw new Error('LLM should not be called');
  };

  try {
    await assert.rejects(
      () => aiReviewSummaryService.getGameReviewSummary({
        currentUserId: TEST_USER_ID,
        gameId: '1942'
      }),
      (error) => error instanceof AppError && error.code === 'REVIEW_SUMMARY_NOT_AVAILABLE'
    );
    assert.equal(llmCalled, false);
  } finally {
    moderationService.getHiddenUserIds = originalGetHiddenUserIds;
    prisma.review.findMany = originalFindMany;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});

test('review summary cache hit returns without LLM or usage count', async () => {
  const reviews = makeReviews();
  const sourceReviewHash = aiReviewSummaryService.buildSourceReviewHash(reviews);
  const originalGetHiddenUserIds = moderationService.getHiddenUserIds;
  const originalFindMany = prisma.review.findMany;
  const originalFindUnique = prisma.aiReviewSummary.findUnique;
  const originalTransaction = prisma.$transaction;
  const originalCreateChatCompletion = aiClient.createChatCompletion;
  let llmCalled = false;
  let usageCalled = false;

  moderationService.getHiddenUserIds = async () => [];
  prisma.review.findMany = async () => reviews;
  prisma.aiReviewSummary.findUnique = async () => buildSummaryRecord({ sourceReviewHash });
  prisma.$transaction = async () => {
    usageCalled = true;
    throw new Error('usage should not be counted on cache hit');
  };
  aiClient.createChatCompletion = async () => {
    llmCalled = true;
    throw new Error('LLM should not be called on cache hit');
  };

  try {
    const response = await aiReviewSummaryService.getGameReviewSummary({
      currentUserId: TEST_USER_ID,
      gameId: '1942'
    });

    assert.equal(response.gameId, 1942);
    assert.equal(response.sourceReviewHash, sourceReviewHash);
    assert.equal(llmCalled, false);
    assert.equal(usageCalled, false);
  } finally {
    moderationService.getHiddenUserIds = originalGetHiddenUserIds;
    prisma.review.findMany = originalFindMany;
    prisma.aiReviewSummary.findUnique = originalFindUnique;
    prisma.$transaction = originalTransaction;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});

test('review summary service stores fallback summary when LLM_API_KEY is missing', async () => {
  const reviews = makeReviews();
  const originalApiKey = env.llmApiKey;
  const originalGetHiddenUserIds = moderationService.getHiddenUserIds;
  const originalFindMany = prisma.review.findMany;
  const originalFindUnique = prisma.aiReviewSummary.findUnique;
  const originalCreate = prisma.aiReviewSummary.create;
  const originalTransaction = prisma.$transaction;
  let storedPayload = null;

  env.llmApiKey = null;
  moderationService.getHiddenUserIds = async () => [];
  prisma.review.findMany = async () => reviews;
  prisma.aiReviewSummary.findUnique = async () => null;
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ reviewSummaryCount: 1 })
    }
  });
  prisma.aiReviewSummary.create = async (payload) => {
    storedPayload = payload;
    return buildSummaryRecord({
      sourceReviewHash: payload.data.sourceReviewHash
    });
  };

  try {
    const response = await aiReviewSummaryService.getGameReviewSummary({
      currentUserId: TEST_USER_ID,
      gameId: '1942'
    });

    assert.equal(response.gameId, 1942);
    assert.equal(response.reviewCount, 3);
    assert.equal(storedPayload.data.model, 'mock-rule-based');
    assert.equal(storedPayload.data.promptTokens, 0);
    assert.equal(storedPayload.data.completionTokens, 0);
  } finally {
    env.llmApiKey = originalApiKey;
    moderationService.getHiddenUserIds = originalGetHiddenUserIds;
    prisma.review.findMany = originalFindMany;
    prisma.aiReviewSummary.findUnique = originalFindUnique;
    prisma.aiReviewSummary.create = originalCreate;
    prisma.$transaction = originalTransaction;
  }
});

test('review summary service falls back when LLM returns invalid JSON', async () => {
  const reviews = makeReviews();
  const originalApiKey = env.llmApiKey;
  const originalGetHiddenUserIds = moderationService.getHiddenUserIds;
  const originalFindMany = prisma.review.findMany;
  const originalFindUnique = prisma.aiReviewSummary.findUnique;
  const originalCreate = prisma.aiReviewSummary.create;
  const originalTransaction = prisma.$transaction;
  const originalCreateChatCompletion = aiClient.createChatCompletion;
  let storedPayload = null;

  env.llmApiKey = 'test-key';
  moderationService.getHiddenUserIds = async () => [];
  prisma.review.findMany = async () => reviews;
  prisma.aiReviewSummary.findUnique = async () => null;
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ reviewSummaryCount: 1 })
    }
  });
  aiClient.createChatCompletion = async () => ({
    content: 'not-json',
    model: 'gemini-2.5-flash',
    promptTokens: 12,
    completionTokens: 5,
    skipped: false
  });
  prisma.aiReviewSummary.create = async (payload) => {
    storedPayload = payload;
    return buildSummaryRecord({
      sourceReviewHash: payload.data.sourceReviewHash
    });
  };

  try {
    const response = await aiReviewSummaryService.getGameReviewSummary({
      currentUserId: TEST_USER_ID,
      gameId: '1942'
    });

    assert.equal(response.gameId, 1942);
    assert.equal(storedPayload.data.model, 'mock-rule-based');
    assert.equal(storedPayload.data.promptTokens, 0);
    assert.equal(storedPayload.data.completionTokens, 0);
  } finally {
    env.llmApiKey = originalApiKey;
    moderationService.getHiddenUserIds = originalGetHiddenUserIds;
    prisma.review.findMany = originalFindMany;
    prisma.aiReviewSummary.findUnique = originalFindUnique;
    prisma.aiReviewSummary.create = originalCreate;
    prisma.$transaction = originalTransaction;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});

test('review summary validator clamps LLM array sizes', () => {
  const fallbackSummary = aiReviewSummaryService.buildFallbackReviewSummary({
    reviews: makeReviews()
  });
  const validated = validateLlmReviewSummaryResponse({
    rawContent: JSON.stringify({
      summary: '리뷰는 힐링 분위기와 자유도를 주로 언급합니다.',
      pros: ['장점1', '장점2', '장점3', '장점4', '장점5'],
      cons: ['단점1', '단점2', '단점3', '단점4', '단점5'],
      recommendedFor: ['추천1', '추천2', '추천3', '추천4'],
      notRecommendedFor: ['비추천1', '비추천2', '비추천3', '비추천4'],
      keywords: ['힐링', '자유도', '농장', '탐험', '도트', '싱글', '초과']
    }),
    fallbackSummary
  });

  assert.equal(validated.source, 'llm');
  assert.equal(validated.value.pros.length, 4);
  assert.equal(validated.value.cons.length, 4);
  assert.equal(validated.value.recommendedFor.length, 3);
  assert.equal(validated.value.notRecommendedFor.length, 3);
  assert.equal(validated.value.keywords.length, 6);
});

test('review summary route wraps successful response fields', async () => {
  const originalFindUnique = prisma.user.findUnique;
  const originalGetGameReviewSummary = aiReviewSummaryService.getGameReviewSummary;

  prisma.user.findUnique = async () => ({
    id: TEST_USER_ID,
    email: 'review-summary@example.com',
    status: UserStatus.ACTIVE
  });
  aiReviewSummaryService.getGameReviewSummary = async () => ({
    gameId: 1942,
    summary: '요약입니다.',
    pros: ['장점'],
    cons: ['단점'],
    recommendedFor: ['추천'],
    notRecommendedFor: ['비추천'],
    keywords: ['키워드'],
    reviewCount: 3,
    sourceReviewHash: 'hash',
    generatedAt: '2026-04-30T00:00:00.000Z',
    disclaimer: aiReviewSummaryService.DISCLAIMER
  });

  try {
    await withTestServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/ai/games/1942/review-summary`, {
        headers: {
          Authorization: `Bearer ${buildAccessToken()}`
        }
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.deepEqual(Object.keys(payload.data), [
        'gameId',
        'summary',
        'pros',
        'cons',
        'recommendedFor',
        'notRecommendedFor',
        'keywords',
        'reviewCount',
        'sourceReviewHash',
        'generatedAt',
        'disclaimer'
      ]);
    });
  } finally {
    prisma.user.findUnique = originalFindUnique;
    aiReviewSummaryService.getGameReviewSummary = originalGetGameReviewSummary;
  }
});

test('sourceReviewHash changes when review content is modified', () => {
  const originalReviews = makeReviews();
  const modifiedReviews = makeReviews();
  modifiedReviews[0] = {
    ...modifiedReviews[0],
    content: `${modifiedReviews[0].content} 업데이트된 의견입니다.`,
    updatedAt: new Date('2026-04-30T00:00:00.000Z')
  };

  assert.notEqual(
    aiReviewSummaryService.buildSourceReviewHash(originalReviews),
    aiReviewSummaryService.buildSourceReviewHash(modifiedReviews)
  );
});

test('review summary usage limit throws AI_DAILY_LIMIT_EXCEEDED', async () => {
  const originalTransaction = prisma.$transaction;
  const originalLimit = env.aiReviewSummaryDailyLimit;

  env.aiReviewSummaryDailyLimit = 1;
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ reviewSummaryCount: 2 })
    }
  });

  try {
    await assert.rejects(
      () => aiReviewSummaryService.assertAndIncrementReviewSummaryUsage({ userId: TEST_USER_ID }),
      (error) => error instanceof AppError && error.code === 'AI_DAILY_LIMIT_EXCEEDED'
    );
  } finally {
    prisma.$transaction = originalTransaction;
    env.aiReviewSummaryDailyLimit = originalLimit;
  }
});

test('review summary service persists AiReviewSummary fields', async () => {
  const reviews = makeReviews();
  const originalApiKey = env.llmApiKey;
  const originalGetHiddenUserIds = moderationService.getHiddenUserIds;
  const originalFindMany = prisma.review.findMany;
  const originalFindUnique = prisma.aiReviewSummary.findUnique;
  const originalCreate = prisma.aiReviewSummary.create;
  const originalTransaction = prisma.$transaction;
  const originalCreateChatCompletion = aiClient.createChatCompletion;
  let storedPayload = null;

  env.llmApiKey = 'test-key';
  moderationService.getHiddenUserIds = async () => [];
  prisma.review.findMany = async () => reviews;
  prisma.aiReviewSummary.findUnique = async () => null;
  prisma.$transaction = async (callback) => callback({
    aiUsageLimit: {
      upsert: async () => ({ reviewSummaryCount: 1 })
    }
  });
  aiClient.createChatCompletion = async () => ({
    content: JSON.stringify({
      summary: '리뷰는 힐링 분위기와 자유도를 주로 언급합니다.',
      pros: ['힐링 분위기가 좋다는 의견이 있습니다.'],
      cons: ['초반이 복잡하다는 의견이 있습니다.'],
      recommendedFor: ['느긋한 게임을 원하는 사용자'],
      notRecommendedFor: ['빠른 전투를 원하는 사용자'],
      keywords: ['힐링', '자유도']
    }),
    model: 'gpt-4o-mini',
    promptTokens: 33,
    completionTokens: 11,
    skipped: false
  });
  prisma.aiReviewSummary.create = async (payload) => {
    storedPayload = payload;
    return {
      ...buildSummaryRecord({
        sourceReviewHash: payload.data.sourceReviewHash
      }),
      summary: payload.data.summary,
      pros: payload.data.pros,
      cons: payload.data.cons,
      recommendedFor: payload.data.recommendedFor,
      notRecommendedFor: payload.data.notRecommendedFor,
      keywords: payload.data.keywords,
      model: payload.data.model,
      promptTokens: payload.data.promptTokens,
      completionTokens: payload.data.completionTokens
    };
  };

  try {
    const response = await aiReviewSummaryService.getGameReviewSummary({
      currentUserId: TEST_USER_ID,
      gameId: '1942'
    });

    assert.equal(storedPayload.data.gameId, 1942n);
    assert.equal(storedPayload.data.reviewCount, 3);
    assert.equal(storedPayload.data.model, 'gpt-4o-mini');
    assert.equal(storedPayload.data.promptTokens, 33);
    assert.equal(storedPayload.data.completionTokens, 11);
    assert.deepEqual(storedPayload.data.keywords, ['힐링', '자유도']);
    assert.equal(response.summary, '리뷰는 힐링 분위기와 자유도를 주로 언급합니다.');
  } finally {
    env.llmApiKey = originalApiKey;
    moderationService.getHiddenUserIds = originalGetHiddenUserIds;
    prisma.review.findMany = originalFindMany;
    prisma.aiReviewSummary.findUnique = originalFindUnique;
    prisma.aiReviewSummary.create = originalCreate;
    prisma.$transaction = originalTransaction;
    aiClient.createChatCompletion = originalCreateChatCompletion;
  }
});
