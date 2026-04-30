CREATE TABLE "ai_recommendation_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "normalized_query" TEXT NOT NULL,
    "intent" JSONB NOT NULL,
    "result_game_ids" TEXT[] NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_recommendation_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_usage_limits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "usage_date" DATE NOT NULL,
    "recommendation_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_usage_limits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_recommendation_logs_user_id_created_at_idx" ON "ai_recommendation_logs"("user_id", "created_at");
CREATE INDEX "ai_recommendation_logs_created_at_idx" ON "ai_recommendation_logs"("created_at");
CREATE UNIQUE INDEX "ai_usage_limits_user_id_usage_date_key" ON "ai_usage_limits"("user_id", "usage_date");
CREATE INDEX "ai_usage_limits_usage_date_idx" ON "ai_usage_limits"("usage_date");

ALTER TABLE "ai_recommendation_logs" ADD CONSTRAINT "ai_recommendation_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_usage_limits" ADD CONSTRAINT "ai_usage_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
