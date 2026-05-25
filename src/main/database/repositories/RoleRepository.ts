import { SQLiteConnection } from '../core/SQLiteConnection';

export interface RoleRecord {
  id: string;
  project_id: string;
  system_id: string;
  name: string;
  pronoun: string;
  avatar: string | null;
  description: string | null;
  voice_id: string | null;
  merged_roles: string | null;
  create_time: string;
  update_time: string;
  is_deleted: number;
}

/** V1.1: 角色数据库仓储 — 查询、更新角色音色绑定 */
export class RoleRepository {
  private get db() {
    return SQLiteConnection.getInstance().getDB();
  }

  /** 获取工程下所有角色 */
  findByProjectId(projectId: string): RoleRecord[] {
    return this.db.prepare(`
      SELECT * FROM roles WHERE project_id = @projectId AND is_deleted = 0 ORDER BY create_time ASC
    `).all({ projectId }) as RoleRecord[];
  }

  /** 根据 ID 获取单个角色 */
  findById(id: string): RoleRecord | undefined {
    return this.db.prepare(`
      SELECT * FROM roles WHERE id = @id AND is_deleted = 0
    `).get({ id }) as RoleRecord | undefined;
  }

  /** 更新角色的音色绑定 (voice_id) */
  updateVoiceId(id: string, voiceId: string): void {
    this.db.prepare(`
      UPDATE roles SET voice_id = @voiceId, update_time = datetime('now', 'localtime') WHERE id = @id
    `).run({ id, voiceId });
  }

  /** 更新角色信息 */
  update(id: string, fields: Partial<Pick<RoleRecord, 'name' | 'voice_id' | 'pronoun' | 'description'>>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (fields.name !== undefined) { sets.push('name = @name'); params.name = fields.name; }
    if (fields.voice_id !== undefined) { sets.push('voice_id = @voiceId'); params.voiceId = fields.voice_id; }
    if (fields.pronoun !== undefined) { sets.push('pronoun = @pronoun'); params.pronoun = fields.pronoun; }
    if (fields.description !== undefined) { sets.push('description = @description'); params.description = fields.description; }

    if (sets.length === 0) return;

    sets.push("update_time = datetime('now', 'localtime')");
    this.db.prepare(`UPDATE roles SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  /** 获取所有工程中所有角色 (用于全局音色管理) */
  findAllActive(): RoleRecord[] {
    return this.db.prepare(`
      SELECT * FROM roles WHERE is_deleted = 0 ORDER BY project_id, create_time ASC
    `).all() as RoleRecord[];
  }
}
