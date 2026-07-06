import { SQLiteConnection } from '../core/SQLiteConnection';
import { JOB_SQL } from '../queries/SystemQueries';

export class JobRepository {
  private get db() { return SQLiteConnection.getInstance().getDB(); }

  public addJob(job: { id: string, projectId: string, targetId: string, taskType: string, payload: any }) {
    this.db.prepare(JOB_SQL.INSERT).run({
      id: job.id,
      projectId: job.projectId,
      targetId: job.targetId,
      taskType: job.taskType,
      payload: JSON.stringify(job.payload)
    });
  }

  public getPendingJobs() {
    const rows = this.db.prepare(JOB_SQL.GET_PENDING).all() as any[];
    return rows.map((r: any) => ({
      id: r.id,
      projectId: r.projectId,
      targetId: r.targetId,
      taskType: r.taskType,
      payload: r.payload ? JSON.parse(r.payload) : {},
      status: r.status,
      message: r.message
    }));
  }

  public getActiveJobsByProject(projectId: string) {
    const rows = this.db.prepare(JOB_SQL.GET_ACTIVE_BY_PROJECT).all({ projectId: projectId }) as any[];
    return rows.map((r: any) => ({
      id: r.id,
      projectId: r.projectId,
      targetId: r.targetId,
      taskType: r.taskType,
      payload: r.payload ? JSON.parse(r.payload) : {},
      status: r.status,
      message: r.message,
      progress: r.progress,
      createdAt: r.createdAt
    }));
  }

  public updateJobStatus(id: string, status: string, progress: number, message: string) {
    this.db.prepare(JOB_SQL.UPDATE_STATUS).run({
      id: id,
      status: status,
      progress: progress,
      message: message
    });
  }

  public failJob(id: string, message: string) {
    this.db.prepare(JOB_SQL.FAIL_JOB).run({
      id: id,
      message: message
    });
  }
}
