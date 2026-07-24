-- Migration 020: audio separation config columns on media_assets
-- 存储 Step1 音频分离的模式、引擎与降级标记，供前端展示与下游消费
-- 列说明：
--   separation_mode    'fast'(跳过分离,ASR 使用原始音轨) | 'quality'(Demucs/MDX-Net)
--   separation_engine  quality 模式下使用的引擎 'demucs' | 'mdx' | 'auto'
--   vocals_is_fallback 1=人声分离失败降级到原始音轨 | 0=正常分离或 fast 模式

ALTER TABLE media_assets ADD COLUMN separation_mode TEXT DEFAULT 'quality';
ALTER TABLE media_assets ADD COLUMN separation_engine TEXT DEFAULT 'auto';
ALTER TABLE media_assets ADD COLUMN vocals_is_fallback INTEGER DEFAULT 0;
