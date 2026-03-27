ALTER TABLE "users"
ADD COLUMN "password_auth_enabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_user_id_created_at_idx" ON "password_reset_tokens"("user_id", "created_at");
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");
CREATE INDEX "password_reset_tokens_used_at_idx" ON "password_reset_tokens"("used_at");

ALTER TABLE "password_reset_tokens"
ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
