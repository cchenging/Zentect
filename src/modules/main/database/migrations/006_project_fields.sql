-- 006: 项目生命周期字段补全
-- V2.0: 为 projects 表添加 is_draft 和 current_step 字段

-- 草稿标记：1 = 草稿（创建时默认，导出/正式发布后改为 0）
ALTER TABLE projects ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 1;

-- 当前步骤：记录用户在流程中的最新位置（import/analysis/review/publish/export）
ALTER TABLE projects ADD COLUMN current_step TEXT NOT NULL DEFAULT 'import';