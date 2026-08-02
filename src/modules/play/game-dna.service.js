const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const {
  GAME_DNA_HIGH_CONFIDENCE_SIGNALS,
  GAME_DNA_MEDIUM_CONFIDENCE_SIGNALS,
  GAME_DNA_MIN_SIGNALS_PER_AXIS,
  GENRE_BUCKETS
} = require('./play.constants');

// Game DNA is a deterministic calculation. The same inputs always produce the
// same axes, reason codes and confidence, with no model involved: an optional AI
// narration can be layered on top by the caller, and the endpoint is fully
// functional when AI is disabled or unavailable.
//
// Signals: star ratings, library status, completion/drop outcomes, playtime,
// genres, Steam tags, recent play and Playlog outcome states. Playlog *note*
// bodies are never read — the query does not even select the column.

const RECENT_PLAY_WINDOW_DAYS = 30;
const SHORT_SESSION_MINUTES = 45;
const LONG_SESSION_MINUTES = 120;

function bucketMatches(bucket, values) {
  const lowered = values.map((value) => String(value).toLowerCase());

  return lowered.filter((value) => bucket.some((token) => value === token || value.includes(token))).length;
}

function ratio(part, total) {
  return total > 0 ? Number((part / total).toFixed(4)) : null;
}

function leaning(leftScore, rightScore, leftLabel, rightLabel, neutralLabel) {
  const total = leftScore + rightScore;

  if (total === 0) {
    return { label: neutralLabel, score: null };
  }

  const balance = Number(((leftScore - rightScore) / total).toFixed(4));

  if (balance > 0.2) {
    return { label: leftLabel, score: balance };
  }

  if (balance < -0.2) {
    return { label: rightLabel, score: balance };
  }

  return { label: neutralLabel, score: balance };
}

function resolveConfidence(signalCount) {
  if (signalCount >= GAME_DNA_HIGH_CONFIDENCE_SIGNALS) {
    return 'HIGH';
  }

  if (signalCount >= GAME_DNA_MEDIUM_CONFIDENCE_SIGNALS) {
    return 'MEDIUM';
  }

  return 'LOW';
}

async function loadSignals({ userId, now }) {
  const recentCutoff = new Date(now.getTime() - RECENT_PLAY_WINDOW_DAYS * 86_400_000);

  const [reviews, libraryEntries, playSessions] = await Promise.all([
    prisma.review.findMany({
      where: { userId },
      select: { rating: true, catalogGameId: true, gameId: true }
    }),
    prisma.userGameLibrary.findMany({
      where: { userId },
      select: {
        status: true,
        playtimeMinutes: true,
        lastPlayedAt: true,
        catalogGameId: true,
        gameSource: true,
        externalGameId: true
      }
    }),
    prisma.playSession.findMany({
      where: { userId },
      // `note` is deliberately absent: note bodies are never analysed.
      select: {
        catalogGameId: true,
        playedAt: true,
        durationMinutes: true,
        progressPercent: true,
        outcome: true
      },
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
      take: 500
    })
  ]);

  const catalogGameIds = [...new Set([
    ...libraryEntries.map((entry) => entry.catalogGameId),
    ...reviews.map((review) => review.catalogGameId),
    ...playSessions.map((session) => session.catalogGameId)
  ].filter(Boolean))];

  const catalogGames = catalogGameIds.length > 0
    ? await prisma.catalogGame.findMany({
      where: { id: { in: catalogGameIds } },
      select: {
        id: true,
        genres: true,
        steamTags: true,
        supportsSinglePlayer: true,
        supportsMultiplayer: true,
        typicalSessionMinutes: true
      }
    })
    : [];

  return {
    reviews,
    libraryEntries,
    playSessions,
    catalogGames,
    catalogGameById: new Map(catalogGames.map((game) => [game.id, game])),
    recentCutoff
  };
}

function computeGenreProfile({ libraryEntries, playSessions, catalogGameById }) {
  const genreCounts = new Map();
  const tagCounts = new Map();
  const weightByGameId = new Map();

  for (const entry of libraryEntries) {
    if (entry.catalogGameId) {
      weightByGameId.set(entry.catalogGameId, (weightByGameId.get(entry.catalogGameId) ?? 0) + 1);
    }
  }

  for (const session of playSessions) {
    weightByGameId.set(session.catalogGameId, (weightByGameId.get(session.catalogGameId) ?? 0) + 1);
  }

  for (const [catalogGameId, weight] of weightByGameId.entries()) {
    const game = catalogGameById.get(catalogGameId);

    if (!game) {
      continue;
    }

    for (const genre of game.genres ?? []) {
      const key = String(genre).toLowerCase();
      genreCounts.set(key, (genreCounts.get(key) ?? 0) + weight);
    }

    for (const tag of game.steamTags ?? []) {
      const key = String(tag).toLowerCase();
      tagCounts.set(key, (tagCounts.get(key) ?? 0) + weight);
    }
  }

  const totalGenreWeight = [...genreCounts.values()].reduce((total, value) => total + value, 0);
  const topGenres = [...genreCounts.entries()]
    // Deterministic: weight desc, then genre name asc.
    .sort((left, right) => (right[1] - left[1]) || (left[0] < right[0] ? -1 : 1))
    .slice(0, 5)
    .map(([genre, weight]) => ({
      genre,
      weight,
      share: ratio(weight, totalGenreWeight)
    }));

  return {
    genreCounts,
    tagCounts,
    topGenres,
    totalGenreWeight,
    distinctGenreCount: genreCounts.size,
    distinctTagCount: tagCounts.size,
    concentration: topGenres.length > 0 ? topGenres[0].share : null
  };
}

