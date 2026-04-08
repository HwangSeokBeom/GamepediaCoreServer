DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "reviews"
    GROUP BY "user_id", "game_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot restore reviews_user_id_game_id_key because duplicate review rows exist';
  END IF;
END
$$;

DROP INDEX IF EXISTS "reviews_user_id_game_id_created_at_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "reviews_user_id_game_id_key"
  ON "reviews"("user_id", "game_id");

CREATE INDEX IF NOT EXISTS "reviews_user_id_game_id_created_at_idx"
  ON "reviews"("user_id", "game_id", "created_at");
