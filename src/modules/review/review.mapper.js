function normalizeNumericValue(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value.toNumber === 'function') {
    return value.toNumber();
  }

  return Number(value);
}

function mapReviewToDto(review, currentUserId) {
  return {
    id: review.id,
    gameId: review.gameId,
    rating: normalizeNumericValue(review.rating),
    content: review.content,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    author: {
      id: review.user.id,
      nickname: review.user.nickname,
      profileImageUrl: review.user.profileImageUrl
    },
    isMine: review.userId === currentUserId
  };
}

function mapReviewListToDto(reviews, currentUserId) {
  return reviews.map((review) => mapReviewToDto(review, currentUserId));
}

function mapAverageRating(averageRating) {
  const normalizedRating = normalizeNumericValue(averageRating);

  if (normalizedRating == null) {
    return null;
  }

  return Number(normalizedRating.toFixed(1));
}

module.exports = {
  mapAverageRating,
  mapReviewListToDto,
  mapReviewToDto
};
