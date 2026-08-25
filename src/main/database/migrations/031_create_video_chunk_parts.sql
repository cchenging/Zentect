-- ============================================================
-- 🔧 R7 DB 分片写（PR-2）：视频切片缓存分片表
--   原 video_chunks 单行整包 JSON（chunks_json）一次性写入，
--   短视频 1000+ 镜头时整行可达数 MB，单事务大写入易与读端争锁。
--   改为分片落库：每片 ≤200 条，逐片独立事务 commit（better-sqlite3 语句级 autocommit）。
--   旧表 video_chunks 保留做读端回退兼容，新写入一律走本表。
-- ============================================================
CREATE TABLE IF NOT EXISTS video_chunk_parts (
  media_id     TEXT NOT NULL,
  part_index   INTEGER NOT NULL,
  kind         TEXT NOT NULL,          -- 'chunks' | 'segs'
  items_json   TEXT NOT NULL,          -- 每片 ≤200 条序列化 JSON 数组
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (media_id, part_index)
);
CREATE INDEX IF NOT EXISTS idx_video_chunk_parts_media ON video_chunk_parts(media_id);
