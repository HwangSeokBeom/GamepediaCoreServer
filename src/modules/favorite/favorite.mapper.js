function mapFavoriteToDto(favorite) {
  return {
    gameId: favorite.gameId,
    createdAt: favorite.createdAt
  };
}

function mapFavoriteListToDto(favorites) {
  return favorites.map((favorite) => mapFavoriteToDto(favorite));
}

module.exports = {
  mapFavoriteListToDto,
  mapFavoriteToDto
};
