-- Migration 031: roles 表新增 tier 分级列（主角/配角/背景路人持久化）
-- 背景：步骤1 人脸聚类后服务端自动计算角色主次分级（tier），
--       但此前仅存在于内存，重新打开工程后分级全部丢失。
--       本迁移为 roles 表新增 tier 列，写入 main/supporting/extra，
--       使"主角/配角/背景路人"标注在跨会话持久保留。
-- 注意：SQLite 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS，
--       MigrationManager 会识别 "duplicate column name" 幂等跳过。

ALTER TABLE roles ADD COLUMN tier TEXT DEFAULT '';