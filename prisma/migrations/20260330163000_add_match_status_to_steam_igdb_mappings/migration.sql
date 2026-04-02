CREATE TYPE "SteamIgdbMatchStatus" AS ENUM ('CONFIRMED', 'CANDIDATE', 'UNMATCHED', 'REJECTED');

ALTER TABLE "steam_igdb_mappings"
ADD COLUMN "match_status" "SteamIgdbMatchStatus" NOT NULL DEFAULT 'UNMATCHED';

UPDATE "steam_igdb_mappings"
SET "match_status" = CASE
  WHEN "confidence_score" >= 0.95 AND "igdb_game_id" IS NOT NULL THEN 'CONFIRMED'::"SteamIgdbMatchStatus"
  WHEN "igdb_game_id" IS NOT NULL OR "matched_title" IS NOT NULL THEN 'CANDIDATE'::"SteamIgdbMatchStatus"
  ELSE 'UNMATCHED'::"SteamIgdbMatchStatus"
END;

UPDATE "steam_igdb_mappings"
SET "igdb_game_id" = NULL
WHERE "match_status" <> 'CONFIRMED'::"SteamIgdbMatchStatus";
