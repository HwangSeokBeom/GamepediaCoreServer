-- Product 2.2 — editorial magazine, Today feed inputs and product controls.
--
-- Additive only. article_sources stores headline, short excerpt, source URL,
-- timestamps and a content hash; it never stores a full third-party article.
-- product_events.event_id is unique so a retried analytics batch is idempotent.
-- product_feature_flags rows are *overrides*: a missing row means "use the
-- configured environment default", so a fresh database keeps shipped behavior.

BEGIN;

CREATE TYPE "EditorialArticleStatus" AS ENUM ('DRAFT', 'FACT_CHECK', 'RIGHTS_REVIEW', 'SCHEDULED', 'PUBLISHED', 'CORRECTED', 'RETRACTED');
CREATE TYPE "ArticleSourceType" AS ENUM ('OFFICIAL_RSS', 'STEAM_NEWS', 'OFFICIAL_SITE', 'EDITOR_MANUAL');

CREATE TABLE "editorial_articles" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(200) NOT NULL,
    "status" "EditorialArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "locale" VARCHAR(16) NOT NULL,
    "headline" VARCHAR(200) NOT NULL,
    "excerpt" VARCHAR(600) NOT NULL,
    "author_user_id" UUID,
    "current_revision_id" UUID,
    "scheduled_for" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "corrected_at" TIMESTAMP(3),
    "retracted_at" TIMESTAMP(3),
    "ai_draft_used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "editorial_articles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "editorial_articles_slug_key" ON "editorial_articles"("slug");
CREATE INDEX "editorial_articles_status_published_at_idx" ON "editorial_articles"("status", "published_at");
CREATE INDEX "editorial_articles_locale_status_published_at_idx" ON "editorial_articles"("locale", "status", "published_at");

ALTER TABLE "editorial_articles"
    ADD CONSTRAINT "editorial_articles_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "article_revisions" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "status" "EditorialArticleStatus" NOT NULL,
    "headline" VARCHAR(200) NOT NULL,
    "excerpt" VARCHAR(600) NOT NULL,
    "body_markdown" TEXT,
    "change_note" VARCHAR(300),
    "ai_draft" BOOLEAN NOT NULL DEFAULT false,
    "editor_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_revisions_article_id_revision_number_key" ON "article_revisions"("article_id", "revision_number");
CREATE INDEX "article_revisions_article_id_created_at_idx" ON "article_revisions"("article_id", "created_at");

ALTER TABLE "article_revisions"
    ADD CONSTRAINT "article_revisions_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "editorial_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "article_revisions"
    ADD CONSTRAINT "article_revisions_editor_user_id_fkey"
    FOREIGN KEY ("editor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "article_sources" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "source_type" "ArticleSourceType" NOT NULL,
    "publisher_key" VARCHAR(80) NOT NULL,
    "headline" VARCHAR(300) NOT NULL,
    -- Short excerpt only. Reproducing a full third-party article is forbidden.
    "excerpt" VARCHAR(400),
    "source_url" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "provenance" "CatalogProvenance" NOT NULL DEFAULT 'OFFICIAL_SOURCE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_sources_article_id_content_hash_key" ON "article_sources"("article_id", "content_hash");
CREATE INDEX "article_sources_publisher_key_published_at_idx" ON "article_sources"("publisher_key", "published_at");

ALTER TABLE "article_sources"
    ADD CONSTRAINT "article_sources_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "editorial_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "article_game_links" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "catalog_game_id" UUID NOT NULL,
    "relation" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_game_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_game_links_article_id_catalog_game_id_key" ON "article_game_links"("article_id", "catalog_game_id");
CREATE INDEX "article_game_links_catalog_game_id_created_at_idx" ON "article_game_links"("catalog_game_id", "created_at");

ALTER TABLE "article_game_links"
    ADD CONSTRAINT "article_game_links_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "editorial_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "article_game_links"
    ADD CONSTRAINT "article_game_links_catalog_game_id_fkey"
    FOREIGN KEY ("catalog_game_id") REFERENCES "catalog_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "article_assets" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "kind" "CatalogAssetKind" NOT NULL,
    "url" TEXT NOT NULL,
    "rights_status" "CatalogAssetRightsStatus" NOT NULL DEFAULT 'UNKNOWN',
    "attribution" VARCHAR(300),
    "is_hero" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "article_assets_article_id_url_key" ON "article_assets"("article_id", "url");
CREATE INDEX "article_assets_article_id_is_hero_idx" ON "article_assets"("article_id", "is_hero");

ALTER TABLE "article_assets"
    ADD CONSTRAINT "article_assets_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "editorial_articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "product_events" (
    "id" UUID NOT NULL,
    "event_id" VARCHAR(120) NOT NULL,
    "user_id" UUID,
    "event_code" VARCHAR(60) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    -- Allowlisted, non-free-text properties only.
    "properties" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_events_event_id_key" ON "product_events"("event_id");
CREATE INDEX "product_events_event_code_occurred_at_idx" ON "product_events"("event_code", "occurred_at");
CREATE INDEX "product_events_user_id_occurred_at_idx" ON "product_events"("user_id", "occurred_at");

ALTER TABLE "product_events"
    ADD CONSTRAINT "product_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "product_feature_flags" (
    "key" VARCHAR(60) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_feature_flags_pkey" PRIMARY KEY ("key")
);

COMMIT;
