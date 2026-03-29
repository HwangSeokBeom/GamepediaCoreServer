function mapGameSource(source) {
  if (source === 'STEAM' || source === 'steam') {
    return 'steam';
  }

  return 'igdb';
}

function mapLibraryStatus(status) {
  if (typeof status !== 'string') {
    return null;
  }

  return status.toLowerCase();
}

function mapSteamLinkStatus(steamAccount) {
  if (!steamAccount) {
    return {
      isLinked: false,
      steamId64: null,
      personaName: null,
      avatarUrl: null,
      profileUrl: null,
      linkedAt: null
    };
  }

  return {
    isLinked: true,
    steamId64: steamAccount.providerSubject,
    personaName: steamAccount.personaName ?? null,
    avatarUrl: steamAccount.avatarUrl ?? null,
    profileUrl: steamAccount.profileUrl ?? null,
    linkedAt: steamAccount.linkedAt
  };
}

function mapLibraryStatusEntry(entry) {
  return {
    source: mapGameSource(entry.gameSource),
    externalGameId: entry.externalGameId,
    title: entry.gameName,
    coverUrl: entry.coverUrl ?? null,
    status: mapLibraryStatus(entry.status),
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    lastPlayedAt: entry.lastPlayedAt,
    playtimeMinutes: entry.playtimeMinutes,
    updatedAt: entry.updatedAt
  };
}

function mapWishlistItem(favorite, game) {
  return {
    source: 'igdb',
    externalGameId: favorite.gameId,
    title: game?.name ?? null,
    coverUrl: game?.coverUrl ?? null,
    favoritedAt: favorite.createdAt
  };
}

function mapReviewedItem(review, game) {
  return {
    source: 'igdb',
    externalGameId: review.gameId,
    title: game?.name ?? null,
    coverUrl: game?.coverUrl ?? null,
    reviewId: review.id,
    rating: review.rating,
    reviewedAt: review.createdAt,
    updatedAt: review.updatedAt
  };
}

module.exports = {
  mapLibraryStatus,
  mapLibraryStatusEntry,
  mapReviewedItem,
  mapSteamLinkStatus,
  mapWishlistItem
};
