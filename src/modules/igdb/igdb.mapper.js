function normalizeIgdbImageUrl(url, size) {
  if (typeof url !== 'string' || !url.trim()) {
    return null;
  }

  const normalizedUrl = url.startsWith('//') ? `https:${url}` : url.trim();
  const httpsUrl = normalizedUrl.startsWith('http://') ? `https://${normalizedUrl.slice(7)}` : normalizedUrl;

  if (!size) {
    return httpsUrl;
  }

  return httpsUrl.replace(/\/t_[^/]+\//, `/t_${size}/`);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function mapNamedItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return uniqueValues(
    items
      .map((item) => (typeof item?.name === 'string' ? item.name.trim() : null))
  );
}

function mapCompanyNames(involvedCompanies, flagName) {
  if (!Array.isArray(involvedCompanies)) {
    return [];
  }

  return uniqueValues(
    involvedCompanies
      .filter((company) => company?.[flagName] === true)
      .map((company) => (typeof company?.company?.name === 'string' ? company.company.name.trim() : null))
  );
}

function pickRating(game) {
  if (typeof game?.total_rating === 'number') {
    return game.total_rating;
  }

  if (typeof game?.aggregated_rating === 'number') {
    return game.aggregated_rating;
  }

  if (typeof game?.rating === 'number') {
    return game.rating;
  }

  return null;
}

function mapGameListItem(game) {
  return {
    id: game.id,
    name: game.name ?? null,
    summary: game.summary ?? null,
    coverUrl: normalizeIgdbImageUrl(game.cover?.url, 'cover_big'),
    genres: mapNamedItems(game.genres),
    platforms: mapNamedItems(game.platforms),
    rating: pickRating(game),
    aggregatedRating: typeof game.aggregated_rating === 'number' ? game.aggregated_rating : null,
    totalRating: typeof game.total_rating === 'number' ? game.total_rating : null,
    releaseDate: typeof game.first_release_date === 'number' ? game.first_release_date : null
  };
}

function mapGameSuggestionItem(game) {
  return {
    id: game.id,
    name: game.name ?? null,
    coverUrl: normalizeIgdbImageUrl(game.cover?.url, 'cover_big'),
    rating: pickRating(game)
  };
}

function mapSimilarGames(similarGames) {
  if (!Array.isArray(similarGames)) {
    return [];
  }

  return similarGames.map(mapGameListItem);
}

function mapImageUrls(images, size) {
  if (!Array.isArray(images)) {
    return [];
  }

  return uniqueValues(
    images.map((image) => normalizeIgdbImageUrl(image?.url, size))
  );
}

function mapVideoIds(videos) {
  if (!Array.isArray(videos)) {
    return [];
  }

  return uniqueValues(
    videos.map((video) => (typeof video?.video_id === 'string' ? video.video_id.trim() : null))
  );
}

function mapGameDetail(game) {
  return {
    id: game.id,
    name: game.name ?? null,
    summary: game.summary ?? null,
    storyline: game.storyline ?? null,
    coverUrl: normalizeIgdbImageUrl(game.cover?.url, 'cover_big'),
    artworkUrls: mapImageUrls(game.artworks, '1080p'),
    screenshotUrls: mapImageUrls(game.screenshots, 'screenshot_big'),
    genres: mapNamedItems(game.genres),
    platforms: mapNamedItems(game.platforms),
    developers: mapCompanyNames(game.involved_companies, 'developer'),
    publishers: mapCompanyNames(game.involved_companies, 'publisher'),
    rating: pickRating(game),
    aggregatedRating: typeof game.aggregated_rating === 'number' ? game.aggregated_rating : null,
    totalRating: typeof game.total_rating === 'number' ? game.total_rating : null,
    releaseDate: typeof game.first_release_date === 'number' ? game.first_release_date : null,
    status: typeof game.status === 'number' ? game.status : null,
    category: typeof game.category === 'number' ? game.category : null,
    videoIds: mapVideoIds(game.videos),
    similarGames: mapSimilarGames(game.similar_games)
  };
}

function mapGameList(games) {
  if (!Array.isArray(games)) {
    return [];
  }

  return games.map(mapGameListItem);
}

function mapGameSuggestions(games) {
  if (!Array.isArray(games)) {
    return [];
  }

  return games.map(mapGameSuggestionItem);
}

module.exports = {
  mapGameDetail,
  mapGameList,
  mapGameSuggestions
};
