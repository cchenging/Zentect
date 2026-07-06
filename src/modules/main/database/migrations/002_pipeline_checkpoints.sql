-- 002: Pipeline Checkpoint 断点续跑支持
CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  checkpoint_data TEXT,
  error_message TEXT,
  degraded INTEGER DEFAULT 0,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_project ON pipeline_checkpoints(project_id);
