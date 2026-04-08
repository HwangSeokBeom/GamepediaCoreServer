ALTER TABLE "review_comments"
  ADD COLUMN "root_comment_id" UUID;

UPDATE "review_comments"
SET
  "root_comment_id" = COALESCE("parent_comment_id", "id"),
  "depth" = CASE
    WHEN "parent_comment_id" IS NULL THEN 0
    ELSE 1
  END;

ALTER TABLE "review_comments"
  ALTER COLUMN "root_comment_id" SET NOT NULL;

ALTER TABLE "review_comments"
  ADD CONSTRAINT "review_comments_root_comment_id_fkey"
  FOREIGN KEY ("root_comment_id") REFERENCES "review_comments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "review_comments_review_id_root_comment_id_created_at_id_idx"
  ON "review_comments"("review_id", "root_comment_id", "created_at", "id");

CREATE INDEX "review_comments_root_comment_id_created_at_id_idx"
  ON "review_comments"("root_comment_id", "created_at", "id");

ALTER TABLE "review_comments"
  ADD CONSTRAINT "review_comments_depth_policy_check"
  CHECK (
    (
      "parent_comment_id" IS NULL
      AND "depth" = 0
      AND "root_comment_id" = "id"
    )
    OR
    (
      "parent_comment_id" IS NOT NULL
      AND "depth" = 1
      AND "root_comment_id" = "parent_comment_id"
    )
  );

ALTER TABLE "review_comments"
  ADD CONSTRAINT "review_comments_reply_target_check"
  CHECK (
    "reply_to_comment_id" IS NULL
    OR "parent_comment_id" IS NOT NULL
  );
