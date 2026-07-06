-- 009: 本地模型管理表
-- V1.1: local_models + pipeline_model_config
-- 依据 architecture.md §4.2 + §8.3 节规范

CREATE TABLE IF NOT EXISTS local_models (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  description   TEXT,
  version       TEXT,
  size_bytes    INTEGER,
  status        TEXT DEFAULT 'not_downloaded',
  download_path TEXT,
  remote_url    TEXT,
  md5_checksum  TEXT,
  downloaded_at DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pipeline_model_config (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  node_type       TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  custom_base_url TEXT,
  config_json     TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, node_type)
);