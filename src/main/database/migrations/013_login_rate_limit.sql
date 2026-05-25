-- 009: 登录速率限制 + 记住我增强
-- V2.3: 防暴力破解 + 自动登录支持
-- 依据 quality-review.md 技术负责人视角 §5 + 挑剔用户视角 §6

-- 添加登录失败追踪字段
ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

-- 添加记住我标记（区分短期/长期 token）
ALTER TABLE user_sessions ADD COLUMN remember_me INTEGER DEFAULT 0;