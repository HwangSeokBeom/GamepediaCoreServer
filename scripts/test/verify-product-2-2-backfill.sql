-- Post-migration assertions for the Product 2.2 backfill.
--
-- Every check RAISEs on failure, so psql with ON_ERROR_STOP=1 makes the gate fail
-- closed. Nothing here is a "warning": a violated invariant aborts the run.

\set ON_ERROR_STOP on

DO $$
DECLARE
  steam_canonical UUID;
  igdb_canonical UUID;
  portal_steam_canonical UUID;
  portal_igdb_canonical UUID;
  candidate_steam_canonical UUID;
  candidate_igdb_canonical UUID;
  offending BIGINT;
BEGIN
  -- 1. A CONFIRMED mapping must collapse the Steam and IGDB identities onto one
  --    canonical game.
  SELECT catalog_game_id INTO steam_canonical
  FROM game_external_identities WHERE provider = 'STEAM' AND external_id = '367520' AND region_key = 'GLOBAL';
  SELECT catalog_game_id INTO igdb_canonical
  FROM game_external_identities WHERE provider = 'IGDB' AND external_id = '1942' AND region_key = 'GLOBAL';

  IF steam_canonical IS NULL OR igdb_canonical IS NULL THEN
    RAISE EXCEPTION 'backfill: the confirmed-mapping identities were not created';
  END IF;

  IF steam_canonical <> igdb_canonical THEN
    RAISE EXCEPTION 'backfill: a CONFIRMED mapping did not collapse Steam 367520 and IGDB 1942';
  END IF;

  -- 2. A REJECTED mapping between two identically titled games must NOT merge.
  SELECT catalog_game_id INTO portal_steam_canonical
  FROM game_external_identities WHERE provider = 'STEAM' AND external_id = '400' AND region_key = 'GLOBAL';
  SELECT catalog_game_id INTO portal_igdb_canonical
  FROM game_external_identities WHERE provider = 'IGDB' AND external_id = '5000' AND region_key = 'GLOBAL';

  IF portal_steam_canonical = portal_igdb_canonical THEN
    RAISE EXCEPTION 'backfill: a REJECTED mapping produced a duplicate false-positive merge';
  END IF;

  -- 3. A CANDIDATE mapping must NOT merge either.
  SELECT catalog_game_id INTO candidate_steam_canonical
  FROM game_external_identities WHERE provider = 'STEAM' AND external_id = '620' AND region_key = 'GLOBAL';
  SELECT catalog_game_id INTO candidate_igdb_canonical
  FROM game_external_identities WHERE provider = 'IGDB' AND external_id = '7777' AND region_key = 'GLOBAL';

  IF candidate_steam_canonical = candidate_igdb_canonical THEN
    RAISE EXCEPTION 'backfill: a CANDIDATE mapping was merged automatically';
  END IF;

  -- 4. Exactly one merge audit row, and it must record the CONFIRMED decision.
  SELECT COUNT(*) INTO offending FROM catalog_merge_audits;
  IF offending <> 1 THEN
    RAISE EXCEPTION 'backfill: expected exactly 1 merge audit row, found %', offending;
  END IF;

  SELECT COUNT(*) INTO offending
  FROM catalog_merge_audits WHERE decision <> 'CONFIRMED_MAPPING_MERGE';
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: a non-CONFIRMED merge decision was written';
  END IF;

  -- 5. Exactly one tombstone, and it must point at the surviving game.
  SELECT COUNT(*) INTO offending FROM catalog_games WHERE merged_into_catalog_game_id IS NOT NULL;
  IF offending <> 1 THEN
    RAISE EXCEPTION 'backfill: expected exactly 1 tombstone, found %', offending;
  END IF;

  -- 6. Every legacy row must be backfilled.
  SELECT COUNT(*) INTO offending FROM user_game_library WHERE catalog_game_id IS NULL;
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: % library rows were left without a canonical id', offending;
  END IF;

  SELECT COUNT(*) INTO offending FROM reviews WHERE catalog_game_id IS NULL;
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: % review rows were left without a canonical id', offending;
  END IF;

  SELECT COUNT(*) INTO offending FROM favorite_games WHERE catalog_game_id IS NULL;
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: % favorite rows were left without a canonical id', offending;
  END IF;

  SELECT COUNT(*) INTO offending FROM user_activity_events WHERE catalog_game_id IS NULL;
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: % activity rows were left without a canonical id', offending;
  END IF;

  -- 7. No legacy row may point at a tombstone: reads must never need to chase a
  --    merge from a legacy join.
  SELECT COUNT(*) INTO offending FROM (
    SELECT catalog_game_id FROM user_game_library WHERE catalog_game_id IS NOT NULL
    UNION ALL SELECT catalog_game_id FROM reviews WHERE catalog_game_id IS NOT NULL
    UNION ALL SELECT catalog_game_id FROM favorite_games WHERE catalog_game_id IS NOT NULL
    UNION ALL SELECT catalog_game_id FROM user_activity_events WHERE catalog_game_id IS NOT NULL
  ) refs
  JOIN catalog_games g ON g.id = refs.catalog_game_id
  WHERE g.merged_into_catalog_game_id IS NOT NULL;
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: % legacy rows point at a merge tombstone', offending;
  END IF;

  -- 8. Legacy identity columns must be untouched.
  SELECT COUNT(*) INTO offending FROM user_game_library
  WHERE game_source IS NULL OR btrim(COALESCE(external_game_id, '')) = '';
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: legacy library identity columns were modified';
  END IF;

  SELECT COUNT(*) INTO offending FROM reviews WHERE btrim(COALESCE(game_id, '')) = '';
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: legacy review game_id values were modified';
  END IF;

  -- 9. Both Steam library rows for the merged game must resolve to the same
  --    canonical game as the IGDB row.
  SELECT COUNT(*) INTO offending FROM user_game_library
  WHERE external_game_id IN ('1942', '367520') AND catalog_game_id <> igdb_canonical;
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: merged library rows did not converge on one canonical game';
  END IF;

  -- 10. The identity uniqueness constraint must exist and hold.
  SELECT COUNT(*) INTO offending FROM (
    SELECT provider, external_id, region_key FROM game_external_identities
    GROUP BY 1, 2, 3 HAVING COUNT(*) > 1
  ) duplicates;
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: % duplicate provider keys exist', offending;
  END IF;

  SELECT COUNT(*) INTO offending FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'game_external_identities_provider_external_id_region_key_key';
  IF offending <> 1 THEN
    RAISE EXCEPTION 'backfill: the provider-key unique index is missing';
  END IF;

  -- 11. Every canonical game id must be a UUID (enforced by the column type) and
  --     every backfilled game must carry at least one identity.
  SELECT COUNT(*) INTO offending FROM catalog_games g
  WHERE g.merged_into_catalog_game_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM game_external_identities i WHERE i.catalog_game_id = g.id);
  IF offending <> 0 THEN
    RAISE EXCEPTION 'backfill: % canonical games have no provider identity', offending;
  END IF;

  -- 12. Review-fix corrections. No identity may claim PROVIDER_VERIFIED without a
  --     verifiedAt: the first backfill wrote that provenance for every legacy row
  --     even though nothing had been verified against a provider.
  SELECT COUNT(*) INTO offending FROM "game_external_identities"
  WHERE "provenance" = 'PROVIDER_VERIFIED' AND "verified_at" IS NULL;
  IF offending <> 0 THEN
    RAISE EXCEPTION 'review-fix: % identities claim PROVIDER_VERIFIED with no verifiedAt', offending;
  END IF;

  -- 13. A synthetic "PROVIDER:id" placeholder title carries no information and must
  --     not be publicly searchable.
  SELECT COUNT(*) INTO offending FROM "catalog_games"
  WHERE "publication_status" = 'PUBLISHED'
    AND "merged_into_catalog_game_id" IS NULL
    AND "original_title" ~ '^(IGDB|STEAM|APPLE_APP_STORE|GOOGLE_PLAY|OFFICIAL_SITE|COMMUNITY):';
  IF offending <> 0 THEN
    RAISE EXCEPTION 'review-fix: % synthetic placeholder titles are still PUBLISHED', offending;
  END IF;

  -- 14. Ownership provenance exists and defaults honestly. A row created before
  --     provenance tracking cannot be proven, so it must be UNKNOWN rather than
  --     asserted as provider verified.
  SELECT COUNT(*) INTO offending FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'user_game_library'
    AND column_name = 'ownership_provenance' AND is_nullable = 'NO';
  IF offending <> 1 THEN
    RAISE EXCEPTION 'review-fix: user_game_library.ownership_provenance is missing or nullable';
  END IF;

  SELECT COUNT(*) INTO offending FROM "user_game_library"
  WHERE "ownership_provenance" = 'PROVIDER_VERIFIED';
  IF offending <> 0 THEN
    RAISE EXCEPTION 'review-fix: % legacy library rows assert unprovable provider ownership', offending;
  END IF;

  -- 15. Unverified claims live in their own table, which must NOT be globally
  --     unique on the provider key, so a claim cannot squat a key.
  SELECT COUNT(*) INTO offending FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'game_identity_claims'
    AND indexname = 'game_identity_claims_catalog_game_id_provider_external_id_r_key';
  IF offending <> 1 THEN
    RAISE EXCEPTION 'review-fix: the identity-claim uniqueness index is missing';
  END IF;

  -- Every unique index on the claims table except its primary key must include
  -- catalog_game_id. A unique index on (provider, external_id, region_key) alone
  -- would recreate the squatting problem the separate table exists to prevent.
  SELECT COUNT(*) INTO offending FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'game_identity_claims'
    AND indexdef LIKE 'CREATE UNIQUE INDEX%'
    AND indexname <> 'game_identity_claims_pkey'
    AND indexdef NOT LIKE '%catalog_game_id%';
  IF offending <> 0 THEN
    RAISE EXCEPTION 'review-fix: an identity-claim unique index is not scoped by catalog game';
  END IF;

  -- And the global identity table must still be uniquely keyed on the provider
  -- triple, so a verified key remains single valued.
  SELECT COUNT(*) INTO offending FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'game_external_identities_provider_external_id_region_key_key';
  IF offending <> 1 THEN
    RAISE EXCEPTION 'review-fix: the global provider-key unique index is missing';
  END IF;

  -- 16. The article current revision is a real, enforced, unique reference.
  SELECT COUNT(*) INTO offending
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'editorial_articles'
    AND kcu.column_name = 'current_revision_id'
    AND tc.constraint_type = 'FOREIGN KEY';
  IF offending <> 1 THEN
    RAISE EXCEPTION 'review-fix: editorial_articles.current_revision_id is not a foreign key';
  END IF;

  -- 17. Every article that has revisions must point at one of them.
  SELECT COUNT(*) INTO offending FROM "editorial_articles" article
  WHERE EXISTS (SELECT 1 FROM "article_revisions" r WHERE r."article_id" = article."id")
    AND article."current_revision_id" IS NULL;
  IF offending <> 0 THEN
    RAISE EXCEPTION 'review-fix: % articles with revisions have no current revision', offending;
  END IF;

  -- 18. No stored normalized title may be empty while its source title is not:
  --     that is the state that made Thai, Arabic and Cyrillic titles unsearchable.
  SELECT COUNT(*) INTO offending FROM "catalog_games"
  WHERE btrim("original_title") <> '' AND btrim("normalized_title") = ''
    AND "original_title" ~ '[[:alnum:]]';
  IF offending <> 0 THEN
    RAISE EXCEPTION 'review-fix: % catalog games have an alphanumeric title that normalized to empty', offending;
  END IF;

  SELECT COUNT(*) INTO offending FROM "game_localizations"
  WHERE btrim("title") <> '' AND btrim("normalized_title") = ''
    AND "title" ~ '[[:alnum:]]';
  IF offending <> 0 THEN
    RAISE EXCEPTION 'review-fix: % localizations have an alphanumeric title that normalized to empty', offending;
  END IF;

  RAISE NOTICE 'Product 2.2 backfill and review-fix assertions passed.';
END $$;
