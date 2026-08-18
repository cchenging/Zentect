-- Migration 032: BGM 节拍持久化缓存表
-- 背景：BGM detect_beats 对同一首歌每次匹配都会重新跑 STFT 低频重音追踪（约 2~5 秒，
--       3 分钟以上可达 15~20 秒），daemon 进程内缓存重启即失效，跨项目复用同一首 BGM
--       也会重复计算。
-- 本迁移新增 bgm_beats 表：以文件物理路径为主键，file_size+mtime 作为"文件内容指纹"做
-- 有效性校验；首次检测成功后写库，后续任意会话 / 任意项目复用时直接读库秒级返回。
-- 命中条件：主键命中 AND (cached.file_size = stat.size AND cached.mtime_ms = stat.mtimeMs)；
--         不满足视为文件被替换，自动失效并重新检测，新结果 upsert 覆盖旧行。

CREATE TABLE IF NOT EXISTS bgm_beats (
  file_path     TEXT PRIMARY KEY,          -- BGM 文件绝对路径（缓存 key）
  file_size     INTEGER NOT NULL,          -- 文件大小（字节，stat.size，指纹 1/2）
  mtime_ms      INTEGER NOT NULL,          -- 文件修改时间（毫秒，stat.mtimeMs，指纹 2/2）
  beats_json    TEXT NOT NULL,             -- 节拍秒级时间数组 JSON，单位 s（与 SemanticAnalyzeStrategy 统一）
  beat_count    INTEGER DEFAULT 0,         -- 节拍数量（便于后续索引/诊断）
  bpm           REAL    DEFAULT 0,         -- BPM（整曲 tempo）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bgm_beats_fingerprint ON bgm_beats(file_path, file_size, mtime_ms);
