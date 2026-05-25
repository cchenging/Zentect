-- 004: V1.1 工作流画布持久化
CREATE TABLE IF NOT EXISTS workflow_snapshots (
  project_id TEXT PRIMARY KEY,
  snapshot_data TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
