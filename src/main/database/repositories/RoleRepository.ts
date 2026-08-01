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
  /** faces_json：完整人脸数据（gender/age/bbox/face_path/frame_index 等）JSON 字符串 */
  faces_json: string | null;
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
  update(id: string, fields: Partial<Pick<RoleRecord, 'name' | 'voice_id' | 'pronoun' | 'description' | 'avatar' | 'faces_json'>>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (fields.name !== undefined) { sets.push('name = @name'); params.name = fields.name; }
    if (fields.voice_id !== undefined) { sets.push('voice_id = @voiceId'); params.voiceId = fields.voice_id; }
    if (fields.pronoun !== undefined) { sets.push('pronoun = @pronoun'); params.pronoun = fields.pronoun; }
    if (fields.description !== undefined) { sets.push('description = @description'); params.description = fields.description; }
    if (fields.avatar !== undefined) { sets.push('avatar = @avatar'); params.avatar = fields.avatar; }
    if (fields.faces_json !== undefined) { sets.push('faces_json = @facesJson'); params.facesJson = fields.faces_json; }

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

  /**
   * 🎭 P0.5+ 合并角色：将 sourceRole 合并到 targetRole
   * - sourceRole 软删除（is_deleted=1）
   * - sourceRole 的 merged_roles JSON 追加到 targetRole.merged_roles
   * - sourceRole 的 faces_json 合并到 targetRole.faces_json（去重）
   * - shots 表中 role_id=sourceRole 的记录更新为 targetRole.id
   * @param sourceRoleId 被合并的角色 ID（将被软删除）
   * @param targetRoleId 合并目标角色 ID（保留）
   * @param projectId 工程ID（用于更新 shots 表）
   */
  mergeRoles(sourceRoleId: string, targetRoleId: string, projectId: string): void {
    if (sourceRoleId === targetRoleId) return;

    const sourceRole = this.findById(sourceRoleId);
    const targetRole = this.findById(targetRoleId);
    if (!sourceRole || !targetRole) return;

    /** 合并 merged_roles：把 sourceRole 完整信息追加到 target.merged_roles */
    const targetMerged = targetRole.merged_roles ? JSON.parse(targetRole.merged_roles) : [];
    targetMerged.push({
      id: sourceRole.id,
      name: sourceRole.name,
      avatar: sourceRole.avatar,
      pronoun: sourceRole.pronoun,
      description: sourceRole.description,
      voice_id: sourceRole.voice_id,
    });

    /** 合并 faces_json：source 的 faces 追加到 target，按 face_path 去重 */
    let mergedFacesJson = targetRole.faces_json || '';
    if (sourceRole.faces_json) {
      try {
        const targetFaces = targetRole.faces_json ? JSON.parse(targetRole.faces_json) : [];
        const sourceFaces = JSON.parse(sourceRole.faces_json);
        const existingPaths = new Set((targetFaces as any[]).map((f: any) => f.face_path || f.facePath));
        const dedupedSource = (sourceFaces as any[]).filter((f: any) => {
          const p = f.face_path || f.facePath;
          return p ? !existingPaths.has(p) : true;
        });
        mergedFacesJson = JSON.stringify([...(targetFaces as any[]), ...dedupedSource]);
      } catch {
        // JSON 解析失败时保留 target 原值
      }
    }

    /** 事务：更新 target + 软删除 source + 迁移 shots */
    const tx = this.db.transaction(() => {
      // 1. 更新 target 角色的 merged_roles 和 faces_json
      this.db.prepare(`
        UPDATE roles
        SET merged_roles = @mergedRoles,
            faces_json = @facesJson,
            update_time = datetime('now', 'localtime')
        WHERE id = @targetId
      `).run({
        targetId: targetRoleId,
        mergedRoles: JSON.stringify(targetMerged),
        facesJson: mergedFacesJson,
      });

      // 2. 软删除 source 角色
      this.db.prepare(`
        UPDATE roles SET is_deleted = 1, update_time = datetime('now', 'localtime')
        WHERE id = @sourceId
      `).run({ sourceId: sourceRoleId });

      // 3. 迁移 shots 表的 role_id 引用
      this.db.prepare(`
        UPDATE shots SET role_id = @targetId, original_role_id = COALESCE(original_role_id, @sourceId)
        WHERE role_id = @sourceId AND project_id = @projectId
      `).run({ targetId: targetRoleId, sourceId: sourceRoleId, projectId });
    });
    tx();
  }

  /**
   * 🎭 P0.5+ 拆分角色：从 targetRole 中拆出 sourceRole（恢复独立角色）
   * - 从 targetRole.merged_roles 移除 sourceRole 信息
   * - 恢复 sourceRole（is_deleted=0）
   * - shots 表中 original_role_id=sourceRole 且 role_id=targetRole 的记录恢复为 role_id=sourceRole
   * @param sourceRoleId 要拆出的角色 ID
   * @param targetRoleId 当前所在的目标角色 ID
   */
  unmergeRole(sourceRoleId: string, targetRoleId: string): void {
    const targetRole = this.findById(targetRoleId);
    if (!targetRole || !targetRole.merged_roles) return;

    const mergedList = JSON.parse(targetRole.merged_roles) as any[];
    const sourceInfo = mergedList.find((r: any) => r.id === sourceRoleId);
    if (!sourceInfo) return;

    const newMerged = mergedList.filter((r: any) => r.id !== sourceRoleId);

    const tx = this.db.transaction(() => {
      // 1. 更新 target 的 merged_roles
      this.db.prepare(`
        UPDATE roles SET merged_roles = @mergedRoles, update_time = datetime('now', 'localtime')
        WHERE id = @targetId
      `).run({
        targetId: targetRoleId,
        mergedRoles: JSON.stringify(newMerged),
      });

      // 2. 恢复 source 角色（取消软删除 + 恢复原始信息）
      this.db.prepare(`
        UPDATE roles SET is_deleted = 0,
          name = @name,
          avatar = @avatar,
          pronoun = @pronoun,
          description = @description,
          voice_id = @voiceId,
          update_time = datetime('now', 'localtime')
        WHERE id = @sourceId
      `).run({
        sourceId: sourceRoleId,
        name: sourceInfo.name || '',
        avatar: sourceInfo.avatar || null,
        pronoun: sourceInfo.pronoun || '',
        description: sourceInfo.description || null,
        voiceId: sourceInfo.voice_id || null,
      });

      // 3. 恢复 shots 表的 role_id 引用
      this.db.prepare(`
        UPDATE shots SET role_id = @sourceId, original_role_id = NULL
        WHERE role_id = @targetId AND original_role_id = @sourceId
      `).run({ sourceId: sourceRoleId, targetId: targetRoleId });
    });
    tx();
  }

  /**
   * 🎭 P0.5+ 删除角色：软删除角色，并清理 shots 表引用
   * @param id 角色 ID
   * @param projectId 工程ID（用于清理 shots）
   */
  deleteRole(id: string, projectId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE roles SET is_deleted = 1, update_time = datetime('now', 'localtime')
        WHERE id = @id
      `).run({ id });

      // 清理 shots 引用：role_id 置空，保留 original_role_id 作为溯源
      this.db.prepare(`
        UPDATE shots SET role_id = NULL, original_role_id = COALESCE(original_role_id, @id)
        WHERE role_id = @id AND project_id = @projectId
      `).run({ id, projectId });
    });
    tx();
  }
}
