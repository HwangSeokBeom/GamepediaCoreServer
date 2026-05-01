-- DropForeignKey
ALTER TABLE "review_comments" DROP CONSTRAINT "review_comments_root_comment_id_fkey";

-- AlterTable
ALTER TABLE "review_comment_reactions" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "review_comments" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "user_titles" ALTER COLUMN "is_selected" SET DEFAULT false;

-- RenameIndex
ALTER INDEX "review_comment_reactions_comment_id_reaction_type_created_at_id" RENAME TO "review_comment_reactions_comment_id_reaction_type_created_a_idx";

-- RenameIndex
ALTER INDEX "user_activity_events_game_source_external_game_id_created_at_id" RENAME TO "user_activity_events_game_source_external_game_id_created_a_idx";
