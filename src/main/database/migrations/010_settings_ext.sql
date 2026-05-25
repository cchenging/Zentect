-- 010: 通用设置扩展
-- V1.1: 新增结构化的应用级别配置项
-- 依据 architecture.md §4.2 + §8.4 节规范

-- 为已有 settings 表插入默认配置（幂等 — INSERT OR IGNORE）
INSERT OR IGNORE INTO settings (key, value) VALUES ('projectStoragePath', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('videoExportPath', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('jianyingDraftPath', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'dark');
INSERT OR IGNORE INTO settings (key, value) VALUES ('language', 'zh-CN');
INSERT OR IGNORE INTO settings (key, value) VALUES ('gpuAcceleration', 'true');
INSERT OR IGNORE INTO settings (key, value) VALUES ('autoSaveInterval', '30000');
INSERT OR IGNORE INTO settings (key, value) VALUES ('autoLogin', 'false');