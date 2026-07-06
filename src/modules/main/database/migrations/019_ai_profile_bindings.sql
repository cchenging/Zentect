-- Migration 019: ai_profile_bindings - maps task types to API profiles
-- Each business task (visual/script/translate/helper) can bind to a specific API profile
CREATE TABLE IF NOT EXISTS ai_profile_bindings (
  task_type   TEXT NOT NULL PRIMARY KEY,
  profile_id  TEXT,
  model_name  TEXT,
  is_active   INTEGER DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES api_profiles(id) ON DELETE SET NULL
);
INSERT OR IGNORE INTO ai_profile_bindings (task_type, model_name) VALUES ('visual', 'qwen-vl-max');
INSERT OR IGNORE INTO ai_profile_bindings (task_type, model_name) VALUES ('script', 'deepseek-chat');
INSERT OR IGNORE INTO ai_profile_bindings (task_type, model_name) VALUES ('translate', 'deepseek-chat');
INSERT OR IGNORE INTO ai_profile_bindings (task_type, model_name) VALUES ('helper', 'deepseek-chat');
INSERT OR IGNORE INTO ai_profile_bindings (task_type, model_name) VALUES ('tts', 'moss-tts-nano');