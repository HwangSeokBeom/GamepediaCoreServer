CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
    CREATE TYPE user_status AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  password_auth_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  nickname VARCHAR(50) NOT NULL,
  profile_image_url TEXT NULL,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  device_name VARCHAR(100) NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT refresh_tokens_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT password_reset_tokens_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  game_id VARCHAR(100) NOT NULL,
  rating DECIMAL(2, 1) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reviews_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT reviews_user_id_game_id_key UNIQUE (user_id, game_id),
  CONSTRAINT reviews_rating_range_check CHECK (rating >= 0.5 AND rating <= 5.0)
);

CREATE TABLE IF NOT EXISTS favorite_games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  game_id VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT favorite_games_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT favorite_games_user_id_game_id_key UNIQUE (user_id, game_id)
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider VARCHAR(30) NOT NULL,
  provider_subject VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_accounts_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT social_accounts_provider_provider_subject_key UNIQUE (provider, provider_subject),
  CONSTRAINT social_accounts_user_id_provider_key UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id UUID NOT NULL,
  target_type VARCHAR(20) NOT NULL,
  target_id VARCHAR(100) NOT NULL,
  reason VARCHAR(50) NOT NULL,
  detail TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reports_reporter_user_id_fkey
    FOREIGN KEY (reporter_user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  blocked_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_blocks_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT user_blocks_blocked_user_id_fkey
    FOREIGN KEY (blocked_user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT user_blocks_user_id_blocked_user_id_key UNIQUE (user_id, blocked_user_id)
);

CREATE TABLE IF NOT EXISTS search_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query VARCHAR(100) NOT NULL,
  normalized_query VARCHAR(100) NOT NULL,
  result_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_revoked_at ON refresh_tokens(revoked_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id_created_at ON password_reset_tokens(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_used_at ON password_reset_tokens(used_at);
CREATE INDEX IF NOT EXISTS idx_reviews_game_id_created_at ON reviews(game_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id_created_at ON reviews(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_favorite_games_user_id ON favorite_games(user_id);
CREATE INDEX IF NOT EXISTS idx_favorite_games_game_id ON favorite_games(game_id);
CREATE INDEX IF NOT EXISTS idx_social_accounts_user_id ON social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter_user_id_created_at ON reports(reporter_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_target_type_target_id_created_at ON reports(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_blocks_user_id_created_at ON user_blocks(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_user_id_created_at ON user_blocks(blocked_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_search_queries_normalized_query_created_at ON search_queries(normalized_query, created_at);
CREATE INDEX IF NOT EXISTS idx_search_queries_created_at ON search_queries(created_at);
