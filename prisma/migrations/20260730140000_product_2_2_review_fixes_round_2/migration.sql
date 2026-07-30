-- Product 2.2 — corrections from the second independent review.
--
-- Additive successor migration. None of the five earlier Product 2.2 migrations is
-- modified. No legacy identity column is dropped or retyped, no catalogGameId
-- reference is deleted, and nothing is merged onto another canonical game.
--
-- The central change: game_external_identities becomes a verified-only table,
-- enforced by CHECK constraints rather than by convention. An unverified legacy row
-- sitting in that table is what let a user-supplied appid capture another account's
-- real Steam sync, because the sync found the row, adopted its canonical game, and
-- kept the attacker's public title.
--
-- Contents:
--   1. move every unverified global identity into game_identity_claims
--   2. delete the moved rows from the global table
--   3. demote every PUBLISHED game whose title provenance is unverified
--   4. demote localizations that inherited a verified provenance they never earned
--   5. make the verified columns NOT NULL and add the CHECK constraints

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Move unverified global identities into the claim table
-- ---------------------------------------------------------------------------
--
-- "Verified" means all three of: a verified provenance value, a verifiedAt, and a
-- verificationSource. Anything short of that is a claim, whatever produced it.
--
-- claim_source records where the row came from rather than inventing a provenance
-- story. claimed_by_user_id and submission_id stay NULL because the first backfill
-- derived these rows from aggregate legacy data and no single account or submission
-- can honestly be named as their origin.

INSERT INTO "game_identity_claims" (
    "id", "catalog_game_id", "submission_id", "claimed_by_user_id", "provider",
    "external_id", "region_key", "provenance", "claim_source", "created_at", "updated_at"
)
SELECT
    gen_random_uuid(),
    identity."catalog_game_id",
    NULL,
    NULL,
    identity."provider",
    identity."external_id",
    identity."region_key",
    -- A claim may not assert verified provenance; UNKNOWN is the honest value for a
    -- row whose origin cannot be established.
    'UNKNOWN'::"CatalogProvenance",
    'legacy_backfill_unverified',
    identity."created_at",
    CURRENT_TIMESTAMP
FROM "game_external_identities" AS identity
WHERE identity."verified_at" IS NULL
   OR identity."verification_source" IS NULL
   OR identity."provenance" NOT IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED')
ON CONFLICT ("catalog_game_id", "provider", "external_id", "region_key") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Remove the moved rows from the verified-only table
-- ---------------------------------------------------------------------------
--
-- The legacy columns on user_game_library, reviews, favorite_games and
-- user_activity_events are untouched, and their catalog_game_id values are left
-- exactly as they are. A row may now point at a game that has no verified identity;
-- that is accurate, and it is what the claim table records.

DELETE FROM "game_external_identities"
WHERE "verified_at" IS NULL
   OR "verification_source" IS NULL
   OR "provenance" NOT IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED');

-- ---------------------------------------------------------------------------
-- 3. Demote every PUBLISHED game whose title provenance is unverified
-- ---------------------------------------------------------------------------
--
-- The round-1 migration only demoted synthetic "PROVIDER:id" placeholders, so a
-- legacy title that merely *looked* like a real game name stayed publicly
-- searchable with UNKNOWN provenance. Realistic-looking text is not evidence, so
-- the rule is now the provenance itself, not the shape of the string.

UPDATE "catalog_games"
SET "publication_status" = 'PENDING_REVIEW',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "publication_status" = 'PUBLISHED'
  AND "title_provenance" NOT IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED');

-- ---------------------------------------------------------------------------
-- 4. Demote localizations that never earned a verified provenance
-- ---------------------------------------------------------------------------
--
-- The first backfill wrote ORIGINAL_TITLE localizations with PROVIDER_VERIFIED for
-- any game that had a library game_name, which a user could have supplied. A
-- localization can only be verified if its game's title provenance is.

UPDATE "game_localizations" AS localization
SET "provenance" = 'UNKNOWN',
    "updated_at" = CURRENT_TIMESTAMP
FROM "catalog_games" AS game
WHERE game."id" = localization."catalog_game_id"
  AND localization."provenance" IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED')
  AND game."title_provenance" NOT IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED');

-- ---------------------------------------------------------------------------
-- 5. DB-level invariants
-- ---------------------------------------------------------------------------
--
-- These are the properties the application also enforces. Stating them in the
-- database means a future code path, a manual fix or a bad migration cannot quietly
-- reintroduce an unverified global identity or a published unverified title.

ALTER TABLE "game_external_identities" ALTER COLUMN "verified_at" SET NOT NULL;
ALTER TABLE "game_external_identities" ALTER COLUMN "verification_source" SET NOT NULL;

ALTER TABLE "game_external_identities"
    ADD CONSTRAINT "game_external_identities_verified_provenance_check"
    CHECK ("provenance" IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED'));

ALTER TABLE "game_external_identities"
    ADD CONSTRAINT "game_external_identities_verification_source_present_check"
    CHECK (btrim("verification_source") <> '');

-- A publicly visible catalog game must be backed by verified title provenance.
ALTER TABLE "catalog_games"
    ADD CONSTRAINT "catalog_games_published_requires_verified_title_check"
    CHECK (
        "publication_status" <> 'PUBLISHED'
        OR "title_provenance" IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED')
    );

-- A claim may never assert verified provenance; that is the whole point of the
-- separate table.
ALTER TABLE "game_identity_claims"
    ADD CONSTRAINT "game_identity_claims_unverified_provenance_check"
    CHECK ("provenance" NOT IN ('PROVIDER_VERIFIED', 'OFFICIAL_SOURCE', 'EDITOR_VERIFIED'));

COMMIT;
