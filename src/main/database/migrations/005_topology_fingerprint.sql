-- 005: 拓扑指纹与模板支持
-- V2.0: 为 projects 表添加拓扑指纹相关字段

-- SQLite 限制：每行 ALTER TABLE 只能添加一列
ALTER TABLE projects ADD COLUMN topology_fingerprint TEXT DEFAULT '';
ALTER TABLE projects ADD COLUMN template_fingerprint TEXT DEFAULT '';
ALTER TABLE projects ADD COLUMN topology_locked INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN ui_schema_json TEXT;