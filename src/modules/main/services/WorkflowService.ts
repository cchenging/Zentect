import { z } from 'zod';
import { SQLiteConnection } from '../database/core/SQLiteConnection';

/** 工作流保存/加载的 Zod 校验 Schema */
const workflowNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.string(), z.unknown()),
});

const workflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
});

export const WORKFLOW_SAVE_SCHEMA = z.object({
  projectId: z.string().min(1),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
});

export type WorkflowSnapshot = z.infer<typeof WORKFLOW_SAVE_SCHEMA>;

/** V1.1 工作流持久化服务 — 节点连线保存到 SQLite */
export class WorkflowService {
  private get db() {
    return SQLiteConnection.getInstance().getDB();
  }

  /** 保存画布节点和连线到 workflow_snapshots 表 */
  save(payload: WorkflowSnapshot): void {
    const parsed = WORKFLOW_SAVE_SCHEMA.parse(payload);
    const snapshotJson = JSON.stringify({ nodes: parsed.nodes, edges: parsed.edges });

    this.db.prepare(`
      INSERT INTO workflow_snapshots (project_id, snapshot_data, updated_at)
      VALUES (@projectId, @snapshotData, datetime('now', 'localtime'))
      ON CONFLICT(project_id) DO UPDATE SET
        snapshot_data = excluded.snapshot_data,
        updated_at = excluded.updated_at
    `).run({ projectId: parsed.projectId, snapshotData: snapshotJson });
  }

  /** 加载指定工程的画布快照 */
  load(projectId: string): WorkflowSnapshot | null {
    const row = this.db.prepare(`
      SELECT snapshot_data FROM workflow_snapshots WHERE project_id = @projectId
    `).get({ projectId }) as { snapshot_data: string } | undefined;

    if (!row) return null;

    try {
      const raw = JSON.parse(row.snapshot_data);
      return WORKFLOW_SAVE_SCHEMA.parse({
        projectId,
        nodes: raw.nodes || [],
        edges: raw.edges || [],
      });
    } catch {
      return null;
    }
  }

  /** 删除工程的工作流快照 */
  delete(projectId: string): void {
    this.db.prepare(`
      DELETE FROM workflow_snapshots WHERE project_id = @projectId
    `).run({ projectId });
  }
}
