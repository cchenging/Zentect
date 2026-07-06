-- 008: 用户体系表
-- V1.1: users + user_sessions + vip_activation_codes
-- 依据 architecture.md §4.2 + §8.1 节规范

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT,
  vip_level     TEXT DEFAULT 'free',
  vip_expire_at DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  token         TEXT UNIQUE NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS vip_activation_codes (
  code          TEXT PRIMARY KEY,
  duration_days INTEGER NOT NULL,
  max_uses      INTEGER DEFAULT 1,
  used_count    INTEGER DEFAULT 0,
  is_active     INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);