-- 003: 聊天历史表
CREATE TABLE IF NOT EXISTS chat_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_history_project_id ON chat_history(project_id);
