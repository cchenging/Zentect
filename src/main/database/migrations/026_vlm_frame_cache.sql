-- Migration 026: VLM 帧描述缓存表（P1-2 L2 SQLite Cache）
-- 用于缓存 VLM 帧分析结果，重跑管线时秒级命中，避免重复 API 调用
-- 唯一键：frame_hash + model_name + prompt_version（任一变化则缓存失效）
CREATE TABLE IF NOT EXISTS vlm_frame_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_hash TEXT NOT NULL,           -- 帧图像内容 hash（md5 of binary）
  model_name TEXT NOT NULL,           -- VLM 模型名（如 qwen-vl-max）
  prompt_version TEXT NOT NULL DEFAULT 'v1',  -- prompt 版本（改 prompt 时失效旧缓存）
  result_json TEXT NOT NULL,          -- VLM 返回的解析后 JSON 对象
  description TEXT NOT NULL,          -- 拼装后的 UI 显示描述
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 唯一索引：同一帧 + 同一模型 + 同一 prompt 版本只缓存一份
CREATE UNIQUE INDEX IF NOT EXISTS idx_vlm_cache_unique
  ON vlm_frame_cache(frame_hash, model_name, prompt_version);

-- 查询索引：按 frame_hash 查询时走索引
CREATE INDEX IF NOT EXISTS idx_vlm_cache_frame_hash
  ON vlm_frame_cache(frame_hash);
