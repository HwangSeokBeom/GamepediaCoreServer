CREATE TABLE "search_queries" (
    "id" UUID NOT NULL,
    "query" VARCHAR(100) NOT NULL,
    "normalized_query" VARCHAR(100) NOT NULL,
    "result_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "search_queries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "search_queries_normalized_query_created_at_idx" ON "search_queries"("normalized_query", "created_at");
CREATE INDEX "search_queries_created_at_idx" ON "search_queries"("created_at");
