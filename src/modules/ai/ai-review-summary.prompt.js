function buildReviewSummarySystemPrompt() {
  return [
    '너는 GamePedia의 리뷰 분석 도우미다.',
    '제공된 사용자 리뷰만 근거로 요약한다.',
    '리뷰에 없는 사실을 만들지 않는다.',
    '게임의 가격, 출시일, 플랫폼, 평점 등 정적 정보는 추측하지 않는다.',
    '응답은 반드시 JSON only로 반환한다.',
    '개인정보를 포함하지 않는다.',
    '과장된 마케팅 문구를 쓰지 않는다.'
  ].join(' ');
}

function buildReviewSummaryUserPrompt({ gameId, reviewCount, reviews }) {
  return JSON.stringify({
    task: '사용자 리뷰만 근거로 게임 리뷰 요약을 생성한다.',
    gameId,
    reviewCount,
    reviews: reviews.map((review) => ({
      reviewId: review.id,
      rating: review.rating,
      createdAt: review.createdAt,
      content: review.content
    })),
    outputSchema: {
      summary: 'string',
      pros: ['string'],
      cons: ['string'],
      recommendedFor: ['string'],
      notRecommendedFor: ['string'],
      keywords: ['string']
    },
    constraints: [
      'summary는 한국어 1~2문장으로 작성한다.',
      'pros는 최대 4개다.',
      'cons는 최대 4개다.',
      'recommendedFor는 최대 3개다.',
      'notRecommendedFor는 최대 3개다.',
      'keywords는 최대 6개다.',
      '모든 문장은 한국어로 작성한다.',
      '리뷰 의견이 혼재되어 있으면 "일부 리뷰에서는..."처럼 불확실성을 표현한다.',
      '근거 없는 단정은 금지한다.',
      'JSON only.'
    ]
  });
}

module.exports = {
  buildReviewSummarySystemPrompt,
  buildReviewSummaryUserPrompt
};
