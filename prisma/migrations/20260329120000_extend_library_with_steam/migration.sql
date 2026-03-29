CREATE TYPE "GameSource" AS ENUM ('STEAM', 'IGDB');

CREATE TYPE "GameLibraryStatus" AS ENUM ('PLAYING', 'COMPLETED', 'DROPPED');

ALTER TABLE "social_accounts"
ADD COLUMN "persona_name" VARCHAR(100),
ADD COLUMN "profile_url" TEXT,
ADD COLUMN "avatar_url" TEXT,
ADD COLUMN "linked_at" TIMESTAMP(3),
ADD COLUMN "updated_at" TIMESTAMP(3);

UPDATE "social_accounts"
SET
  "linked_at" = "created_at",
  "updated_at" = "created_at"
WHERE "linked_at" IS NULL
   OR "updated_at" IS NULL;

ALTER TABLE "social_accounts"
ALTER COLUMN "linked_at" SET NOT NULL,
ALTER COLUMN "linked_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "user_game_library" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "game_source" "GameSource" NOT NULL,
    "external_game_id" VARCHAR(100) NOT NULL,
    "game_name" VARCHAR(200) NOT NULL,
    "cover_url" TEXT,
    "status" "GameLibraryStatus" NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "last_played_at" TIMESTAMP(3),
    "playtime_minutes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_game_library_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_game_library_user_id_game_source_external_game_id_key"
ON "user_game_library"("user_id", "game_source", "external_game_id");

CREATE INDEX "user_game_library_user_id_status_updated_at_idx"
ON "user_game_library"("user_id", "status", "updated_at");

CREATE INDEX "user_game_library_user_id_game_source_idx"
ON "user_game_library"("user_id", "game_source");

ALTER TABLE "user_game_library"
ADD CONSTRAINT "user_game_library_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
