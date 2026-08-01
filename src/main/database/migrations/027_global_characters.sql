-- Migration 027: 全局人物注册中心（P1 跨集/跨项目人物复用）
-- 用途：解决同一人物在不同项目/媒体中被识别为不同角色的问题
-- 机制：每次 step1 聚类完成后，把每个本地角色的代表 embedding 与全局人物库比对
--       余弦相似度 > 阈值则绑定到现有全局人物，否则新建全局人物
-- 关键字段：
--   embedding_center: 512 维 ArcFace 归一化向量的 JSON 字符串，作为该全局人物的"中心脸"
--   appearance_count: 累计被识别次数（用于排序展示）
--   voice_id: 全局默认音色（项目本地角色未设置 voice_id 时回填）

CREATE TABLE IF NOT EXISTS global_characters (
  id TEXT PRIMARY KEY,                 -- 全局人物 ID（gc_ 前缀 + ULID/时间戳）
  name TEXT NOT NULL,                  -- 全局人物名（首次创建时的角色名，可后续修改）
  avatar TEXT,                         -- 全局代表头像绝对路径（拷贝自首次创建时的角色头像）
  embedding_center TEXT NOT NULL,      -- 512 维 ArcFace 归一化向量 JSON 字符串
  embedding_version TEXT NOT NULL DEFAULT 'arcface_v1',  -- embedding 模型版本（模型升级时用于失效重建）
  voice_id TEXT,                       -- 全局默认 TTS 音色 ID
  pronoun TEXT,                        -- 代词（他/她/它）
  description TEXT,                    -- 全局描述
  appearance_count INTEGER NOT NULL DEFAULT 1,  -- 累计被识别绑定的次数
  source_project_ids TEXT,             -- 首次及后续出现过的项目 ID 列表（JSON 数组，用于溯源）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

-- 索引：按是否未删除筛选（list 查询走此索引）
CREATE INDEX IF NOT EXISTS idx_global_characters_active
  ON global_characters(is_deleted);

-- roles 表新增 global_character_id 列（外键关联全局人物）
-- SQLite ALTER TABLE 不支持 IF NOT EXISTS，由 MigrationManager.safeAddColumns 程序化检查
ALTER TABLE roles ADD COLUMN global_character_id TEXT;
