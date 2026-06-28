-- Migration 016: add step_results and project_assets tables
-- 支持步骤结果持久化和统一资产管理

CREATE TABLE IF NOT EXISTS step_results (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  media_id        TEXT,
  step_id         TEXT NOT NULL,
  step_type       TEXT NOT NULL,
  node_id         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  result_json     TEXT,
  error_message   TEXT,
  execution_ms    INTEGER,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_step_results_project ON step_results(project_id);
CREATE INDEX IF NOT EXISTS idx_step_results_project_step ON step_results(project_id, step_id);

CREATE TABLE IF NOT EXISTS project_assets (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  media_id        TEXT,
  asset_type      TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  file_name       TEXT,
  file_size       INTEGER,
  mime_type       TEXT,
  duration_ms     INTEGER,
  width           INTEGER,
  height          INTEGER,
  metadata_json   TEXT,
  step_result_id  TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (step_result_id) REFERENCES step_results(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON project_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_project_type ON project_assets(project_id, asset_type);

-- project extensions
ALTER TABLE projects ADD COLUMN script_style TEXT DEFAULT 'narrative';
ALTER TABLE projects ADD COLUMN speech_rate REAL DEFAULT 1.0;
ALTER TABLE projects ADD COLUMN tts_engine TEXT DEFAULT 'moss-tts-nano';
ALTER TABLE projects ADD COLUMN tts_voice_id TEXT;
ALTER TABLE projects ADD COLUMN pipeline_params TEXT;
ALTER TABLE projects ADD COLUMN extraction_config TEXT;

-- Migration 017: add editor step_status to projects (for hydration restore)
ALTER TABLE projects ADD COLUMN step_statuses TEXT;
ALTER TABLE projects ADD COLUMN step_completed TEXT;
ALTER TABLE projects ADD COLUMN current_step INTEGER DEFAULT 1;