-- Migration 029: 清洗已移除 TTS 引擎的残留配置（moss）
-- 背景：MOSS-TTS 引擎已从代码中移除（被 kokoro 本地推理替代），但遗留数据仍可能
--      将 settings.ttsProvider 或 projects.metadata.ttsEngine 指向 'moss'。
-- 后果：步骤4 引擎选择无匹配项、合成时 provider='moss' 抛"未知的 TTS"、健康检查 TTS 项静默缺失。
-- 本迁移将 moss / moss-tts-nano 统一修复为合法默认引擎 edge，并清空 moss 专属音色。

-- 1. 修复全局默认 TTS 引擎（设置页"默认合成引擎"）
UPDATE settings
SET value = 'edge'
WHERE key = 'ttsProvider' AND value IN ('moss', 'moss-tts-nano');

-- 2. 修复项目 metadata 中残留的 ttsEngine，并清空 moss 专属音色
--    json_set 需要 SQLite JSON1（better-sqlite3 内置支持）
UPDATE projects
SET metadata = json_set(
  json_set(metadata, '$.ttsEngine', 'edge'),
  '$.ttsVoiceId', ''
)
WHERE json_extract(metadata, '$.ttsEngine') IN ('moss', 'moss-tts-nano');
