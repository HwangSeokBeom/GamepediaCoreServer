-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "game_id" VARCHAR(100) NOT NULL,
    "rating" DECIMAL(2,1) NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reviews_game_id_created_at_idx" ON "reviews"("game_id", "created_at");

-- CreateIndex
CREATE INDEX "reviews_user_id_created_at_idx" ON "reviews"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_user_id_game_id_key" ON "reviews"("user_id", "game_id");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
