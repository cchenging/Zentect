import { SQLiteConnection } from '../database/core/SQLiteConnection';
import { DatabaseWriteQueue } from './DatabaseWriteQueue';
import { isFeatureEnabled } from '../../shared/config/feature-flags';
import crypto from 'crypto';

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

  constructor() {
    this.db = SQLiteConnection.getInstance().getDB();
    this.writeQueue = DatabaseWriteQueue.getInstance();
    this.useQueue = isFeatureEnabled('USE_DATABASE_WRITE_QUEUE');
  }

  findByStep(projectId: string, mediaId: string, stepId: string): CheckpointRow | undefined {
    return this.db.prepare(
      `SELECT * FROM pipeline_checkpoints WHERE project_id = ? AND media_id = ? AND step_id = ?`
    ).get(projectId, mediaId, stepId) as CheckpointRow | undefined;
  }

  findByProject(projectId: string): CheckpointRow[] {
    return this.db.prepare(
      `SELECT * FROM pipeline_checkpoints WHERE project_id = ? ORDER BY step_order ASC`
    ).all(projectId) as CheckpointRow[];
  }

  findIncompleteByProject(projectId: string): CheckpointRow[] {
    return this.db.prepare(
      `SELECT * FROM pipeline_checkpoints WHERE project_id = ? AND status NOT IN ('completed', 'degraded') ORDER BY step_order ASC`
    ).all(projectId) as CheckpointRow[];
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
        this.db.prepare(
          `UPDATE pipeline_checkpoints SET status = ?, checkpoint_data = COALESCE(?, checkpoint_data), error_message = ?, degraded = ?, update_time = ? WHERE id = ?`
        ).run(status, dataJson, errorMessage || null, degradedVal, now, existing.id);
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
      this.db.prepare(
        `INSERT INTO pipeline_checkpoints (id, project_id, media_id, step_id, step_order, status, checkpoint_data, error_message, degraded, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, projectId, mediaId, stepId, stepOrder, status, dataJson, errorMessage || null, degradedVal, now, now);
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
      this.db.prepare(`DELETE FROM pipeline_checkpoints WHERE project_id = ?`).run(projectId);
    };

    if (this.useQueue) {
      this.writeQueue.enqueue(execDelete);
    } else {
      execDelete();
    }
  }
}
