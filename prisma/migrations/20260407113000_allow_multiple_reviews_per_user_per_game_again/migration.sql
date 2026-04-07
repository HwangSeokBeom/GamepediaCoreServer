-- Restore multi-review support by removing any user/game uniqueness enforcement
-- on reviews. Review identity is the review row id, not the user_id + game_id pair.
ALTER TABLE "reviews"
  DROP CONSTRAINT IF EXISTS "reviews_user_id_game_id_key";

DROP INDEX IF EXISTS "reviews_user_id_game_id_key";

DO $$
DECLARE
  duplicate_unique_index RECORD;
BEGIN
  FOR duplicate_unique_index IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = ANY (current_schemas(false))
      AND tablename = 'reviews'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND indexdef ILIKE '%("user_id", "game_id")%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', duplicate_unique_index.indexname);
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS "reviews_user_id_game_id_created_at_idx"
  ON "reviews"("user_id", "game_id", "created_at");
