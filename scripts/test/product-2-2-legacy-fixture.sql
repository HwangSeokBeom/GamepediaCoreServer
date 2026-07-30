-- Pre-Product-2.2 fixture rows, inserted into a database that has only the
-- legacy migrations applied. The Product 2.2 migrations then run on top, so the
-- backfill is verified against data that already existed.
--
-- Coverage:
--   * an IGDB library entry and a Steam library entry for the same game, joined
--     by a CONFIRMED mapping -> must collapse to one canonical game,
--   * a Steam/IGDB pair joined only by a CANDIDATE mapping -> must stay separate,
--   * a Steam/IGDB pair with identical titles and a REJECTED mapping -> must stay
--     separate (the duplicate false-positive case),
--   * review and favorite game ids that appear in no library entry,
--   * activity events with and without an explicit igdb_game_id.

BEGIN;

INSERT INTO "users" ("id", "email", "password_hash", "nickname", "status", "created_at", "updated_at") VALUES
  ('00000000-0000-4000-8000-00000000a001', 'gate-legacy-1@example.invalid', 'x', 'gate-legacy-one', 'ACTIVE', now(), now()),
  ('00000000-0000-4000-8000-00000000a002', 'gate-legacy-2@example.invalid', 'x', 'gate-legacy-two', 'ACTIVE', now(), now());

INSERT INTO "user_game_library"
  ("id", "user_id", "game_source", "external_game_id", "game_name", "status", "playtime_minutes", "last_played_at", "created_at", "updated_at") VALUES
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a001', 'IGDB',  '1942',   'Hollow Knight',  'PLAYING',   600,  now(), now(), now()),
  ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000a001', 'STEAM', '367520', 'Hollow Knight',  'PLAYING',   900,  now(), now(), now()),
  ('00000000-0000-4000-8000-00000000b003', '00000000-0000-4000-8000-00000000a002', 'STEAM', '620',    'Portal 2',       'COMPLETED', 300,  now(), now(), now()),
  ('00000000-0000-4000-8000-00000000b004', '00000000-0000-4000-8000-00000000a002', 'IGDB',  '9999',   'IGDB Only Game', 'BACKLOG',   NULL, NULL,  now(), now()),
  ('00000000-0000-4000-8000-00000000b005', '00000000-0000-4000-8000-00000000a001', 'STEAM', '400',    'Portal',         'COMPLETED', 120,  now(), now(), now()),
  ('00000000-0000-4000-8000-00000000b006', '00000000-0000-4000-8000-00000000a001', 'IGDB',  '5000',   'Portal',         'COMPLETED', 120,  now(), now(), now());

INSERT INTO "reviews" ("id", "user_id", "game_id", "rating", "content", "created_at", "updated_at") VALUES
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000a001', '1942', 4.5, 'legacy review', now(), now()),
  ('00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000a002', '7777', 3.0, 'legacy review', now(), now());

INSERT INTO "favorite_games" ("id", "user_id", "game_id", "created_at") VALUES
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000a001', '8888', now());

INSERT INTO "user_activity_events"
  ("id", "actor_user_id", "activity_type", "game_source", "external_game_id", "igdb_game_id", "is_visible", "created_at", "updated_at") VALUES
  ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000a001', 'PLAY_STATUS_CHANGED', 'IGDB',  '1942', '1942', true, now(), now()),
  ('00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000a002', 'PLAY_STATUS_CHANGED', 'STEAM', '620',  NULL,   true, now(), now()),
  ('00000000-0000-4000-8000-00000000e003', '00000000-0000-4000-8000-00000000a002', 'REVIEW_CREATED',      NULL,    NULL,   '7777', true, now(), now());

INSERT INTO "steam_igdb_mappings"
  ("id", "steam_appid", "igdb_game_id", "matched_title", "confidence_score", "match_status", "matched_at", "created_at", "updated_at") VALUES
  ('00000000-0000-4000-8000-00000000f001', '367520', '1942', 'Hollow Knight', 0.98, 'CONFIRMED', now(), now(), now()),
  ('00000000-0000-4000-8000-00000000f002', '620',    '7777', 'Portal 2',      0.72, 'CANDIDATE', now(), now(), now()),
  ('00000000-0000-4000-8000-00000000f003', '999999', NULL,   NULL,            0.00, 'UNMATCHED', now(), now(), now()),
  ('00000000-0000-4000-8000-00000000f004', '400',    '5000', 'Portal',        0.55, 'REJECTED',  now(), now(), now());

COMMIT;
