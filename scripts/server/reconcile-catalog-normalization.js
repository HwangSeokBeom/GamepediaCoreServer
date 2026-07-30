#!/usr/bin/env node

const { disconnectDatabase } = require('../../src/config/prisma');
const {
  reconcileCatalogNormalization,
  verifyCatalogNormalizationContract
} = require('../../src/modules/catalog/catalog-normalization.service');

async function main() {
  const result = await reconcileCatalogNormalization();
  await verifyCatalogNormalizationContract();

  process.stdout.write([
    `catalog normalization contract: ${result.contractVersion}`,
    `catalog games scanned: ${result.catalogGameCount}`,
    `catalog games updated: ${result.catalogGamesUpdated}`,
    `localizations scanned: ${result.localizationCount}`,
    `localizations updated: ${result.localizationsUpdated}`
  ].join('\n'));
  process.stdout.write('\n');
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`Catalog normalization reconciliation failed: ${error.code ?? error.name}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await disconnectDatabase();
    });
}

module.exports = { main };
