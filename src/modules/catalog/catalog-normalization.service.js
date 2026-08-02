const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const {
  CATALOG_NORMALIZATION_CONTRACT,
  normalizeTitle
} = require('./catalog-title.util');

const NORMALIZATION_STATE_ID = 1;
const UPDATE_BATCH_SIZE = 500;
const RECONCILIATION_TIMEOUT_MS = 5 * 60 * 1000;

class CatalogNormalizationContractError extends Error {
  constructor(reason) {
    super(`Catalog normalization contract is not ready: ${reason}`);
    this.name = 'CatalogNormalizationContractError';
    this.code = 'CATALOG_NORMALIZATION_CONTRACT_NOT_READY';
    this.reason = reason;
  }
}

function chunks(values, size = UPDATE_BATCH_SIZE) {
  const result = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

function localizationCanonicalKey(row, normalizedTitle) {
  return JSON.stringify([
    row.catalogGameId,
    row.kind,
    row.languageCode,
    row.regionCode,
    normalizedTitle
  ]);
}

function assertNoLocalizationCollision(rows) {
  const seen = new Set();

  for (const row of rows) {
    const key = localizationCanonicalKey(row, row.expectedNormalizedTitle);

    if (seen.has(key)) {
      throw new CatalogNormalizationContractError('localization_collision');
    }

    seen.add(key);
  }
}

async function updateCatalogGameRows(transaction, rows) {
  for (const batch of chunks(rows)) {
    const values = batch.map((row) => Prisma.sql`(${row.id}::uuid, ${row.expectedNormalizedTitle})`);

    await transaction.$executeRaw(Prisma.sql`
      UPDATE "catalog_games" AS target
      SET "normalized_title" = source."normalized_title"
      FROM (VALUES ${Prisma.join(values)}) AS source("id", "normalized_title")
      WHERE target."id" = source."id"
    `);
  }
}

async function updateLocalizationRows(transaction, rows) {
  // Move changed rows through a value that normalizeTitle() can never produce.
  // This avoids transient unique-key conflicts when two historical values swap.
  for (const batch of chunks(rows)) {
    const values = batch.map((row) => Prisma.sql`(${row.id}::uuid, ${`\u001f${row.id}`})`);

    await transaction.$executeRaw(Prisma.sql`
      UPDATE "game_localizations" AS target
      SET "normalized_title" = source."normalized_title"
      FROM (VALUES ${Prisma.join(values)}) AS source("id", "normalized_title")
      WHERE target."id" = source."id"
    `);
  }

  for (const batch of chunks(rows)) {
    const values = batch.map((row) => Prisma.sql`(${row.id}::uuid, ${row.expectedNormalizedTitle})`);

    await transaction.$executeRaw(Prisma.sql`
      UPDATE "game_localizations" AS target
      SET "normalized_title" = source."normalized_title"
      FROM (VALUES ${Prisma.join(values)}) AS source("id", "normalized_title")
      WHERE target."id" = source."id"
    `);
  }
}

async function reconcileCatalogNormalization({ database = prisma, now = new Date() } = {}) {
  return database.$transaction(async (transaction) => {
    // Deploy-time reconciliation owns all catalog title writes for the duration
    // of the transaction. Readers may continue, but no partial rewrite is ever
    // observable and a failed collision check rolls the entire operation back.
    await transaction.$executeRawUnsafe(`
      LOCK TABLE
        "catalog_games",
        "game_localizations",
        "catalog_normalization_state"
      IN SHARE ROW EXCLUSIVE MODE
    `);

    const games = await transaction.catalogGame.findMany({
      select: { id: true, originalTitle: true, normalizedTitle: true },
      orderBy: { id: 'asc' }
    });
    const localizations = await transaction.gameLocalization.findMany({
      select: {
        id: true,
        catalogGameId: true,
        kind: true,
        languageCode: true,
        regionCode: true,
        title: true,
        normalizedTitle: true
      },
      orderBy: { id: 'asc' }
    });

    const canonicalGames = games.map((row) => ({
      ...row,
      expectedNormalizedTitle: normalizeTitle(row.originalTitle)
    }));
    const canonicalLocalizations = localizations.map((row) => ({
      ...row,
      expectedNormalizedTitle: normalizeTitle(row.title)
    }));

    assertNoLocalizationCollision(canonicalLocalizations);

    const changedGames = canonicalGames.filter(
      (row) => row.normalizedTitle !== row.expectedNormalizedTitle
    );
    const changedLocalizations = canonicalLocalizations.filter(
      (row) => row.normalizedTitle !== row.expectedNormalizedTitle
    );

    await updateCatalogGameRows(transaction, changedGames);
    await updateLocalizationRows(transaction, changedLocalizations);

    await transaction.catalogNormalizationState.upsert({
      where: { singletonId: NORMALIZATION_STATE_ID },
      create: {
        singletonId: NORMALIZATION_STATE_ID,
        contractVersion: CATALOG_NORMALIZATION_CONTRACT,
        catalogGameCount: games.length,
        localizationCount: localizations.length,
        reconciledAt: now
      },
      update: {
        contractVersion: CATALOG_NORMALIZATION_CONTRACT,
        catalogGameCount: games.length,
        localizationCount: localizations.length,
        reconciledAt: now
      }
    });

    return {
      contractVersion: CATALOG_NORMALIZATION_CONTRACT,
      catalogGameCount: games.length,
      localizationCount: localizations.length,
      catalogGamesUpdated: changedGames.length,
      localizationsUpdated: changedLocalizations.length
    };
  }, {
    maxWait: 10_000,
    timeout: RECONCILIATION_TIMEOUT_MS
  });
}

async function verifyCatalogNormalizationContract({ database = prisma } = {}) {
  const state = await database.catalogNormalizationState.findUnique({
    where: { singletonId: NORMALIZATION_STATE_ID }
  });

  if (
    !state
    || state.contractVersion !== CATALOG_NORMALIZATION_CONTRACT
    || !(state.reconciledAt instanceof Date)
  ) {
    throw new CatalogNormalizationContractError('reconciliation_missing');
  }

  const [games, localizations] = await Promise.all([
    database.catalogGame.findMany({
      select: { originalTitle: true, normalizedTitle: true }
    }),
    database.gameLocalization.findMany({
      select: { title: true, normalizedTitle: true }
    })
  ]);

  if (games.some((row) => row.normalizedTitle !== normalizeTitle(row.originalTitle))) {
    throw new CatalogNormalizationContractError('catalog_game_mismatch');
  }

  if (localizations.some((row) => row.normalizedTitle !== normalizeTitle(row.title))) {
    throw new CatalogNormalizationContractError('localization_mismatch');
  }

  return {
    contractVersion: state.contractVersion,
    catalogGameCount: games.length,
    localizationCount: localizations.length,
    reconciledAt: state.reconciledAt
  };
}

module.exports = {
  CATALOG_NORMALIZATION_CONTRACT,
  CatalogNormalizationContractError,
  reconcileCatalogNormalization,
  verifyCatalogNormalizationContract
};
