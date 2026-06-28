-- Migration 017: api_profiles - multi API configuration support
CREATE TABLE IF NOT EXISTS api_profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  api_key     TEXT,
  base_url    TEXT,
  models      TEXT,
  is_active   INTEGER DEFAULT 0,
  sort_order  INTEGER DEFAULT 0,
  extra_config TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_api_profiles_provider ON api_profiles(provider);
CREATE INDEX IF NOT EXISTS idx_api_profiles_active ON api_profiles(is_active);