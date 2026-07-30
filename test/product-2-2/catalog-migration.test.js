const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Static guarantees about the Product 2.2 migrations.
//
// These assertions protect the two properties that a runtime gate alone cannot:
// that no already-applied migration file was edited, and that the backfill can
// only ever merge a CONFIRMED Steam↔IGDB mapping.

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'prisma/migrations');
const CATALOG_MIGRATION = '20260730120000_create_catalog_game_identity';
const QUICK_ADD_MIGRATION = '20260730121000_add_quick_add_usage_counter';
const PLAY_MIGRATION = '20260730122000_create_playlog_and_compass';
const EDITORIAL_MIGRATION = '20260730123000_create_editorial_and_product_controls';

function readMigration(name) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

test('every Product 2.2 migration is a new directory holding a canonical migration.sql', () => {
  for (const name of [CATALOG_MIGRATION, QUICK_ADD_MIGRATION, PLAY_MIGRATION, EDITORIAL_MIGRATION]) {
    const migrationPath = path.join(MIGRATIONS_DIR, name, 'migration.sql');

    assert.ok(fs.existsSync(migrationPath), `${name}/migration.sql must exist`);
    assert.deepEqual(
      fs.readdirSync(path.join(MIGRATIONS_DIR, name)),
      ['migration.sql'],
      `${name} must contain exactly one canonical migration.sql`
    );
  }
});

test('no pre-existing migration file was modified by this branch', () => {
  // The merge base of this branch against origin/main is the state every earlier
  // migration must still match byte for byte.
  const baseRef = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim();
  const changedFiles = execFileSync('git', ['diff', '--name-only', `${baseRef}..HEAD`, '--', 'prisma/migrations'], {
    encoding: 'utf8'
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const productMigrationDirs = [CATALOG_MIGRATION, QUICK_ADD_MIGRATION, PLAY_MIGRATION, EDITORIAL_MIGRATION];
  const touchedExisting = changedFiles.filter(
    (file) => !productMigrationDirs.some((dir) => file.startsWith(`prisma/migrations/${dir}/`))
  );

  assert.deepEqual(touchedExisting, [], `existing migrations must not change: ${touchedExisting.join(', ')}`);
});

test('the catalog migration is additive and never drops or retypes legacy identity columns', () => {
  const sql = readMigration(CATALOG_MIGRATION);

  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
  assert.doesNotMatch(sql, /DROP\s+TABLE/i);
  assert.doesNotMatch(sql, /DROP\s+COLUMN/i);
  assert.doesNotMatch(sql, /ALTER\s+COLUMN\s+"game_id"/i);
  assert.doesNotMatch(sql, /ALTER\s+COLUMN\s+"game_source"/i);
  assert.doesNotMatch(sql, /ALTER\s+COLUMN\s+"external_game_id"/i);
  assert.doesNotMatch(sql, /CREATE\s+EXTENSION/i);

  // The four additive canonical index columns, all nullable.
  for (const table of ['reviews', 'favorite_games', 'user_game_library', 'user_activity_events']) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${table}" ADD COLUMN "catalog_game_id" UUID;`),
      `${table} must gain a nullable catalog_game_id`
    );
  }

  assert.doesNotMatch(sql, /ADD COLUMN "catalog_game_id" UUID NOT NULL/i);
});

test('the catalog migration declares every required Product 2.2 catalog table', () => {
  const sql = readMigration(CATALOG_MIGRATION);

  for (const table of [
    'catalog_games',
    'game_localizations',
    'regional_releases',
    'game_external_identities',
    'game_assets',
    'game_field_evidence',
    'game_submissions',
    'catalog_merge_audits',
    'game_follows'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}"`), `${table} must be created`);
  }
});

