export const TASK_SQL = {
  UPSERT: `
    INSERT INTO background_tasks (media_id, project_id, status, progress, task_text, update_time, create_time)
    VALUES (@mediaId, @projectId, @status, @progress, @text, @updatedAt, @createdAt)
    ON CONFLICT(media_id) DO UPDATE SET
    status = @status, progress = @progress, task_text = @text, update_time = @updatedAt
  `,
  GET_BY_PROJECT: `
    SELECT media_id as mediaId, project_id as projectId, status, progress, task_text as text
    FROM background_tasks WHERE project_id = @projectId ORDER BY update_time DESC
  `
};
