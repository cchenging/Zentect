// 📁 新建文件: src/main/database/repositories/BatchJobRepository.ts
// V1.2: 批量作业仓库 — 队列持久化到 SQLite，崩溃不丢队列

import { SQLiteConnection } from '../core/SQLiteConnection';
import { BATCH_JOB_SQL } from '../queries/SystemQueries';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../infra/logger/LogConstants';
import { BatchJob, BatchJobInput } from '../../engine/BatchQueueEngine';

export class BatchJobRepository {
  private db: ReturnType<typeof SQLiteConnection.prototype.getDB>;

  constructor() {
    this.db = SQLiteConnection.getInstance().getDB();
    this.ensureTable();
  }

  /** 确保批量作业表存在 */
  private ensureTable(): void {
    try {
      this.db.exec(BATCH_JOB_SQL.CREATE_TABLE);
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.DATABASE, '[BatchJobRepository] 创建 batch_jobs 表失败', err);
    }
  }

  /** 批量添加作业 */
  addJobs(inputs: BatchJobInput[]): BatchJob[] {
    const insert = this.db.prepare(BATCH_JOB_SQL.INSERT);
    const maxPos = this.getMaxQueuePosition();
    const jobs: BatchJob[] = [];

    const transaction = this.db.transaction(() => {
      inputs.forEach((input, i) => {
        const id = `batch_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        const job: BatchJob = {
          id,
          projectId: input.projectId,
          projectName: input.projectName,
          mediaPath: input.mediaPath,
          shots: input.shots,
          workflowId: input.workflowId,
          status: 'pending',
          progress: 0,
          message: '',
          createdAt: new Date().toISOString(),
          queuePosition: maxPos + i,
        };
        insert.run({
          id,
          project_id: input.projectId,
          project_name: input.projectName,
          media_path: input.mediaPath,
          shots_data: JSON.stringify(input.shots),
          workflow_id: input.workflowId || null,
          queue_position: maxPos + i,
        });
        jobs.push(job);
      });
    });

    try { transaction(); } catch (err: any) {
      AppLogger.error(LOG_TAGS.DATABASE, '[BatchJobRepository] 批量添加作业失败', err);
    }
    return jobs;
  }

  /** 获取下一个待处理作业 */
  getNextPending(): BatchJob | null {
    try {
      const row = this.db.prepare(BATCH_JOB_SQL.GET_NEXT_PENDING).get() as any;
      return row ? this.rowToJob(row) : null;
    } catch { return null; }
  }

  /** 获取所有作业 */
  getAllJobs(): BatchJob[] {
    try {
      const rows = this.db.prepare(BATCH_JOB_SQL.GET_ALL).all() as any[];
      return rows.map(r => this.rowToJob(r));
    } catch { return []; }
  }

  /** 更新作业状态 */
  updateStatus(id: string, status: string, progress: number, message: string): void {
    try {
      this.db.prepare(BATCH_JOB_SQL.UPDATE_STATUS).run({ id, status, progress, message });
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.DATABASE, '[BatchJobRepository] 更新状态失败', err);
    }
  }

  /** 重置作业为 pending（重试） */
  resetToPending(id: string): void {
    this.updateStatus(id, 'pending', 0, '重试中');
  }

  /** 移除作业 */
  removeJob(id: string): void {
    try {
      this.db.prepare(BATCH_JOB_SQL.REMOVE).run(id);
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.DATABASE, '[BatchJobRepository] 移除作业失败', err);
    }
  }

  /** 重排作业顺序 */
  reorder(jobIds: string[]): void {
    const update = this.db.prepare(BATCH_JOB_SQL.REORDER);
    try {
      const transaction = this.db.transaction(() => {
        jobIds.forEach((id, i) => update.run({ id, position: i }));
      });
      transaction();
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.DATABASE, '[BatchJobRepository] 重排失败', err);
    }
  }

  /** 清理已完成/失败的作业 */
  clearCompleted(): void {
    try { this.db.prepare(BATCH_JOB_SQL.CLEAR).run(); } catch {}
  }

  /** 获取当前最大队列位置 */
  private getMaxQueuePosition(): number {
    try {
      const rows = this.db.prepare(BATCH_JOB_SQL.GET_ALL).all() as any[];
      if (rows.length === 0) return 0;
      return Math.max(...rows.map((r: any) => r.queue_position ?? 0)) + 1;
    } catch { return 0; }
  }

  /** 数据库行映射为 BatchJob 对象 */
  private rowToJob(row: any): BatchJob {
    let shots: any[] = [];
    try { shots = JSON.parse(row.shots_data || '[]'); } catch {}
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      mediaPath: row.media_path,
      shots,
      workflowId: row.workflow_id,
      status: row.status,
      progress: row.progress ?? 0,
      message: row.message ?? '',
      createdAt: row.created_at,
      queuePosition: row.queue_position ?? 0,
    };
  }
}
