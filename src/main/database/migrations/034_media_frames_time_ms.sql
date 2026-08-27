-- Migration 034: media_assets 增加帧真实时间戳字段
-- 背景：步骤1抽帧时 FFmpeg -ss 前置 seek 使输出 PTS 归零（body 坐标），帧上显示的时间不是
--       原视频真实时间（源坐标）。SmartFramePostProcessor 通过 sourceOffsetMs 已把帧 timeMs
--       换算回源坐标（原视频绝对时间），但该时间戳数组未落库 → skipFrames 复用旧帧时、
--       step2 重跑时拿不到真实时间戳，只能按 estimatedInterval 估算，导致 asrText 错位。
-- 修复：把帧真实时间戳（JSON 数组，与 frames 列顺序对齐）落库，step2 优先从 DB 读取。
-- 兼容性：旧数据该列为 NULL；NULL 或空数组时 step2 回退估算（并 WARN 提示数据不精确）。

ALTER TABLE media_assets ADD COLUMN frames_time_ms TEXT;
