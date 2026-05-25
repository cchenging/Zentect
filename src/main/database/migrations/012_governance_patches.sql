-- 004: 数据库治理 (软删除/时间戳/字段补齐)
-- 注意：ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS 语法
-- 实际补齐逻辑由 MigrationManager.safeAddColumns() 程序化安全执行
-- 此文件保留仅作版本记录用途

-- 无需执行操作，参见 MigrationManager.safeAddColumns()
