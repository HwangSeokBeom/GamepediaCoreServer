-- PostgreSQL's native NFKC follows the Unicode tables shipped by the
-- database. The application now owns an exactly pinned normalization contract,
-- so a deploy must reconcile persisted rows in JavaScript before serving.
CREATE TABLE "catalog_normalization_state" (
  "singleton_id" SMALLINT NOT NULL DEFAULT 1,
  "contract_version" VARCHAR(80) NOT NULL,
  "catalog_game_count" INTEGER NOT NULL DEFAULT 0,
  "localization_count" INTEGER NOT NULL DEFAULT 0,
  "reconciled_at" TIMESTAMPTZ(6),

  CONSTRAINT "catalog_normalization_state_pkey" PRIMARY KEY ("singleton_id"),
  CONSTRAINT "catalog_normalization_state_singleton_check" CHECK ("singleton_id" = 1),
  CONSTRAINT "catalog_normalization_state_counts_check"
    CHECK ("catalog_game_count" >= 0 AND "localization_count" >= 0)
);

INSERT INTO "catalog_normalization_state" (
  "singleton_id",
  "contract_version",
  "catalog_game_count",
  "localization_count",
  "reconciled_at"
) VALUES (1, 'PENDING', 0, 0, NULL);
