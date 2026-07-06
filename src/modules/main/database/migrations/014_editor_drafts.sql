-- 012: IndexedDB→SQLite 草稿同步表 (quality-review #4 数据一致性)
-- V2.3: 编辑器草稿从 IndexedDB 异步回写到 SQLite，确保双重保障

CREATE TABLE IF NOT EXISTS editor_drafts (
  project_id TEXT PRIMARY KEY,
  draft_json TEXT NOT NULL,        -- 完整 JSON (cards + mediaItems + aiShots + roles)
  updated_at TEXT NOT NULL,
  sync_source TEXT DEFAULT 'auto', -- 'auto' / 'manual' / 'force'
  status TEXT DEFAULT 'active'     -- 'active' / 'archived'
);