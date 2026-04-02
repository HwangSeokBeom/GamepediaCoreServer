CREATE TABLE "public"."user_titles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title_key" VARCHAR(100) NOT NULL,
    "is_selected" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_titles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_titles_user_id_title_key_key" ON "public"."user_titles"("user_id", "title_key");
CREATE INDEX "user_titles_user_id_is_selected_idx" ON "public"."user_titles"("user_id", "is_selected");

ALTER TABLE "public"."user_titles"
ADD CONSTRAINT "user_titles_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
