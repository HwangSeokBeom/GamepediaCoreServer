ALTER TABLE "ai_usage_limits" ADD COLUMN "search_assist_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ai_search_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "normalized_query" TEXT NOT NULL,
    "intent" JSONB NOT NULL,
    "result_game_ids" INTEGER[] NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "fallback_used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_search_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_search_logs_user_id_created_at_idx" ON "ai_search_logs"("user_id", "created_at");
CREATE INDEX "ai_search_logs_created_at_idx" ON "ai_search_logs"("created_at");

ALTER TABLE "ai_search_logs" ADD CONSTRAINT "ai_search_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
