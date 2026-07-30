-- Product 2.2 — corrections from the independent Codex review.
--
-- Additive successor migration. None of the four earlier Product 2.2 migrations is
-- modified: they are already applied, so every correction here is a new forward
-- step. No table or column is dropped and no legacy identity column is retyped.
--
-- Contents:
--   1. ownership provenance on user_game_library
--   2. verification state on game_external_identities
--   3. game_identity_claims, for unverified provider-key claims
--   4. a real current-revision foreign key on editorial_articles
--   5. correction of legacy provenance that the first backfill overstated
--   6. Unicode-safe recomputation of every stored normalized title

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Ownership provenance
-- ---------------------------------------------------------------------------
--
-- gameSource is a label a client can set on a manual library write, so it can
-- never be used to infer that ownership was provider verified. The default is
-- UNKNOWN: existing rows may have come from a real Steam sync or from a manual
-- POST /users/me/library/status, and the two are indistinguishable after the
-- fact, so claiming PROVIDER_VERIFIED for them would be a fabrication.

-- No dedicated index: the column has three values, and every read that filters on
-- it already narrows by user_id first through user_game_library_user_id_* indexes.
ALTER TABLE "user_game_library"
    ADD COLUMN "ownership_provenance" "CatalogProvenance" NOT NULL DEFAULT 'UNKNOWN';

-- ---------------------------------------------------------------------------
-- 2. Verification state on the global identity table
-- ---------------------------------------------------------------------------

ALTER TABLE "game_external_identities" ADD COLUMN "verified_at" TIMESTAMP(3);
ALTER TABLE "game_external_identities" ADD COLUMN "verification_source" VARCHAR(60);

CREATE INDEX "game_external_identities_verified_at_idx"
    ON "game_external_identities"("verified_at");

-- ---------------------------------------------------------------------------
-- 3. Unverified provider-key claims
-- ---------------------------------------------------------------------------
--
-- Scoped per catalog game, NOT globally unique. A quick-add submission parses the
-- syntax of a store URL, which proves nothing; if such a claim occupied the
-- globally unique provider key it would let one account squat that key and
-- capture another account's future real provider sync.

