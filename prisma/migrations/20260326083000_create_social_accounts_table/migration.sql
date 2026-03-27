-- CreateTable
CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "provider_subject" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_provider_provider_subject_key" ON "social_accounts"("provider", "provider_subject");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_user_id_provider_key" ON "social_accounts"("user_id", "provider");

-- CreateIndex
CREATE INDEX "social_accounts_user_id_idx" ON "social_accounts"("user_id");

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
