-- Migration 030: 视频切片持久化缓存表（步骤5 切片池跨会话复用）
-- 背景：步骤5 的镜头匹配每次都会重新调用 daemon 的 detect_scene_chunks 生成视频切片，
--       一个 6 分钟视频约需 80 秒，且 daemon 进程内缓存（PROJECT_MATERIAL_POOL）重启即失效。
-- 本迁移新增 video_chunks 表：以视频物理路径（media_id）为 key 持久化完整切片元数据，
-- 首次切片后写库，后续任意会话匹配时直接读库秒级复用，命中后跳过 daemon 切片计算。

CREATE TABLE IF NOT EXISTS video_chunks (
  media_id     TEXT PRIMARY KEY,          -- 视频物理绝对路径（切片缓存 key）
  chunks_json  TEXT NOT NULL,             -- 完整切片数组 JSON（startMs/endMs/coverPath/motionScore 等）
  chunk_count  INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_video_chunks_media ON video_chunks(media_id);
