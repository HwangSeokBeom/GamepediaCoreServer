CREATE TABLE "steam_igdb_mappings" (
    "id" UUID NOT NULL,
    "steam_appid" VARCHAR(100) NOT NULL,
    "igdb_game_id" VARCHAR(100),
    "matched_title" VARCHAR(200),
    "confidence_score" DOUBLE PRECISION NOT NULL,
    "matched_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steam_igdb_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "steam_igdb_mappings_steam_appid_key"
ON "steam_igdb_mappings"("steam_appid");

CREATE INDEX "steam_igdb_mappings_igdb_game_id_idx"
ON "steam_igdb_mappings"("igdb_game_id");
