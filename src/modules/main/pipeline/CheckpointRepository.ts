import { SQLiteConnection } from '../database/core/SQLiteConnection';
import { DatabaseWriteQueue } from './DatabaseWriteQueue';
import { isFeatureEnabled } from '../../shared/config/feature-flags';
import crypto from 'crypto';
import type { Statement } from 'better-sqlite3';

export interface CheckpointRow {
  id: string;
  project_id: string;
  media_id: string;
  step_id: string;
  step_order: number;
  status: string;
  checkpoint_data: string | null;
  error_message: string | null;
  degraded: number;
  create_time: string;
  update_time: string;
}

export class CheckpointRepository {
  private readonly db: ReturnType<SQLiteConnection['getDB']>;
  private readonly writeQueue: DatabaseWriteQueue;
  private readonly useQueue: boolean;

  /** 预编译 SQL 缓存 — 一次编译终身复用，消灭句柄膨胀溢出隐患 */
  private static stmtFindByStep: Statement | null = null;
  private static stmtFindByProject: Statement | null = null;
  private static stmtFindIncomplete: Statement | null = null;
  private static stmtUpdate: Statement | null = null;
  private static stmtInsert: Statement | null = null;
  private static stmtDelete: Statement | null = null;

  constructor() {
    this.db = SQLiteConnection.getInstance().getDB();
    this.writeQueue = DatabaseWriteQueue.getInstance();
    this.useQueue = isFeatureEnabled('USE_DATABASE_WRITE_QUEUE');
  }

  /** 获取或初始化预编译 SQL 语句 */
  private static getStmtFindByStep(db: any): Statement {
    if (!this.stmtFindByStep) {
      this.stmtFindByStep = db.prepare(
        `SELECT * FROM pipeline_checkpoints WHERE project_id = ? AND media_id = ? AND step_id = ?`
      );
    }
    return this.stmtFindByStep;
  }

  private static getStmtFindByProject(db: any): Statement {
    if (!this.stmtFindByProject) {
      this.stmtFindByProject = db.prepare(
        `SELECT * FROM pipeline_checkpoints WHERE project_id = ? ORDER BY step_order ASC`
      );
    }
    return this.stmtFindByProject;
  }

  private static getStmtFindIncomplete(db: any): Statement {
    if (!this.stmtFindIncomplete) {
      this.stmtFindIncomplete = db.prepare(
        `SELECT * FROM pipeline_checkpoints WHERE project_id = ? AND status NOT IN ('completed', 'degraded') ORDER BY step_order ASC`
      );
    }
    return this.stmtFindIncomplete;
  }

  private static getStmtUpdate(db: any): Statement {
    if (!this.stmtUpdate) {
      this.stmtUpdate = db.prepare(
        `UPDATE pipeline_checkpoints SET status = ?, checkpoint_data = COALESCE(?, checkpoint_data), error_message = ?, degraded = ?, update_time = ? WHERE id = ?`
      );
    }
    return this.stmtUpdate;
  }

  private static getStmtInsert(db: any): Statement {
    if (!this.stmtInsert) {
      this.stmtInsert = db.prepare(
        `INSERT INTO pipeline_checkpoints (id, project_id, media_id, step_id, step_order, status, checkpoint_data, error_message, degraded, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
    }
    return this.stmtInsert;
  }

  private static getStmtDelete(db: any): Statement {
    if (!this.stmtDelete) {
      this.stmtDelete = db.prepare(`DELETE FROM pipeline_checkpoints WHERE project_id = ?`);
    }
    return this.stmtDelete;
  }

  findByStep(projectId: string, mediaId: string, stepId: string): CheckpointRow | undefined {
    return CheckpointRepository.getStmtFindByStep(this.db).get(projectId, mediaId, stepId) as CheckpointRow | undefined;
  }

  findByProject(projectId: string): CheckpointRow[] {
    return CheckpointRepository.getStmtFindByProject(this.db).all(projectId) as CheckpointRow[];
  }

  findIncompleteByProject(projectId: string): CheckpointRow[] {
    return CheckpointRepository.getStmtFindIncomplete(this.db).all(projectId) as CheckpointRow[];
  }

  upsert(params: {
    projectId: string;
    mediaId: string;
    stepId: string;
    stepOrder: number;
    status: string;
    checkpointData?: Record<string, unknown>;
    errorMessage?: string;
    degraded?: boolean;
  }): CheckpointRow {
    const { projectId, mediaId, stepId, stepOrder, status, checkpointData, errorMessage, degraded } = params;
    const existing = this.findByStep(projectId, mediaId, stepId);
    const now = new Date().toISOString();
    const dataJson = checkpointData ? JSON.stringify(checkpointData) : null;
    const degradedVal = degraded ? 1 : 0;

    if (existing) {
      const execUpdate = () => {
        CheckpointRepository.getStmtUpdate(this.db).run(status, dataJson, errorMessage || null, degradedVal, now, existing.id);
      };

      if (this.useQueue) {
        this.writeQueue.enqueue(execUpdate);
      } else {
        execUpdate();
      }
      return this.findByStep(projectId, mediaId, stepId)!;
    }

    const id = crypto.randomUUID();
    const execInsert = () => {
      CheckpointRepository.getStmtInsert(this.db).run(id, projectId, mediaId, stepId, stepOrder, status, dataJson, errorMessage || null, degradedVal, now, now);
    };

    if (this.useQueue) {
      this.writeQueue.enqueue(execInsert);
    } else {
      execInsert();
    }

    return this.findByStep(projectId, mediaId, stepId)!;
  }

  deleteByProject(projectId: string): void {
    const execDelete = () => {
      CheckpointRepository.getStmtDelete(this.db).run(projectId);
    };

    if (this.useQueue) {
      this.writeQueue.enqueue(execDelete);
    } else {
      execDelete();
    }
  }
}
