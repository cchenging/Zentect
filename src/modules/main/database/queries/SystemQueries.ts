// 💥 宪法级统一管理：系统、聊天、任务域的 SQL 字典

export const SETTINGS_SQL = {
  UPSERT: `INSERT INTO settings (key, value)
    VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  GET_ALL: `SELECT key, value FROM settings`,
  // 💥 修复：补全被遗漏的查询语句
  GET_BY_KEY: `SELECT value FROM settings WHERE key = @key`
};

/** V1.2 批量作业持久化 SQL */
export const BATCH_JOB_SQL = {
  /** 创建批量作业表（首次运行时由 migration 执行） */
  CREATE_TABLE: `CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    media_path TEXT NOT NULL,
    shots_data TEXT NOT NULL,
    workflow_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    progress REAL DEFAULT 0,
    message TEXT DEFAULT '',
    queue_position INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  GET_ALL: `SELECT * FROM batch_jobs ORDER BY queue_position ASC`,

  GET_NEXT_PENDING: `SELECT * FROM batch_jobs
    WHERE status = 'pending'
    ORDER BY queue_position ASC LIMIT 1`,

  GET_BY_ID: `SELECT * FROM batch_jobs WHERE id = ?`,

  INSERT: `INSERT INTO batch_jobs (id, project_id, project_name, media_path, shots_data, workflow_id, status, queue_position, created_at)
    VALUES (@id, @project_id, @project_name, @media_path, @shots_data, @workflow_id, 'pending', @queue_position, datetime('now'))`,

  UPDATE_STATUS: `UPDATE batch_jobs SET status = @status, progress = @progress, message = @message, updated_at = datetime('now') WHERE id = @id`,

  REMOVE: `DELETE FROM batch_jobs WHERE id = ?`,

  REORDER: `UPDATE batch_jobs SET queue_position = @position WHERE id = @id`,

  COUNT: `SELECT COUNT(*) as cnt FROM batch_jobs WHERE status = ?`,

  CLEAR: `DELETE FROM batch_jobs WHERE status = 'completed' OR status = 'failed'`,
} as const;

export const CHAT_SQL = {
  // 💥 修复：SQL 里的变量名必须与 Repository 传参一模一样！
  INSERT: `
    INSERT INTO chat_history (id, project_id, role, content, action_payload, created_at) 
    VALUES (@id, @projectId, @role, @content, @actionPayload, datetime('now', 'localtime'))
  `,
  GET_BY_PROJECT: `
    SELECT role, content, action_payload as actionPayload, created_at as createTime 
    FROM chat_history 
    WHERE project_id = @projectId 
    ORDER BY created_at ASC
  `,
  MARK_EXECUTED: `
    UPDATE chat_history 
    SET executed = 1 
    WHERE id = @id
  `
};

export const JOB_SQL = {
  INSERT: `
    INSERT INTO jobs_queue (id, project_id, target_id, task_type, payload, status, message, created_at, updated_at) 
    VALUES (@id, @projectId, @targetId, @taskType, @payload, 'pending', '', datetime('now', 'localtime'), datetime('now', 'localtime'))
  `,
  UPDATE_STATUS: `
    UPDATE jobs_queue 
    SET status = @status, progress = @progress, message = @message, updated_at = datetime('now', 'localtime') 
    WHERE id = @id
  `,
  GET_PENDING: `
    SELECT id, project_id as projectId, target_id as targetId, task_type as taskType, payload, status, message 
    FROM jobs_queue 
    WHERE status = 'pending' 
    ORDER BY created_at ASC
  `,
  GET_ACTIVE_BY_PROJECT: `
    SELECT id, project_id as projectId, target_id as targetId, task_type as taskType, payload, status, message, progress, created_at as createdAt
    FROM jobs_queue 
    WHERE project_id = @projectId AND status IN ('pending', 'processing')
  `,
  FAIL_JOB: `
    UPDATE jobs_queue 
    SET status = 'failed', message = @message, retry_count = retry_count + 1, updated_at = datetime('now', 'localtime') 
    WHERE id = @id
  `
};
