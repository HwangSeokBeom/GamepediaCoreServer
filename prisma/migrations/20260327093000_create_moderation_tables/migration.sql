-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "target_type" VARCHAR(20) NOT NULL,
    "target_id" VARCHAR(100) NOT NULL,
    "reason" VARCHAR(50) NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_blocks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "blocked_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_reporter_user_id_created_at_idx" ON "reports"("reporter_user_id", "created_at");

-- CreateIndex
CREATE INDEX "reports_target_type_target_id_created_at_idx" ON "reports"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_blocks_user_id_blocked_user_id_key" ON "user_blocks"("user_id", "blocked_user_id");

-- CreateIndex
CREATE INDEX "user_blocks_user_id_created_at_idx" ON "user_blocks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "user_blocks_blocked_user_id_created_at_idx" ON "user_blocks"("blocked_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
