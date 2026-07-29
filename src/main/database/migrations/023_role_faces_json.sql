-- 023_role_faces_json.sql
-- 为 roles 表添加 faces_json 列，存储完整人脸数据（gender/age/bbox/face_path 等）
-- 用途：重进项目后恢复角色详细信息（性别、年龄、多张人脸缩略图）
-- 注意：SQLite ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，重复执行会报错
--       MigrationManager 的 safeAddColumns 会检查列是否已存在
ALTER TABLE roles ADD COLUMN faces_json TEXT DEFAULT '';
