-- 007: 工作流模板表
-- V2.0: 模板种子化 — 冷启动时将 templates.ts 注入到 SQLite
-- 依据「一擎双镜」架构文档 §4.3 + §7.2 节规范

CREATE TABLE IF NOT EXISTS Workflow_Templates (
  id          TEXT PRIMARY KEY,            -- 模板唯一标识，如 'tpl-video-pipeline'
  name        TEXT NOT NULL,              -- 模板名称
  description TEXT DEFAULT '',            -- 模板描述
  version     INTEGER NOT NULL DEFAULT 1, -- 模板版本号，递增用于热更新判断
  nodes_json  TEXT NOT NULL,              -- 节点拓扑 JSON 序列化
  edges_json  TEXT NOT NULL,              -- 连线拓扑 JSON 序列化
  ui_schema_json TEXT,                    -- UI Schema JSON 序列化
  fingerprint TEXT DEFAULT '',            -- 模板拓扑指纹（预计算）
  is_active   INTEGER NOT NULL DEFAULT 1, -- 是否启用
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);