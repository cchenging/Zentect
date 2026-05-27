-- 015: pipeline_checkpoints 复合索引优化
-- 查询模式：按 project_id + media_id 查找特定媒体的检查点
-- 原有 idx_checkpoint_project 仅覆盖 project_id，需补充复合索引
CREATE INDEX IF NOT EXISTS idx_checkpoint_project_media
  ON pipeline_checkpoints(project_id, media_id);

CREATE INDEX IF NOT EXISTS idx_checkpoint_project_step
  ON pipeline_checkpoints(project_id, step_id);
