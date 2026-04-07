CREATE TYPE "ReviewCommentReactionType" AS ENUM ('LIKE', 'DISLIKE');

CREATE TABLE "review_comments" (
  "id" UUID NOT NULL,
  "review_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "parent_comment_id" UUID,
  "reply_to_comment_id" UUID,
  "content" TEXT NOT NULL,
  "depth" INTEGER NOT NULL DEFAULT 0,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "review_comment_reactions" (
  "id" UUID NOT NULL,
  "comment_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "reaction_type" "ReviewCommentReactionType" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "review_comment_reactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "review_comment_reports" (
  "id" UUID NOT NULL,
  "comment_id" UUID NOT NULL,
  "reporter_user_id" UUID NOT NULL,
  "reason" VARCHAR(50) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "review_comment_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_comment_reactions_comment_id_user_id_key"
  ON "review_comment_reactions"("comment_id", "user_id");

CREATE UNIQUE INDEX "review_comment_reports_comment_id_reporter_user_id_key"
  ON "review_comment_reports"("comment_id", "reporter_user_id");

CREATE INDEX "review_comments_review_id_parent_comment_id_created_at_id_idx"
  ON "review_comments"("review_id", "parent_comment_id", "created_at", "id");

CREATE INDEX "review_comments_parent_comment_id_created_at_id_idx"
  ON "review_comments"("parent_comment_id", "created_at", "id");

CREATE INDEX "review_comments_user_id_created_at_id_idx"
  ON "review_comments"("user_id", "created_at", "id");

CREATE INDEX "review_comment_reactions_comment_id_reaction_type_created_at_idx"
  ON "review_comment_reactions"("comment_id", "reaction_type", "created_at");

CREATE INDEX "review_comment_reactions_user_id_created_at_idx"
  ON "review_comment_reactions"("user_id", "created_at");

CREATE INDEX "review_comment_reports_reporter_user_id_created_at_idx"
  ON "review_comment_reports"("reporter_user_id", "created_at");

CREATE INDEX "review_comment_reports_comment_id_created_at_idx"
  ON "review_comment_reports"("comment_id", "created_at");

ALTER TABLE "review_comments"
  ADD CONSTRAINT "review_comments_review_id_fkey"
  FOREIGN KEY ("review_id") REFERENCES "reviews"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_comments"
  ADD CONSTRAINT "review_comments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_comments"
  ADD CONSTRAINT "review_comments_parent_comment_id_fkey"
  FOREIGN KEY ("parent_comment_id") REFERENCES "review_comments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_comments"
  ADD CONSTRAINT "review_comments_reply_to_comment_id_fkey"
  FOREIGN KEY ("reply_to_comment_id") REFERENCES "review_comments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_comment_reactions"
  ADD CONSTRAINT "review_comment_reactions_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "review_comments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_comment_reactions"
  ADD CONSTRAINT "review_comment_reactions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_comment_reports"
  ADD CONSTRAINT "review_comment_reports_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "review_comments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_comment_reports"
  ADD CONSTRAINT "review_comment_reports_reporter_user_id_fkey"
  FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
