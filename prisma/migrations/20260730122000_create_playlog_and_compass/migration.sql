-- Product 2.2 — Playlog, client mutation idempotency and Play Compass feedback.
--
-- Additive only. play_sessions.(user_id, client_mutation_id) is unique so a
-- retried create can never produce a duplicate session, and every read/write
-- path filters by user_id for ownership.

BEGIN;

CREATE TYPE "PlaySessionOutcome" AS ENUM ('CONTINUE', 'PAUSED', 'DROPPED', 'COMPLETED');
CREATE TYPE "PlaySessionVisibility" AS ENUM ('PRIVATE', 'FRIENDS', 'PUBLIC');
CREATE TYPE "PlaySessionMood" AS ENUM ('RELAXED', 'FOCUSED', 'EXCITED', 'BORED', 'FRUSTRATED', 'NOSTALGIC');
CREATE TYPE "PlayCompassAction" AS ENUM ('SELECTED', 'EXCLUDED', 'SNOOZED', 'PLAY_CONFIRMED');

CREATE TABLE "play_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "regional_release_id" UUID,
    "played_at" TIMESTAMP(3) NOT NULL,
    "duration_minutes" INTEGER,
    "progress_percent" INTEGER,
    "mood" "PlaySessionMood",
    -- Private user content. Never logged, never emitted as an event property.
    "note" VARCHAR(2000),
    "outcome" "PlaySessionOutcome" NOT NULL,
    "visibility" "PlaySessionVisibility" NOT NULL DEFAULT 'PRIVATE',
    "provenance" "CatalogProvenance" NOT NULL DEFAULT 'USER_CONFIRMED',
    "client_mutation_id" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "play_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "play_sessions_user_id_client_mutation_id_key" ON "play_sessions"("user_id", "client_mutation_id");
CREATE INDEX "play_sessions_user_id_played_at_idx" ON "play_sessions"("user_id", "played_at");
CREATE INDEX "play_sessions_user_id_catalog_game_id_played_at_idx" ON "play_sessions"("user_id", "catalog_game_id", "played_at");
CREATE INDEX "play_sessions_user_id_outcome_played_at_idx" ON "play_sessions"("user_id", "outcome", "played_at");

ALTER TABLE "play_sessions"
    ADD CONSTRAINT "play_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "play_sessions"
    ADD CONSTRAINT "play_sessions_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "play_sessions"
    ADD CONSTRAINT "play_sessions_regional_release_id_fkey"
    FOREIGN KEY ("regional_release_id") REFERENCES "regional_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "client_mutation_receipts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scope" VARCHAR(60) NOT NULL,
    "client_mutation_id" VARCHAR(120) NOT NULL,
    "resource_id" VARCHAR(120),
    "outcome_code" VARCHAR(60) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_mutation_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_mutation_receipts_user_id_scope_client_mutation_id_key"
    ON "client_mutation_receipts"("user_id", "scope", "client_mutation_id");
CREATE INDEX "client_mutation_receipts_user_id_created_at_idx" ON "client_mutation_receipts"("user_id", "created_at");

ALTER TABLE "client_mutation_receipts"
    ADD CONSTRAINT "client_mutation_receipts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "play_compass_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "action" "PlayCompassAction" NOT NULL,
    -- SHA-256 of the structured compass request; never the raw request text.
    "request_hash" CHAR(64),
    "reason_codes" TEXT[],
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "play_compass_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "play_compass_events_user_id_occurred_at_idx" ON "play_compass_events"("user_id", "occurred_at");
CREATE INDEX "play_compass_events_user_id_catalog_game_id_action_occurred_idx"
    ON "play_compass_events"("user_id", "catalog_game_id", "action", "occurred_at");

ALTER TABLE "play_compass_events"
    ADD CONSTRAINT "play_compass_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "play_compass_events"
    ADD CONSTRAINT "play_compass_events_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