test('catalog game ids are UUID and provider keys are unique on (provider, externalId, regionKey)', () => {
  const sql = readMigration(CATALOG_MIGRATION);

  assert.match(sql, /CREATE TABLE "catalog_games" \(\s*\n\s*"id" UUID NOT NULL/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "game_external_identities_provider_external_id_region_key_key"\s*\n\s*ON "game_external_identities"\("provider", "external_id", "region_key"\)/
  );
  // region_key must be NOT NULL with a default, otherwise NULLs would defeat the
  // uniqueness constraint in PostgreSQL.
  assert.match(sql, /"region_key" VARCHAR\(16\) NOT NULL DEFAULT 'GLOBAL'/);
});

test('the enums cover exactly the required service statuses, providers and provenance values', () => {
  const sql = readMigration(CATALOG_MIGRATION);

  assert.match(
    sql,
    /CREATE TYPE "CatalogServiceStatus" AS ENUM \('ANNOUNCED', 'PRE_REGISTRATION', 'LIVE', 'MAINTENANCE', 'SUNSET_ANNOUNCED', 'SHUTDOWN'\);/
  );
  assert.match(
    sql,
    /CREATE TYPE "CatalogIdentityProvider" AS ENUM \('IGDB', 'STEAM', 'APPLE_APP_STORE', 'GOOGLE_PLAY', 'OFFICIAL_SITE', 'COMMUNITY'\);/
  );
  assert.match(
    sql,
    /CREATE TYPE "CatalogProvenance" AS ENUM \('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'USER_CONFIRMED', 'COMMUNITY_CONFIRMED', 'EDITOR_VERIFIED', 'AI_INFERRED', 'UNKNOWN', 'DISPUTED'\);/
  );
});

test('the backfill merges only CONFIRMED Steam-IGDB mappings', () => {
  const sql = readMigration(CATALOG_MIGRATION);
  const mergeSection = sql.slice(sql.indexOf('tmp_confirmed_merge'));

  assert.match(mergeSection, /WHERE mapping\."match_status" = 'CONFIRMED'/);
  // No other status may appear as a merge condition anywhere in the file.
  assert.doesNotMatch(sql, /match_status"?\s*=\s*'CANDIDATE'/i);
  assert.doesNotMatch(sql, /match_status"?\s*=\s*'UNMATCHED'/i);
  assert.doesNotMatch(sql, /match_status"?\s*=\s*'REJECTED'/i);
  assert.doesNotMatch(sql, /match_status"?\s+IN\s*\(/i);

  // A merge must leave a tombstone and an audit row.
  assert.match(sql, /SET "merged_into_catalog_game_id" = merge\."target_catalog_game_id"/);
  assert.match(sql, /INSERT INTO "catalog_merge_audits"/);
  assert.match(sql, /'CONFIRMED_MAPPING_MERGE'::"CatalogMergeDecision"/);

  // A self-merge is excluded so an audit row can never point a game at itself.
  assert.match(sql, /steam_seed\."catalog_game_id" <> igdb_seed\."catalog_game_id"/);
});

test('the backfill collects legacy identities from all four legacy tables', () => {
  const sql = readMigration(CATALOG_MIGRATION);

  assert.match(sql, /FROM "user_game_library"/);
  assert.match(sql, /FROM "reviews"/);
  assert.match(sql, /FROM "favorite_games"/);
  assert.match(sql, /FROM "user_activity_events"/);

  // reviews/favorite_games game_id values are IGDB identities.
  assert.match(sql, /SELECT 'IGDB'::"CatalogIdentityProvider", btrim\("game_id"\), NULL, false\s*\nFROM "reviews"/);
  assert.match(sql, /SELECT 'IGDB'::"CatalogIdentityProvider", btrim\("game_id"\), NULL, false\s*\nFROM "favorite_games"/);

  // Legacy rows join through game_external_identities, which the merge step has
  // already repointed, so nothing lands on a tombstone.
  assert.match(sql, /UPDATE "user_game_library" AS entry\s*\nSET "catalog_game_id" = identity\."catalog_game_id"/);
  assert.match(sql, /FROM "game_external_identities" AS identity/);
});

test('the title normalization in SQL matches the JavaScript implementation', () => {
  const sql = readMigration(CATALOG_MIGRATION);
  const { normalizeTitle } = require('../../src/modules/catalog/catalog-title.util');

  // Both sides must strip the same character class, otherwise backfilled rows and
  // API-created rows would normalize differently.
  const expectedClass = "'[^a-z0-9가-힣ぁ-んァ-ヶ一-龯]+'";

  assert.ok(sql.includes(expectedClass), 'the SQL must use the shared retained-character class');
  assert.ok(
    sql.includes(`regexp_replace(lower("title"), ${expectedClass}, ' ', 'g')`),
    'the SQL normalization expression must match the documented form'
  );
  assert.equal(normalizeTitle('Portal 2'), 'portal 2');
});

test('the quick add migration only adds a counter to the existing AI usage table', () => {
  const sql = readMigration(QUICK_ADD_MIGRATION);

  assert.match(sql, /ALTER TABLE "ai_usage_limits" ADD COLUMN "quick_add_count" INTEGER NOT NULL DEFAULT 0;/);
  assert.doesNotMatch(sql, /DROP/i);
  assert.doesNotMatch(sql, /CREATE TABLE/i);
});

test('the playlog migration makes clientMutationId unique per account', () => {
  const sql = readMigration(PLAY_MIGRATION);

  assert.match(
    sql,
    /CREATE UNIQUE INDEX "play_sessions_user_id_client_mutation_id_key" ON "play_sessions"\("user_id", "client_mutation_id"\);/
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "client_mutation_receipts_user_id_scope_client_mutation_id_key"/
  );
  assert.match(sql, /CREATE TABLE "play_compass_events"/);
  assert.match(sql, /"action" "PlayCompassAction" NOT NULL/);
});

test('the editorial migration makes product event ids unique and keeps sources excerpt-only', () => {
  const sql = readMigration(EDITORIAL_MIGRATION);

  assert.match(sql, /CREATE UNIQUE INDEX "product_events_event_id_key" ON "product_events"\("event_id"\);/);
  assert.match(sql, /"excerpt" VARCHAR\(400\)/);
  assert.match(sql, /"content_hash" CHAR\(64\) NOT NULL/);
  // article_sources must not have a column that could hold a full article body.
  assert.doesNotMatch(sql, /CREATE TABLE "article_sources"[\s\S]*?"body[^"]*"[\s\S]*?\);/i);
  assert.match(sql, /CREATE TABLE "product_feature_flags"/);
});

test('the Prisma schema declares catalogGameId on all four legacy models', () => {
  const schema = fs.readFileSync(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');

  for (const table of ['reviews', 'favorite_games', 'user_game_library', 'user_activity_events']) {
    const modelStart = schema.indexOf(`@@map("${table}")`);
    assert.ok(modelStart > 0, `${table} model must exist`);
  }

  // Nullable in the schema too, so the additive column stays optional.
  const catalogFieldCount = (schema.match(/catalogGameId\s+String\?\s+@map\("catalog_game_id"\)/g) ?? []).length;
  assert.ok(catalogFieldCount >= 4, `expected at least 4 nullable catalogGameId fields, found ${catalogFieldCount}`);
});
