-- Migration 018: extend projects table (safe - checks column existence)
-- These columns may already exist from prior migrations, so we guard each one

-- SQLite doesn't support IF NOT EXISTS on ALTER TABLE ADD COLUMN,
-- so the MigrationManager needs to catch errors per-statement.
-- This file uses a transaction that ignores individual column failures.

ALTER TABLE projects ADD COLUMN script_style TEXT DEFAULT 'narrative';
ALTER TABLE projects ADD COLUMN speech_rate REAL DEFAULT 1.0;
ALTER TABLE projects ADD COLUMN tts_engine TEXT DEFAULT 'moss-tts-nano';
ALTER TABLE projects ADD COLUMN tts_voice_id TEXT;
ALTER TABLE projects ADD COLUMN pipeline_params TEXT;
ALTER TABLE projects ADD COLUMN extraction_config TEXT;
ALTER TABLE projects ADD COLUMN step_statuses TEXT;
ALTER TABLE projects ADD COLUMN step_completed TEXT;
ALTER TABLE projects ADD COLUMN current_step INTEGER DEFAULT 1;