/// Pure calculation over already-loaded signals. Exported so it can be tested
/// without a database.
function computeGameDnaFromSignals({ signals, now }) {
  const { reviews, libraryEntries, playSessions, catalogGameById, recentCutoff } = signals;
  const reasonCodes = new Set();
  const missingSignals = [];

  // --- ratings ---
  const ratings = reviews.map((review) => Number(review.rating)).filter((value) => Number.isFinite(value));
  const averageRating = ratings.length > 0
    ? Number((ratings.reduce((total, value) => total + value, 0) / ratings.length).toFixed(2))
    : null;

  if (ratings.length === 0) {
    missingSignals.push('ratings');
  } else if (ratings.length >= GAME_DNA_MIN_SIGNALS_PER_AXIS) {
    reasonCodes.add('rating_sample_sufficient');
  } else {
    reasonCodes.add('rating_sample_thin');
  }

  // --- library status / completion ---
  const statusCounts = libraryEntries.reduce((counts, entry) => {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return counts;
  }, {});

  if (libraryEntries.length === 0) {
    missingSignals.push('library_status');
  }

  const playlogCompleted = playSessions.filter((session) => session.outcome === 'COMPLETED').length;
  const playlogDropped = playSessions.filter((session) => session.outcome === 'DROPPED').length;
  const completedCount = (statusCounts.COMPLETED ?? 0) + playlogCompleted;
  const droppedCount = (statusCounts.DROPPED ?? 0) + playlogDropped;
  const finishedCount = completedCount + droppedCount;

  if (finishedCount === 0) {
    missingSignals.push('completion_outcomes');
  }

  const completionRate = ratio(completedCount, finishedCount);

  if (completionRate !== null && finishedCount >= GAME_DNA_MIN_SIGNALS_PER_AXIS) {
    if (completionRate >= 0.6) {
      reasonCodes.add('completion_rate_high');
    } else if (completionRate <= 0.35) {
      reasonCodes.add('completion_rate_low');
      reasonCodes.add('drop_rate_high');
    }
  }

  // --- playtime / session length ---
  const playtimeMinutes = libraryEntries
    .map((entry) => entry.playtimeMinutes)
    .filter((value) => Number.isInteger(value) && value > 0);
  const sessionDurations = playSessions
    .map((session) => session.durationMinutes)
    .filter((value) => Number.isInteger(value) && value > 0);

  if (playtimeMinutes.length === 0) {
    missingSignals.push('playtime_minutes');
    reasonCodes.add('playtime_signal_missing');
  }

  if (playSessions.length === 0) {
    missingSignals.push('playlog_outcomes');
    reasonCodes.add('playlog_sample_thin');
  }

  const medianSessionMinutes = sessionDurations.length > 0
    ? [...sessionDurations].sort((left, right) => left - right)[Math.floor(sessionDurations.length / 2)]
    : null;

  const genreProfile = computeGenreProfile({ libraryEntries, playSessions, catalogGameById });
  const genreNames = [...genreProfile.genreCounts.keys()];
  const tagNames = [...genreProfile.tagCounts.keys()];

  if (genreNames.length === 0) {
    missingSignals.push('genres');
    reasonCodes.add('genre_signal_missing');
  }

  if (tagNames.length === 0) {
    missingSignals.push('steam_tags');
    reasonCodes.add('steam_tag_signal_missing');
  }

  const shortSessionAffinity = bucketMatches(GENRE_BUCKETS.shortSession, [...genreNames, ...tagNames]);
  const longSessionAffinity = bucketMatches(GENRE_BUCKETS.longSession, [...genreNames, ...tagNames]);

  let sessionLengthLabel = 'UNKNOWN';

  if (medianSessionMinutes !== null && sessionDurations.length >= GAME_DNA_MIN_SIGNALS_PER_AXIS) {
    if (medianSessionMinutes <= SHORT_SESSION_MINUTES) {
      sessionLengthLabel = 'SHORT';
      reasonCodes.add('session_length_short');
    } else if (medianSessionMinutes >= LONG_SESSION_MINUTES) {
      sessionLengthLabel = 'LONG';
      reasonCodes.add('session_length_long');
    } else {
      sessionLengthLabel = 'MIXED';
      reasonCodes.add('session_length_mixed');
    }
  } else if (shortSessionAffinity + longSessionAffinity > 0) {
    const derived = leaning(shortSessionAffinity, longSessionAffinity, 'SHORT', 'LONG', 'MIXED');
    sessionLengthLabel = derived.label;
  }

  // --- solo vs multiplayer ---
  let multiplayerGames = 0;
  let singleplayerGames = 0;

  for (const game of catalogGameById.values()) {
    if (game.supportsMultiplayer === true) {
      multiplayerGames += 1;
    }

    if (game.supportsSinglePlayer === true) {
      singleplayerGames += 1;
    }
  }

  const multiplayerAffinity = multiplayerGames + bucketMatches(GENRE_BUCKETS.multiplayer, [...genreNames, ...tagNames]);
  const singleplayerAffinity = singleplayerGames + bucketMatches(GENRE_BUCKETS.singleplayer, [...genreNames, ...tagNames]);
  const socialLeaning = leaning(multiplayerAffinity, singleplayerAffinity, 'MULTIPLAYER', 'SINGLEPLAYER', 'BALANCED');

  if (socialLeaning.label === 'MULTIPLAYER') {
    reasonCodes.add('multiplayer_leaning');
  } else if (socialLeaning.label === 'SINGLEPLAYER') {
    reasonCodes.add('singleplayer_leaning');
  }

  // --- comfort vs challenge ---
  const comfortAffinity = bucketMatches(GENRE_BUCKETS.comfort, [...genreNames, ...tagNames])
    + (completionRate !== null && completionRate >= 0.6 ? 1 : 0);
  const challengeAffinity = bucketMatches(GENRE_BUCKETS.challenge, [...genreNames, ...tagNames])
    + (completionRate !== null && completionRate <= 0.35 ? 1 : 0);
  const toneLeaning = leaning(comfortAffinity, challengeAffinity, 'COMFORT', 'CHALLENGE', 'BALANCED');

  if (toneLeaning.label === 'COMFORT') {
    reasonCodes.add('comfort_leaning');
  } else if (toneLeaning.label === 'CHALLENGE') {
    reasonCodes.add('challenge_leaning');
  }

  // --- recency ---
  const recentPlayCount = playSessions.filter((session) => session.playedAt >= recentCutoff).length
    + libraryEntries.filter((entry) => entry.lastPlayedAt && entry.lastPlayedAt >= recentCutoff).length;

  if (recentPlayCount === 0) {
    missingSignals.push('recent_play');
    reasonCodes.add('recent_activity_missing');
  }

  if (genreProfile.concentration !== null) {
    reasonCodes.add(genreProfile.concentration >= 0.4 ? 'genre_concentration_high' : 'genre_concentration_low');
  }

  const signalCount = ratings.length
    + libraryEntries.length
    + playSessions.length
    + playtimeMinutes.length
    + genreProfile.distinctGenreCount
    + genreProfile.distinctTagCount;

  const freshestSignalAt = [
    ...playSessions.map((session) => session.playedAt),
    ...libraryEntries.map((entry) => entry.lastPlayedAt).filter(Boolean)
  ].sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

  return {
    signalCount,
    confidence: resolveConfidence(signalCount),
    generatedAt: now.toISOString(),
    dataFreshness: {
      freshestSignalAt: freshestSignalAt ? freshestSignalAt.toISOString() : null
      ,
      recentWindowDays: RECENT_PLAY_WINDOW_DAYS,
      recentSignalCount: recentPlayCount,
      stale: recentPlayCount === 0
    },
    genreProfile: {
      topGenres: genreProfile.topGenres,
      distinctGenreCount: genreProfile.distinctGenreCount,
      distinctSteamTagCount: genreProfile.distinctTagCount,
      concentration: genreProfile.concentration
    },
    completionProfile: {
      completedCount,
      droppedCount,
      completionRate,
      libraryStatusCounts: statusCounts,
      playlogCompletedCount: playlogCompleted,
      playlogDroppedCount: playlogDropped
    },
    sessionLengthProfile: {
      label: sessionLengthLabel,
      medianSessionMinutes,
      sampleSize: sessionDurations.length,
      totalTrackedPlaytimeMinutes: playtimeMinutes.reduce((total, value) => total + value, 0)
    },
    socialProfile: {
      label: socialLeaning.label,
      balance: socialLeaning.score,
      multiplayerAffinity,
      singleplayerAffinity
    },
    toneProfile: {
      label: toneLeaning.label,
      balance: toneLeaning.score,
      comfortAffinity,
      challengeAffinity
    },
    ratingProfile: {
      averageRating,
      ratingCount: ratings.length
    },
    missingSignals: [...new Set(missingSignals)].sort(),
    reasonCodes: [...reasonCodes].sort(),
    // Deterministic by construction; an AI narration is additive and optional.
    computation: {
      deterministic: true,
      aiNarrationIncluded: false
    }
  };
}

async function getGameDna({ userId, now = new Date() }) {
  const signals = await loadSignals({ userId, now });
  const dna = computeGameDnaFromSignals({ signals, now });

  logger.info('game-dna-computed', {
    signalCount: dna.signalCount,
    confidence: dna.confidence,
    missingSignalCount: dna.missingSignals.length,
    reasonCodeCount: dna.reasonCodes.length,
    deterministic: true
  });

  return dna;
}

module.exports = {
  RECENT_PLAY_WINDOW_DAYS,
  computeGameDnaFromSignals,
  getGameDna,
  loadSignals,
  resolveConfidence
};
