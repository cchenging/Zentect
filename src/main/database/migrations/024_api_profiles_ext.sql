-- Migration 020: api_profiles_ext — add alias/enabled/is_preset/preset_type columns
ALTER TABLE api_profiles ADD COLUMN alias TEXT;
ALTER TABLE api_profiles ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE api_profiles ADD COLUMN is_preset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_profiles ADD COLUMN preset_type TEXT;
