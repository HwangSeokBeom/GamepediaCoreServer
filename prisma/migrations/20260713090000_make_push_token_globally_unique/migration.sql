-- A device push token may have exactly one owner. The original TEXT token is
-- retained for delivery while a fixed-size SHA-256 digest owns uniqueness.
BEGIN;

-- Block legacy registrations until duplicate cleanup and the new ownership
-- constraint are both in place. Reads remain available during the migration.
LOCK TABLE "user_push_tokens" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "user_push_tokens"
  ADD COLUMN IF NOT EXISTS "token_hash" CHAR(64);

UPDATE "user_push_tokens"
SET "token_hash" = encode(sha256(convert_to("token", 'UTF8')), 'hex');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "user_push_tokens"
    WHERE "token_hash" IS NULL
  ) THEN
    RAISE EXCEPTION 'push token hash backfill left NULL values';
  END IF;

  IF EXISTS (
    SELECT "token_hash"
    FROM "user_push_tokens"
    GROUP BY "token_hash"
    HAVING COUNT(DISTINCT "token") > 1
  ) THEN
    RAISE EXCEPTION 'SHA-256 collision detected while backfilling push tokens';
  END IF;
END $$;

DELETE FROM "user_push_tokens" AS duplicate
USING "user_push_tokens" AS keeper
WHERE duplicate."token_hash" = keeper."token_hash"
  AND (
    duplicate."last_seen_at" < keeper."last_seen_at"
    OR (
      duplicate."last_seen_at" = keeper."last_seen_at"
      AND duplicate."id" < keeper."id"
    )
  );

DROP INDEX IF EXISTS "user_push_tokens_user_id_token_key";
DROP INDEX IF EXISTS "user_push_tokens_token_idx";
DROP INDEX IF EXISTS "user_push_tokens_token_key";

ALTER TABLE "user_push_tokens"
  ALTER COLUMN "token_hash" SET NOT NULL;

CREATE UNIQUE INDEX "user_push_tokens_token_hash_key"
  ON "user_push_tokens"("token_hash");

COMMIT;
