-- Product 2.2 — canonical game catalog, provenance and open submissions.
--
-- Additive only. No existing migration file is modified, no existing column is
-- dropped or retyped, and every legacy identity column (game_id,
-- game_source/external_game_id) stays authoritative. catalog_game_id is an
-- additional nullable canonical index that is backfilled here.
--
-- Backfill policy:
--   * every distinct legacy IGDB/Steam identity becomes one canonical game,
--   * only steam_igdb_mappings rows with match_status = 'CONFIRMED' collapse a
--     Steam identity onto the IGDB canonical game,
--   * CANDIDATE / UNMATCHED / REJECTED mappings are never merged automatically.

BEGIN;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "CatalogPublicationStatus" AS ENUM ('PRIVATE', 'PENDING_REVIEW', 'PUBLISHED', 'REJECTED');
CREATE TYPE "CatalogServiceStatus" AS ENUM ('ANNOUNCED', 'PRE_REGISTRATION', 'LIVE', 'MAINTENANCE', 'SUNSET_ANNOUNCED', 'SHUTDOWN');
CREATE TYPE "CatalogIdentityProvider" AS ENUM ('IGDB', 'STEAM', 'APPLE_APP_STORE', 'GOOGLE_PLAY', 'OFFICIAL_SITE', 'COMMUNITY');
CREATE TYPE "CatalogProvenance" AS ENUM ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'USER_CONFIRMED', 'COMMUNITY_CONFIRMED', 'EDITOR_VERIFIED', 'AI_INFERRED', 'UNKNOWN', 'DISPUTED');
CREATE TYPE "CatalogLocalizationKind" AS ENUM ('ORIGINAL_TITLE', 'REGIONAL_TITLE', 'ALIAS');
CREATE TYPE "CatalogAssetKind" AS ENUM ('COVER', 'HERO', 'SCREENSHOT', 'LOGO');
CREATE TYPE "CatalogAssetRightsStatus" AS ENUM ('UNKNOWN', 'PROVIDER_LICENSED', 'OFFICIAL_PRESS_KIT', 'USER_SUBMITTED', 'CLEARED', 'RESTRICTED');
CREATE TYPE "GameSubmissionInputType" AS ENUM ('TEXT', 'URL', 'PROVIDER_ID');
CREATE TYPE "GameSubmissionStatus" AS ENUM ('PREVIEW', 'PERSONAL_CONFIRMED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE "CatalogMergeDecision" AS ENUM ('CONFIRMED_MAPPING_MERGE', 'EDITOR_MERGE', 'REJECTED', 'SPLIT');
CREATE TYPE "ProductRole" AS ENUM ('USER', 'EDITOR', 'ADMIN');

-- ---------------------------------------------------------------------------
-- Database-backed authorization
-- ---------------------------------------------------------------------------

CREATE TABLE "user_role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "ProductRole" NOT NULL,
    "granted_by_user_id" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_role_assignments_user_id_role_key" ON "user_role_assignments"("user_id", "role");
CREATE INDEX "user_role_assignments_user_id_revoked_at_idx" ON "user_role_assignments"("user_id", "revoked_at");
CREATE INDEX "user_role_assignments_role_revoked_at_idx" ON "user_role_assignments"("role", "revoked_at");

ALTER TABLE "user_role_assignments"
    ADD CONSTRAINT "user_role_assignments_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Canonical catalog
-- ---------------------------------------------------------------------------

CREATE TABLE "catalog_games" (
    "id" UUID NOT NULL,
    "original_title" VARCHAR(300) NOT NULL,
    "normalized_title" VARCHAR(300) NOT NULL,
    "slug" VARCHAR(320),
    "developer_name" VARCHAR(200),
    "publisher_name" VARCHAR(200),
    "first_release_date" DATE,
    "genres" TEXT[],
    "steam_tags" TEXT[],
    "platforms" TEXT[],
    "supports_single_player" BOOLEAN,
    "supports_multiplayer" BOOLEAN,
    "typical_session_minutes" INTEGER,
    "publication_status" "CatalogPublicationStatus" NOT NULL DEFAULT 'PRIVATE',
    "title_provenance" "CatalogProvenance" NOT NULL DEFAULT 'UNKNOWN',
    "created_by_user_id" UUID,
    "merged_into_catalog_game_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_games_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalog_games_slug_key" ON "catalog_games"("slug");
CREATE INDEX "catalog_games_normalized_title_idx" ON "catalog_games"("normalized_title");
CREATE INDEX "catalog_games_publication_status_updated_at_idx" ON "catalog_games"("publication_status", "updated_at");
CREATE INDEX "catalog_games_merged_into_catalog_game_id_idx" ON "catalog_games"("merged_into_catalog_game_id");
CREATE INDEX "catalog_games_created_by_user_id_idx" ON "catalog_games"("created_by_user_id");

ALTER TABLE "catalog_games"
    ADD CONSTRAINT "catalog_games_merged_into_catalog_game_id_fkey"
    FOREIGN KEY ("merged_into_catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "game_localizations" (
    "id" UUID NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "kind" "CatalogLocalizationKind" NOT NULL,
    "language_code" VARCHAR(16) NOT NULL,
    -- NOT NULL with a sentinel: a NULL inside the compound unique key below
    -- would allow unlimited duplicates, because NULL is never equal to NULL.
    "region_code" VARCHAR(8) NOT NULL DEFAULT 'GLOBAL',
    "title" VARCHAR(300) NOT NULL,
    "normalized_title" VARCHAR(300) NOT NULL,
    "provenance" "CatalogProvenance" NOT NULL DEFAULT 'UNKNOWN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_localizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "game_localizations_catalog_game_id_kind_language_code_regio_key"
    ON "game_localizations"("catalog_game_id", "kind", "language_code", "region_code", "normalized_title");
CREATE INDEX "game_localizations_normalized_title_language_code_idx" ON "game_localizations"("normalized_title", "language_code");
CREATE INDEX "game_localizations_catalog_game_id_kind_idx" ON "game_localizations"("catalog_game_id", "kind");

ALTER TABLE "game_localizations"
    ADD CONSTRAINT "game_localizations_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "regional_releases" (
    "id" UUID NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "country_code" VARCHAR(8) NOT NULL,
    "language_code" VARCHAR(16) NOT NULL,
    "platform" VARCHAR(40) NOT NULL,
    "operator_name" VARCHAR(200),
    "server_region" VARCHAR(60),
    "release_date" DATE,
    "shutdown_date" DATE,
    "service_status" "CatalogServiceStatus" NOT NULL DEFAULT 'ANNOUNCED',
    "provenance" "CatalogProvenance" NOT NULL DEFAULT 'UNKNOWN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regional_releases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "regional_releases_catalog_game_id_country_code_language_cod_key"
    ON "regional_releases"("catalog_game_id", "country_code", "language_code", "platform");
CREATE INDEX "regional_releases_catalog_game_id_service_status_idx" ON "regional_releases"("catalog_game_id", "service_status");
CREATE INDEX "regional_releases_country_code_service_status_idx" ON "regional_releases"("country_code", "service_status");

ALTER TABLE "regional_releases"
    ADD CONSTRAINT "regional_releases_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "game_external_identities" (
    "id" UUID NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "regional_release_id" UUID,
    "provider" "CatalogIdentityProvider" NOT NULL,
    "external_id" VARCHAR(200) NOT NULL,
    "region_key" VARCHAR(16) NOT NULL DEFAULT 'GLOBAL',
    "provenance" "CatalogProvenance" NOT NULL DEFAULT 'UNKNOWN',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_external_identities_pkey" PRIMARY KEY ("id")
);

-- One provider key may only ever resolve to a single canonical game.
CREATE UNIQUE INDEX "game_external_identities_provider_external_id_region_key_key"
    ON "game_external_identities"("provider", "external_id", "region_key");
CREATE INDEX "game_external_identities_catalog_game_id_idx" ON "game_external_identities"("catalog_game_id");
CREATE INDEX "game_external_identities_provider_catalog_game_id_idx" ON "game_external_identities"("provider", "catalog_game_id");

ALTER TABLE "game_external_identities"
    ADD CONSTRAINT "game_external_identities_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_external_identities"
    ADD CONSTRAINT "game_external_identities_regional_release_id_fkey"
    FOREIGN KEY ("regional_release_id") REFERENCES "regional_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "game_assets" (
    "id" UUID NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "kind" "CatalogAssetKind" NOT NULL,
    "url" TEXT NOT NULL,
    "rights_status" "CatalogAssetRightsStatus" NOT NULL DEFAULT 'UNKNOWN',
    "provenance" "CatalogProvenance" NOT NULL DEFAULT 'UNKNOWN',
    "attribution" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "game_assets_catalog_game_id_kind_url_key" ON "game_assets"("catalog_game_id", "kind", "url");
CREATE INDEX "game_assets_catalog_game_id_kind_idx" ON "game_assets"("catalog_game_id", "kind");
CREATE INDEX "game_assets_rights_status_idx" ON "game_assets"("rights_status");

ALTER TABLE "game_assets"
    ADD CONSTRAINT "game_assets_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "game_submissions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "GameSubmissionStatus" NOT NULL DEFAULT 'PREVIEW',
    "input_type" "GameSubmissionInputType" NOT NULL,
    "input_fingerprint" CHAR(64) NOT NULL,
    "locale" VARCHAR(16) NOT NULL,
    "region_code" VARCHAR(8) NOT NULL,
    "platform_hint" VARCHAR(40),
    "draft" JSONB NOT NULL,
    "candidate_summary" JSONB,
    "clarifying_question" VARCHAR(300),
    "ai_model" VARCHAR(100),
    "ai_fallback_used" BOOLEAN NOT NULL DEFAULT false,
    "personal_catalog_game_id" UUID,
    "public_review_status" "CatalogPublicationStatus" NOT NULL DEFAULT 'PRIVATE',
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "game_submissions_user_id_created_at_idx" ON "game_submissions"("user_id", "created_at");
CREATE INDEX "game_submissions_status_created_at_idx" ON "game_submissions"("status", "created_at");
CREATE INDEX "game_submissions_user_id_input_fingerprint_created_at_idx"
    ON "game_submissions"("user_id", "input_fingerprint", "created_at");

ALTER TABLE "game_submissions"
    ADD CONSTRAINT "game_submissions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_submissions"
    ADD CONSTRAINT "game_submissions_personal_catalog_game_id_fkey"
    FOREIGN KEY ("personal_catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "game_field_evidence" (
    "id" UUID NOT NULL,
    "catalog_game_id" UUID,
    "submission_id" UUID,
    "field_path" VARCHAR(120) NOT NULL,
    "provenance" "CatalogProvenance" NOT NULL DEFAULT 'UNKNOWN',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source_type" VARCHAR(40) NOT NULL,
    "source_url" TEXT,
    "source_input_hash" CHAR(64),
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_field_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "game_field_evidence_catalog_game_id_field_path_idx" ON "game_field_evidence"("catalog_game_id", "field_path");
CREATE INDEX "game_field_evidence_submission_id_field_path_idx" ON "game_field_evidence"("submission_id", "field_path");

ALTER TABLE "game_field_evidence"
    ADD CONSTRAINT "game_field_evidence_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_field_evidence"
    ADD CONSTRAINT "game_field_evidence_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "game_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "catalog_merge_audits" (
    "id" UUID NOT NULL,
    "source_catalog_game_id" UUID NOT NULL,
    "target_catalog_game_id" UUID NOT NULL,
    "decision" "CatalogMergeDecision" NOT NULL,
    "reason_code" VARCHAR(60) NOT NULL,
    "evidence" JSONB,
    "actor_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_merge_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalog_merge_audits_source_catalog_game_id_created_at_idx" ON "catalog_merge_audits"("source_catalog_game_id", "created_at");
CREATE INDEX "catalog_merge_audits_target_catalog_game_id_created_at_idx" ON "catalog_merge_audits"("target_catalog_game_id", "created_at");
CREATE INDEX "catalog_merge_audits_decision_created_at_idx" ON "catalog_merge_audits"("decision", "created_at");

ALTER TABLE "catalog_merge_audits"
    ADD CONSTRAINT "catalog_merge_audits_source_catalog_game_id_fkey"
    FOREIGN KEY ("source_catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_merge_audits"
    ADD CONSTRAINT "catalog_merge_audits_target_catalog_game_id_fkey"
    FOREIGN KEY ("target_catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "game_follows" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "regional_release_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_follows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "game_follows_user_id_catalog_game_id_key" ON "game_follows"("user_id", "catalog_game_id");
CREATE INDEX "game_follows_user_id_created_at_idx" ON "game_follows"("user_id", "created_at");
CREATE INDEX "game_follows_catalog_game_id_created_at_idx" ON "game_follows"("catalog_game_id", "created_at");

ALTER TABLE "game_follows"
    ADD CONSTRAINT "game_follows_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_follows"
    ADD CONSTRAINT "game_follows_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_follows"
    ADD CONSTRAINT "game_follows_regional_release_id_fkey"
    FOREIGN KEY ("regional_release_id") REFERENCES "regional_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Additive canonical index columns on existing tables
-- ---------------------------------------------------------------------------

ALTER TABLE "reviews" ADD COLUMN "catalog_game_id" UUID;
ALTER TABLE "favorite_games" ADD COLUMN "catalog_game_id" UUID;
ALTER TABLE "user_game_library" ADD COLUMN "catalog_game_id" UUID;
ALTER TABLE "user_activity_events" ADD COLUMN "catalog_game_id" UUID;

CREATE INDEX "reviews_catalog_game_id_created_at_idx" ON "reviews"("catalog_game_id", "created_at");
CREATE INDEX "favorite_games_catalog_game_id_idx" ON "favorite_games"("catalog_game_id");
CREATE INDEX "user_game_library_catalog_game_id_idx" ON "user_game_library"("catalog_game_id");
CREATE INDEX "user_game_library_user_id_catalog_game_id_idx" ON "user_game_library"("user_id", "catalog_game_id");
CREATE INDEX "user_activity_events_catalog_game_id_created_at_idx" ON "user_activity_events"("catalog_game_id", "created_at");

ALTER TABLE "reviews"
    ADD CONSTRAINT "reviews_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "favorite_games"
    ADD CONSTRAINT "favorite_games_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "user_game_library"
    ADD CONSTRAINT "user_game_library_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "user_activity_events"
    ADD CONSTRAINT "user_activity_events_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill: collect every distinct legacy provider identity
-- ---------------------------------------------------------------------------
--
-- reviews.game_id and favorite_games.game_id are IGDB game ids (they are
-- resolved through igdbService.getGamesByIds by the library module), so they
-- are collected as IGDB identities.

CREATE TEMPORARY TABLE "tmp_legacy_identity" (
    "provider" "CatalogIdentityProvider" NOT NULL,
    "external_id" VARCHAR(200) NOT NULL,
    "title" VARCHAR(300),
    "title_from_provider_sync" BOOLEAN NOT NULL DEFAULT false
) ON COMMIT DROP;

-- Library entries: the only legacy source that also carries a game title.
INSERT INTO "tmp_legacy_identity" ("provider", "external_id", "title", "title_from_provider_sync")
SELECT
    CASE WHEN "game_source" = 'STEAM' THEN 'STEAM'::"CatalogIdentityProvider" ELSE 'IGDB'::"CatalogIdentityProvider" END,
    btrim("external_game_id"),
    (array_agg("game_name" ORDER BY "updated_at" DESC))[1],
    true
FROM "user_game_library"
WHERE btrim(COALESCE("external_game_id", '')) <> ''
GROUP BY 1, 2;

INSERT INTO "tmp_legacy_identity" ("provider", "external_id", "title", "title_from_provider_sync")
SELECT 'IGDB'::"CatalogIdentityProvider", btrim("game_id"), NULL, false
FROM "reviews"
WHERE btrim(COALESCE("game_id", '')) <> ''
GROUP BY 2;

INSERT INTO "tmp_legacy_identity" ("provider", "external_id", "title", "title_from_provider_sync")
SELECT 'IGDB'::"CatalogIdentityProvider", btrim("game_id"), NULL, false
FROM "favorite_games"
WHERE btrim(COALESCE("game_id", '')) <> ''
GROUP BY 2;

INSERT INTO "tmp_legacy_identity" ("provider", "external_id", "title", "title_from_provider_sync")
SELECT
    CASE WHEN "game_source" = 'STEAM' THEN 'STEAM'::"CatalogIdentityProvider" ELSE 'IGDB'::"CatalogIdentityProvider" END,
    btrim("external_game_id"),
    NULL,
    false
FROM "user_activity_events"
WHERE "game_source" IS NOT NULL AND btrim(COALESCE("external_game_id", '')) <> ''
GROUP BY 1, 2;

INSERT INTO "tmp_legacy_identity" ("provider", "external_id", "title", "title_from_provider_sync")
SELECT 'IGDB'::"CatalogIdentityProvider", btrim("igdb_game_id"), NULL, false
FROM "user_activity_events"
WHERE btrim(COALESCE("igdb_game_id", '')) <> ''
GROUP BY 2;

-- Collapse to one row per (provider, external_id), preferring a provider-synced
-- title when one of the contributing rows had it.
CREATE TEMPORARY TABLE "tmp_canonical_seed" (
    "provider" "CatalogIdentityProvider" NOT NULL,
    "external_id" VARCHAR(200) NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "title_provenance" "CatalogProvenance" NOT NULL
) ON COMMIT DROP;

INSERT INTO "tmp_canonical_seed" ("provider", "external_id", "catalog_game_id", "title", "title_provenance")
SELECT
    "provider",
    "external_id",
    gen_random_uuid(),
    COALESCE(
        (array_agg("title" ORDER BY "title_from_provider_sync" DESC, "title") FILTER (WHERE "title" IS NOT NULL AND btrim("title") <> ''))[1],
        "provider"::text || ':' || "external_id"
    ),
    CASE
        WHEN bool_or("title_from_provider_sync" AND "title" IS NOT NULL AND btrim("title") <> '')
            THEN 'PROVIDER_VERIFIED'::"CatalogProvenance"
        ELSE 'UNKNOWN'::"CatalogProvenance"
    END
FROM "tmp_legacy_identity"
GROUP BY 1, 2;

INSERT INTO "catalog_games" (
    "id", "original_title", "normalized_title", "genres", "steam_tags", "platforms",
    "publication_status", "title_provenance", "created_at", "updated_at"
)
SELECT
    "catalog_game_id",
    left("title", 300),
    -- Deterministic normalization mirrored by src/modules/catalog/catalog-title.util.js:
    -- lowercase, strip everything that is not a letter/digit/space, collapse spaces.
    left(btrim(regexp_replace(lower("title"), '[^a-z0-9가-힣ぁ-んァ-ヶ一-龯]+', ' ', 'g')), 300),
    ARRAY[]::TEXT[],
    ARRAY[]::TEXT[],
    CASE WHEN "provider" = 'STEAM' THEN ARRAY['STEAM']::TEXT[] ELSE ARRAY[]::TEXT[] END,
    -- Legacy provider-sourced games are already publicly visible catalog facts.
    'PUBLISHED'::"CatalogPublicationStatus",
    "title_provenance",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "tmp_canonical_seed";

INSERT INTO "game_external_identities" (
    "id", "catalog_game_id", "provider", "external_id", "region_key",
    "provenance", "confidence", "created_at", "updated_at"
)
SELECT
    gen_random_uuid(),
    "catalog_game_id",
    "provider",
    "external_id",
    'GLOBAL',
    'PROVIDER_VERIFIED'::"CatalogProvenance",
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "tmp_canonical_seed";

INSERT INTO "game_localizations" (
    "id", "catalog_game_id", "kind", "language_code", "region_code",
    "title", "normalized_title", "provenance", "created_at", "updated_at"
)
SELECT
    gen_random_uuid(),
    "catalog_game_id",
    'ORIGINAL_TITLE'::"CatalogLocalizationKind",
    'und',
    'GLOBAL',
    left("title", 300),
    left(btrim(regexp_replace(lower("title"), '[^a-z0-9가-힣ぁ-んァ-ヶ一-龯]+', ' ', 'g')), 300),
    "title_provenance",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "tmp_canonical_seed"
WHERE "title_provenance" = 'PROVIDER_VERIFIED';

-- ---------------------------------------------------------------------------
-- Backfill: merge CONFIRMED Steam↔IGDB mappings only
-- ---------------------------------------------------------------------------

CREATE TEMPORARY TABLE "tmp_confirmed_merge" (
    "source_catalog_game_id" UUID NOT NULL,
    "target_catalog_game_id" UUID NOT NULL,
    "steam_appid" VARCHAR(100) NOT NULL,
    "igdb_game_id" VARCHAR(100) NOT NULL,
    "confidence_score" DOUBLE PRECISION NOT NULL
) ON COMMIT DROP;

INSERT INTO "tmp_confirmed_merge" (
    "source_catalog_game_id", "target_catalog_game_id", "steam_appid", "igdb_game_id", "confidence_score"
)
SELECT
    steam_seed."catalog_game_id",
    igdb_seed."catalog_game_id",
    mapping."steam_appid",
    mapping."igdb_game_id",
    mapping."confidence_score"
FROM "steam_igdb_mappings" AS mapping
JOIN "tmp_canonical_seed" AS steam_seed
    ON steam_seed."provider" = 'STEAM' AND steam_seed."external_id" = btrim(mapping."steam_appid")
JOIN "tmp_canonical_seed" AS igdb_seed
    ON igdb_seed."provider" = 'IGDB' AND igdb_seed."external_id" = btrim(mapping."igdb_game_id")
-- CONFIRMED is the only status that may collapse two canonical games.
WHERE mapping."match_status" = 'CONFIRMED'
  AND btrim(COALESCE(mapping."igdb_game_id", '')) <> ''
  AND steam_seed."catalog_game_id" <> igdb_seed."catalog_game_id";

-- Repoint the Steam provider key onto the IGDB canonical game.
UPDATE "game_external_identities" AS identity
SET "catalog_game_id" = merge."target_catalog_game_id",
    "updated_at" = CURRENT_TIMESTAMP
FROM "tmp_confirmed_merge" AS merge
WHERE identity."provider" = 'STEAM'
  AND identity."region_key" = 'GLOBAL'
  AND identity."external_id" = btrim(merge."steam_appid");

-- Keep the Steam-side row as a tombstone so reads can resolve historical ids.
UPDATE "catalog_games" AS game
SET "merged_into_catalog_game_id" = merge."target_catalog_game_id",
    "publication_status" = 'PRIVATE',
    "updated_at" = CURRENT_TIMESTAMP
FROM "tmp_confirmed_merge" AS merge
WHERE game."id" = merge."source_catalog_game_id";

-- Carry the Steam platform marker onto the surviving canonical game.
UPDATE "catalog_games" AS game
SET "platforms" = (
        SELECT array_agg(DISTINCT platform ORDER BY platform)
        FROM unnest(game."platforms" || ARRAY['STEAM']::TEXT[]) AS platform
    ),
    "updated_at" = CURRENT_TIMESTAMP
FROM "tmp_confirmed_merge" AS merge
WHERE game."id" = merge."target_catalog_game_id";

INSERT INTO "catalog_merge_audits" (
    "id", "source_catalog_game_id", "target_catalog_game_id", "decision",
    "reason_code", "evidence", "actor_user_id", "created_at"
)
SELECT
    gen_random_uuid(),
    "source_catalog_game_id",
    "target_catalog_game_id",
    'CONFIRMED_MAPPING_MERGE'::"CatalogMergeDecision",
    'steam_igdb_mapping_confirmed',
    jsonb_build_object(
        'mappingStatus', 'CONFIRMED',
        'confidenceScore', "confidence_score",
        'migration', '20260730120000_create_catalog_game_identity'
    ),
    NULL,
    CURRENT_TIMESTAMP
FROM "tmp_confirmed_merge";

-- ---------------------------------------------------------------------------
-- Backfill: attach the resolved canonical id to legacy rows
-- ---------------------------------------------------------------------------
--
-- The join goes through game_external_identities (already repointed above), so
-- every legacy row lands on the surviving canonical game rather than a
-- tombstone.

UPDATE "user_game_library" AS entry
SET "catalog_game_id" = identity."catalog_game_id"
FROM "game_external_identities" AS identity
WHERE identity."region_key" = 'GLOBAL'
  AND identity."external_id" = btrim(entry."external_game_id")
  AND identity."provider" = (
      CASE WHEN entry."game_source" = 'STEAM' THEN 'STEAM'::"CatalogIdentityProvider" ELSE 'IGDB'::"CatalogIdentityProvider" END
  );

UPDATE "reviews" AS review
SET "catalog_game_id" = identity."catalog_game_id"
FROM "game_external_identities" AS identity
WHERE identity."provider" = 'IGDB'
  AND identity."region_key" = 'GLOBAL'
  AND identity."external_id" = btrim(review."game_id");

UPDATE "favorite_games" AS favorite
SET "catalog_game_id" = identity."catalog_game_id"
FROM "game_external_identities" AS identity
WHERE identity."provider" = 'IGDB'
  AND identity."region_key" = 'GLOBAL'
  AND identity."external_id" = btrim(favorite."game_id");

-- Activity events prefer their explicit IGDB id, then their own source key.
UPDATE "user_activity_events" AS event
SET "catalog_game_id" = identity."catalog_game_id"
FROM "game_external_identities" AS identity
WHERE identity."provider" = 'IGDB'
  AND identity."region_key" = 'GLOBAL'
  AND btrim(COALESCE(event."igdb_game_id", '')) <> ''
  AND identity."external_id" = btrim(event."igdb_game_id");

UPDATE "user_activity_events" AS event
SET "catalog_game_id" = identity."catalog_game_id"
FROM "game_external_identities" AS identity
WHERE event."catalog_game_id" IS NULL
  AND event."game_source" IS NOT NULL
  AND identity."region_key" = 'GLOBAL'
  AND btrim(COALESCE(event."external_game_id", '')) <> ''
  AND identity."external_id" = btrim(event."external_game_id")
  AND identity."provider" = (
      CASE WHEN event."game_source" = 'STEAM' THEN 'STEAM'::"CatalogIdentityProvider" ELSE 'IGDB'::"CatalogIdentityProvider" END
  );

COMMIT;
