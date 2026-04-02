CREATE TYPE "UserActivityType" AS ENUM (
    'REVIEW_CREATED',
    'REVIEW_UPDATED',
    'LIKED_GAME_ADDED',
    'LIKED_GAME_REMOVED',
    'RATING_CHANGED',
    'PLAY_STATUS_CHANGED',
    'STEAM_RECENTLY_PLAYED_SYNC'
);

CREATE TYPE "UserPresenceState" AS ENUM (
    'ONLINE',
    'RECENTLY_ACTIVE',
    'PLAYING',
    'LAST_PLAYED',
    'UNKNOWN'
);

ALTER TABLE "user_notifications"
ADD COLUMN "dedupe_key" VARCHAR(160),
ADD COLUMN "payload" JSONB;

CREATE INDEX "user_notifications_user_id_dedupe_key_created_at_idx"
ON "user_notifications"("user_id", "dedupe_key", "created_at");

CREATE TABLE "user_activity_events" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "activity_type" "UserActivityType" NOT NULL,
    "game_source" "GameSource",
    "external_game_id" VARCHAR(100),
    "igdb_game_id" VARCHAR(100),
    "dedupe_key" VARCHAR(160),
    "metadata" JSONB,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_activity_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_activity_events_actor_user_id_created_at_idx"
ON "user_activity_events"("actor_user_id", "created_at");

CREATE INDEX "user_activity_events_activity_type_created_at_idx"
ON "user_activity_events"("activity_type", "created_at");

CREATE INDEX "user_activity_events_game_source_external_game_id_created_at_idx"
ON "user_activity_events"("game_source", "external_game_id", "created_at");

CREATE INDEX "user_activity_events_dedupe_key_created_at_idx"
ON "user_activity_events"("dedupe_key", "created_at");

ALTER TABLE "user_activity_events"
ADD CONSTRAINT "user_activity_events_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "user_presence_snapshots" (
    "user_id" UUID NOT NULL,
    "state" "UserPresenceState" NOT NULL DEFAULT 'UNKNOWN',
    "source" VARCHAR(50),
    "game_source" "GameSource",
    "external_game_id" VARCHAR(100),
    "last_active_at" TIMESTAMP(3),
    "last_played_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_presence_snapshots_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX "user_presence_snapshots_state_updated_at_idx"
ON "user_presence_snapshots"("state", "updated_at");

ALTER TABLE "user_presence_snapshots"
ADD CONSTRAINT "user_presence_snapshots_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
