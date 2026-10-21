-- Migration 035: 补漏清洗 projects.tts_engine 列中的已移除引擎（moss）残留值
-- 背景：migration 029 只清理了 settings.ttsProvider 与 projects.metadata.ttsEngine，
--      遗漏了 016/018 新增的 projects.tts_engine 列（建列 DEFAULT 'moss-tts-nano'）。
-- 后果：该列为残留脏数据（当前无代码读取，但语义已失效，易误导排查与后续使用）。
-- 本迁移将 moss / moss-tts-nano 统一修复为合法默认引擎 edge（与 029 口径一致）。

UPDATE projects
SET tts_engine = 'edge'
WHERE tts_engine IN ('moss', 'moss-tts-nano');