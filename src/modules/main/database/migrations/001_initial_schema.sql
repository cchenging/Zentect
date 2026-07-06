-- 001: 核心业务表初始化
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'video',
  path TEXT,
  category TEXT DEFAULT 'short',
  cover_path TEXT,
  duration TEXT,
  status TEXT DEFAULT 'active',
  canvas_data TEXT,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  episode_num INTEGER,
  type TEXT,
  name TEXT,
  file_path TEXT,
  cover_path TEXT,
  duration REAL,
  status TEXT DEFAULT 'ready',
  width INTEGER,
  height INTEGER,
  fps REAL,
  frames TEXT,
  extracted_audio TEXT,
  extracted_vocals TEXT,
  extracted_bgm TEXT,
  extracted_text TEXT,
  extract_duration TEXT,
  narration_script TEXT,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  system_id TEXT,
  name TEXT,
  pronoun TEXT,
  avatar TEXT,
  description TEXT,
  voice_id TEXT,
  merged_roles TEXT,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  episode_num INTEGER,
  time_code TEXT,
  duration TEXT,
  ai_text TEXT,
  original_text TEXT,
  role_id TEXT,
  original_role_id TEXT,
  cover_path TEXT,
  reasoning TEXT,
  characters TEXT,
  camera TEXT,
  audio_path TEXT,
  audio_duration REAL,
  align_strategy TEXT,
  start_time REAL,
  end_time REAL,
  audio_emotion TEXT,
  vision_text TEXT,
  context_frames TEXT,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS background_tasks (
  media_id TEXT PRIMARY KEY,
  project_id TEXT,
  status TEXT,
  progress INTEGER,
  task_text TEXT,
  update_time INTEGER,
  create_time INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS jobs_queue (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  target_id TEXT,
  task_type TEXT,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  message TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 基础索引
CREATE INDEX IF NOT EXISTS idx_media_project_id ON media_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_roles_project_id ON roles(project_id);
CREATE INDEX IF NOT EXISTS idx_shots_project_id ON shots(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON background_tasks(project_id);
