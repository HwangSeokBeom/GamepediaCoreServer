ALTER TABLE "reviews"
  DROP CONSTRAINT IF EXISTS "reviews_user_id_game_id_key";

CREATE INDEX IF NOT EXISTS "reviews_user_id_game_id_created_at_idx"
  ON "reviews"("user_id", "game_id", "created_at");
