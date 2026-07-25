-- Creates the durable queue of application-owned profile-image files that must
-- be removed from local storage after their owning account was deleted.
--
-- Preflight: IF NOT EXISTS guards make the migration a no-op when the table or
--   indexes were already provisioned, so replays cannot collide.
-- Locking: only creates new objects; no existing table is scanned, rewritten,
--   or exclusively locked, so the migration is safe to run online.
-- Rollback: DROP TABLE IF EXISTS "profile_image_cleanup_tasks";
--   Forward repair: re-run this migration (idempotent).

CREATE TABLE IF NOT EXISTS "profile_image_cleanup_tasks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "stored_pathname" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_image_cleanup_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "profile_image_cleanup_tasks_stored_pathname_key" ON "profile_image_cleanup_tasks"("stored_pathname");

CREATE INDEX IF NOT EXISTS "profile_image_cleanup_tasks_attempt_count_created_at_idx" ON "profile_image_cleanup_tasks"("attempt_count", "created_at");
