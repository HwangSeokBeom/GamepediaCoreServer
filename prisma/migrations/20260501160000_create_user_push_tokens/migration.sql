CREATE TABLE "user_push_tokens" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token" TEXT NOT NULL,
  "platform" VARCHAR(20) NOT NULL,
  "device_id" VARCHAR(200),
  "app_version" VARCHAR(50),
  "build_number" VARCHAR(50),
  "environment" VARCHAR(50),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_push_tokens_user_id_device_id_platform_environment_key"
  ON "user_push_tokens"("user_id", "device_id", "platform", "environment");

CREATE UNIQUE INDEX "user_push_tokens_user_id_token_key"
  ON "user_push_tokens"("user_id", "token");

CREATE INDEX "user_push_tokens_user_id_idx"
  ON "user_push_tokens"("user_id");

CREATE INDEX "user_push_tokens_token_idx"
  ON "user_push_tokens"("token");

CREATE INDEX "user_push_tokens_is_active_idx"
  ON "user_push_tokens"("is_active");

ALTER TABLE "user_push_tokens"
  ADD CONSTRAINT "user_push_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