CREATE TABLE "game_identity_claims" (
    "id" UUID NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "submission_id" UUID,
    "claimed_by_user_id" UUID,
    "provider" "CatalogIdentityProvider" NOT NULL,
    "external_id" VARCHAR(200) NOT NULL,
    "region_key" VARCHAR(16) NOT NULL DEFAULT 'GLOBAL',
    "provenance" "CatalogProvenance" NOT NULL DEFAULT 'USER_CONFIRMED',
    "claim_source" VARCHAR(60) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_identity_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "game_identity_claims_catalog_game_id_provider_external_id_r_key"
    ON "game_identity_claims"("catalog_game_id", "provider", "external_id", "region_key");
CREATE INDEX "game_identity_claims_provider_external_id_region_key_idx"
    ON "game_identity_claims"("provider", "external_id", "region_key");
CREATE INDEX "game_identity_claims_submission_id_idx" ON "game_identity_claims"("submission_id");

ALTER TABLE "game_identity_claims"
    ADD CONSTRAINT "game_identity_claims_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_identity_claims"
    ADD CONSTRAINT "game_identity_claims_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "game_submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Current revision foreign key
-- ---------------------------------------------------------------------------
--
-- current_revision_id already existed as a bare column that nothing ever wrote.
-- It becomes a real, unique, enforced reference so the public magazine endpoint
-- always has one definite revision whose body it serves.

UPDATE "editorial_articles" AS article
SET "current_revision_id" = latest."id"
FROM (
    SELECT DISTINCT ON ("article_id") "article_id", "id"
    FROM "article_revisions"
    ORDER BY "article_id", "revision_number" DESC
) AS latest
WHERE article."id" = latest."article_id"
  AND article."current_revision_id" IS NULL;

CREATE UNIQUE INDEX "editorial_articles_current_revision_id_key"
    ON "editorial_articles"("current_revision_id");

ALTER TABLE "editorial_articles"
    ADD CONSTRAINT "editorial_articles_current_revision_id_fkey"
    FOREIGN KEY ("current_revision_id") REFERENCES "article_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Correct overstated legacy provenance
-- ---------------------------------------------------------------------------
--
-- The first backfill wrote provenance PROVIDER_VERIFIED with confidence 1 for
-- every legacy identity, and PROVIDER_VERIFIED titles for anything that had a
-- library game_name. Nothing was actually verified against a provider at
-- migration time: the values came from rows a user could have created manually.
-- They are corrected to UNKNOWN with confidence 0 and verified_at NULL.
--
-- The rows stay in place. A later real provider response promotes them by setting
-- verified_at, so an unverified legacy row never blocks legitimate verification.

UPDATE "game_external_identities"
SET "provenance" = 'UNKNOWN',
    "confidence" = 0,
    "verified_at" = NULL,
    "verification_source" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "provenance" = 'PROVIDER_VERIFIED'
  AND "verified_at" IS NULL;

UPDATE "catalog_games"
SET "title_provenance" = 'UNKNOWN',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "title_provenance" = 'PROVIDER_VERIFIED'
  AND NOT EXISTS (
      SELECT 1 FROM "game_external_identities" identity
      WHERE identity."catalog_game_id" = "catalog_games"."id"
        AND identity."verified_at" IS NOT NULL
  );

-- A synthetic "PROVIDER:id" placeholder title carries no information at all, so it
-- must not be publicly searchable. PENDING_REVIEW keeps the row usable for
-- identity resolution while excluding it from public visibility.
UPDATE "catalog_games"
SET "publication_status" = 'PENDING_REVIEW',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "publication_status" = 'PUBLISHED'
  AND "merged_into_catalog_game_id" IS NULL
  AND "original_title" ~ '^(IGDB|STEAM|APPLE_APP_STORE|GOOGLE_PLAY|OFFICIAL_SITE|COMMUNITY):';

-- ---------------------------------------------------------------------------
-- 6. Unicode-safe normalized titles
-- ---------------------------------------------------------------------------
--
-- The original normalization retained only ASCII, Hangul, Hiragana, Katakana and
-- CJK ideographs, so Thai, Arabic, Cyrillic, Hebrew, Greek and Devanagari titles
-- normalized to an empty string and became impossible to find. It also split
-- "Pokémon" on its accent and "ゲーム" on the prolonged sound mark.
--
-- The expression below is the exact SQL counterpart of normalizeTitle() in
-- src/modules/catalog/catalog-title.util.js:
--
--   strip trademark/copyright symbols -> NFKC -> lowercase -> collapse every run
--   that is neither a Unicode letter, a Unicode number, nor a retained combining
--   mark into one space -> trim.
--
-- The symbols are stripped before NFKC because NFKC folds U+2122 into the letters
-- "TM", which would otherwise turn "Hollow Knight™" into "hollow knighttm".
--
-- PostgreSQL classifies combining marks as [:punct:], so the retained marks are
-- whitelisted explicitly. That whitelist is rendered by buildRetainedMarkClass()
-- and appears here verbatim; a unit test asserts the two are identical, and the
-- PostgreSQL gate proves byte-level parity over a multi-script corpus.

UPDATE "catalog_games"
SET "normalized_title" = left(btrim(regexp_replace(lower(normalize(translate("original_title", '™℠®©℗', ''), NFKC)), '[^[:alnum:]̀-ͯ҃-҉֑-ׇؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭऀ-ःऺ-ॏ॑-ॗॢ-ॣัิ-ฺ็-๎ັິ-ຼ່-ໍ᪰-᫿᷀-゙᷿-゚︠-︯]+', ' ', 'g')), 300),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "normalized_title" <> left(btrim(regexp_replace(lower(normalize(translate("original_title", '™℠®©℗', ''), NFKC)), '[^[:alnum:]̀-ͯ҃-҉֑-ׇؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭऀ-ःऺ-ॏ॑-ॗॢ-ॣัิ-ฺ็-๎ັິ-ຼ່-ໍ᪰-᫿᷀-゙᷿-゚︠-︯]+', ' ', 'g')), 300);

UPDATE "game_localizations"
SET "normalized_title" = left(btrim(regexp_replace(lower(normalize(translate("title", '™℠®©℗', ''), NFKC)), '[^[:alnum:]̀-ͯ҃-҉֑-ׇؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭऀ-ःऺ-ॏ॑-ॗॢ-ॣัิ-ฺ็-๎ັິ-ຼ່-ໍ᪰-᫿᷀-゙᷿-゚︠-︯]+', ' ', 'g')), 300),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "normalized_title" <> left(btrim(regexp_replace(lower(normalize(translate("title", '™℠®©℗', ''), NFKC)), '[^[:alnum:]̀-ͯ҃-҉֑-ׇؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭऀ-ःऺ-ॏ॑-ॗॢ-ॣัิ-ฺ็-๎ັິ-ຼ່-ໍ᪰-᫿᷀-゙᷿-゚︠-︯]+', ' ', 'g')), 300);

COMMIT;
