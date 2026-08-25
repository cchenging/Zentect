-- Migration 033: media_assets 增加裁剪指纹字段
-- 背景：skipFrames/skipAudio 仅按"文件是否已存在"判定复用，未校验这些帧/音频是在什么裁剪
--       配置（OP/ED trim）下生成的。旧流程：用户先配好裁剪 → 抽帧 → 之后修改/新增裁剪 →
--       重新执行时仍复用旧帧 → 帧里仍含 OP/ED 片头。修复：把"抽帧/音频分离所用裁剪配置"
--       的指纹（MediaTrimPolicy.buildTrimFingerprint，格式 trim_s{start}_e{end}）随产物写入
--       media_assets，重跑时比对当前配置，不一致则强制重抽/重分离。
-- 兼容性：旧数据两列均为 NULL。判定规则为"NULL 且当前无裁剪(trim_s0_e0) 视为一致可复用"；
--         一旦当前存在裁剪，NULL 即视为不一致 → 强制重抽一次，正好修复存量旧项目的片头残留。
-- 注意：ALTER TABLE ADD COLUMN 在 MigrationManager 中已做"duplicate column name"幂等处理。

ALTER TABLE media_assets ADD COLUMN frames_trim_sig TEXT;
ALTER TABLE media_assets ADD COLUMN audio_trim_sig TEXT;
