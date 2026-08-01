-- Migration 028: 剧集语义层（P2-A 跨集人物复用的语义基础）
-- 用途：把多个独立项目组织成"同一部剧集的不同集"，让全局人物具备"跨集"语义
-- 机制：
--   1. shows 表：剧集元数据（如《琅琊榜》）
--   2. projects 表新增 show_id / episode_number 字段：
--      - show_id 为 NULL 表示独立项目（向后兼容）
--      - show_id 关联到某剧集时，episode_number 标识第几集
--   3. 全局人物卡片可按 show 分组展示（P3 UI 层使用）
-- 向后兼容：现有 projects 不受影响，show_id 默认 NULL，独立项目行为不变

CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY,                 -- 剧集 ID（show_ 前缀 + 时间戳）
  name TEXT NOT NULL,                  -- 剧集名（如"琅琊榜"）
  cover_path TEXT,                     -- 剧集封面（取首集封面或用户指定）
  description TEXT,                    -- 剧集简介
  episode_count INTEGER NOT NULL DEFAULT 0,  -- 关联项目数（缓存字段，便于列表展示）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

-- 索引：按是否未删除筛选（list 查询走此索引）
CREATE INDEX IF NOT EXISTS idx_shows_active
  ON shows(is_deleted);

-- projects 表新增 show_id / episode_number 列
-- SQLite ALTER TABLE 不支持 IF NOT EXISTS，由 MigrationManager.safeAddColumns 程序化检查
-- 但此处也写 ALTER TABLE，利用 runFile 的 duplicate column 容错做双保险
ALTER TABLE projects ADD COLUMN show_id TEXT;
ALTER TABLE projects ADD COLUMN episode_number INTEGER;
