-- AlterTable
ALTER TABLE "social_accounts" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "steam_igdb_mappings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "user_game_library" ALTER COLUMN "updated_at" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "user_activity_events_game_source_external_game_id_created_at_id" RENAME TO "user_activity_events_game_source_external_game_id_created_a_idx";
