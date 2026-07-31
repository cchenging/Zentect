-- Migration 021: ai_bindings_ext — add sentiment/chat/audio/asr task_type bindings
INSERT OR IGNORE INTO ai_profile_bindings (task_type, model_name) VALUES ('sentiment', '');
INSERT OR IGNORE INTO ai_profile_bindings (task_type, model_name) VALUES ('chat', '');
INSERT OR IGNORE INTO ai_profile_bindings (task_type, model_name) VALUES ('audio', '');
INSERT OR IGNORE INTO ai_profile_bindings (task_type, model_name) VALUES ('asr', '');
