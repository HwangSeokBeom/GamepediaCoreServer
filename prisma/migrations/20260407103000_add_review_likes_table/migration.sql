CREATE TABLE "review_likes" (
  "id" UUID NOT NULL,
  "review_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "review_likes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_likes_review_id_user_id_key"
  ON "review_likes"("review_id", "user_id");

CREATE INDEX "review_likes_review_id_created_at_idx"
  ON "review_likes"("review_id", "created_at");

CREATE INDEX "review_likes_user_id_created_at_idx"
  ON "review_likes"("user_id", "created_at");

ALTER TABLE "review_likes"
  ADD CONSTRAINT "review_likes_review_id_fkey"
  FOREIGN KEY ("review_id") REFERENCES "reviews"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_likes"
  ADD CONSTRAINT "review_likes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
