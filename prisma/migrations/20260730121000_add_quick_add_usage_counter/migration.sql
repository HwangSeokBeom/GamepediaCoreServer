-- Product 2.2 — reuse the existing AI daily usage limiter for quick add.
--
-- Additive: one new counter column on the existing ai_usage_limits table so AI
-- quick add shares the same per-user, per-day database-enforced budget as
-- recommendations and search assist instead of introducing a parallel limiter.

BEGIN;

ALTER TABLE "ai_usage_limits" ADD COLUMN "quick_add_count" INTEGER NOT NULL DEFAULT 0;

COMMIT;
