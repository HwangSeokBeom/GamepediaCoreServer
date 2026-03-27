-- CreateTable
CREATE TABLE "favorite_games" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "game_id" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_games_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "favorite_games_user_id_idx" ON "favorite_games"("user_id");

-- CreateIndex
CREATE INDEX "favorite_games_game_id_idx" ON "favorite_games"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "favorite_games_user_id_game_id_key" ON "favorite_games"("user_id", "game_id");

-- AddForeignKey
ALTER TABLE "favorite_games" ADD CONSTRAINT "favorite_games_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
