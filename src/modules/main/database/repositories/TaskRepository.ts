import { SQLiteConnection } from '../core/SQLiteConnection';
import { TASK_SQL } from '../queries/TaskQueries';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../infra/logger/LogConstants';

export class TaskRepository {
  private get db() { return SQLiteConnection.getInstance().getDB(); }

  public upsertTask(task: { mediaId: string, projectId: string, status: string, progress: number, text: string }) {
    try {
      this.db.prepare(TASK_SQL.UPSERT).run({
        mediaId: task.mediaId,
        projectId: task.projectId,
        status: task.status,
        progress: task.progress,
        text: task.text,
        updatedAt: Date.now(),
        createdAt: Date.now()
      });
    } catch (e) {
      AppLogger.error(LOG_TAGS.SCHEDULER, '更新任务状态失败', e);
    }
  }

  public getTasksByProject(projectId: string): any[] {
    try {
      return this.db.prepare(TASK_SQL.GET_BY_PROJECT).all({ projectId });
    } catch (e) {
      AppLogger.error(LOG_TAGS.SCHEDULER, '获取任务列表失败', e);
      return [];
    }
  }
}
