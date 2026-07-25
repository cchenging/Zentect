-- Migration 021: 回填 projects.cover_path 历史数据
-- 背景：ImportService 旧版只写 media_assets.cover_path，未同步写 projects.cover_path
--   导致首页项目卡片封面为 NULL，显示占位图标
-- 修复：从 media_assets.cover_path 回填到 projects.cover_path（取每个项目的首条有效记录）
--   media_assets.cover_path 与 projects.cover_path 格式一致（均为 'thumbnails/xxx.jpg' 裸相对路径）

UPDATE projects
SET cover_path = (
  SELECT m.cover_path
  FROM media_assets m
  WHERE m.project_id = projects.id
    AND m.cover_path IS NOT NULL
    AND m.cover_path != ''
    AND m.is_deleted = 0
  ORDER BY m.create_time ASC
  LIMIT 1
)
WHERE cover_path IS NULL
  AND EXISTS (
    SELECT 1 FROM media_assets m
    WHERE m.project_id = projects.id
      AND m.cover_path IS NOT NULL
      AND m.cover_path != ''
      AND m.is_deleted = 0
  );
