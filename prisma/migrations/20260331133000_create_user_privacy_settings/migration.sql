CREATE TABLE "user_privacy_settings" (
    "user_id" UUID NOT NULL,
    "show_friends_list" BOOLEAN NOT NULL DEFAULT true,
    "show_recently_played" BOOLEAN NOT NULL DEFAULT true,
    "show_liked_games" BOOLEAN NOT NULL DEFAULT true,
    "show_reviews" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_privacy_settings_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_privacy_settings"
ADD CONSTRAINT "user_privacy_settings_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
