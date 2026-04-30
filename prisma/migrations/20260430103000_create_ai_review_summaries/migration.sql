ALTER TABLE "ai_usage_limits" ADD COLUMN "review_summary_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ai_review_summaries" (
    "id" BIGSERIAL NOT NULL,
    "game_id" BIGINT NOT NULL,
    "summary" TEXT NOT NULL,
    "pros" JSONB NOT NULL,
    "cons" JSONB NOT NULL,
    "recommended_for" JSONB NOT NULL,
    "not_recommended_for" JSONB NOT NULL,
    "keywords" JSONB NOT NULL,
    "review_count" INTEGER NOT NULL,
    "source_review_hash" CHAR(64) NOT NULL,
    "model" VARCHAR(100),
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_review_summaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_review_summaries_game_id_source_review_hash_key" ON "ai_review_summaries"("game_id", "source_review_hash");
CREATE INDEX "ai_review_summaries_game_id_idx" ON "ai_review_summaries"("game_id");
