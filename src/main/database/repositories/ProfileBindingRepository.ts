import { SQLiteConnection } from '../core/SQLiteConnection';

export interface ProfileBinding {
  taskType: string;
  profileId: string | null;
  modelName: string;
  isActive: boolean;
}

interface RawBinding {
  task_type: string; profile_id: string | null;
  model_name: string; is_active: number;
}

/** @deprecated 请使用 `src/modules/settings/binding` 新模块入口，旧路径仅保留兼容性委托 */
export class ProfileBindingRepository {
  private static get db() { return SQLiteConnection.getInstance().getDB(); }

  static getAll(): ProfileBinding[] {
    const rows = this.db.prepare('SELECT * FROM ai_profile_bindings WHERE is_active = 1').all() as RawBinding[];
    return rows.map(r => ({
      taskType: r.task_type, profileId: r.profile_id,
      modelName: r.model_name, isActive: r.is_active === 1,
    }));
  }

  static getByTaskType(taskType: string): ProfileBinding | null {
    const row = this.db.prepare('SELECT * FROM ai_profile_bindings WHERE task_type = ? AND is_active = 1').get(taskType) as RawBinding | undefined;
    if (!row) return null;
    return { taskType: row.task_type, profileId: row.profile_id, modelName: row.model_name, isActive: row.is_active === 1 };
  }

  static upsert(taskType: string, profileId: string | null, modelName: string): void {
    this.db.prepare(
      'INSERT INTO ai_profile_bindings (task_type, profile_id, model_name) VALUES (?, ?, ?) ON CONFLICT(task_type) DO UPDATE SET profile_id = excluded.profile_id, model_name = excluded.model_name, updated_at = CURRENT_TIMESTAMP'
    ).run(taskType, profileId, modelName);
  }

  /**
   * 🔧 修复 Bug3：删除 Profile 时清理所有引用它的绑定
   * 直接删除绑定行（而非置空），避免管线节点残留无效 model_name
   * 后续 upsert 会在 ON CONFLICT 时自动重建
   */
  static clearByProfileId(profileId: string): number {
    const result = this.db.prepare('DELETE FROM ai_profile_bindings WHERE profile_id = ?').run(profileId);
    return result.changes;
  }

  /**
   * 初始化配置：清理所有无效绑定
   *
   * 无效绑定判定（满足任一即删）：
   * 1. profile_id 为 NULL（早期 ON DELETE SET NULL 残留，model_name 未清）
   * 2. profile_id 指向的 Profile 已不存在（DB 不一致）
   * 3. model_name 不在对应 Profile 的 models 列表中（模型被编辑删除后未联动清理）
   *
   * 返回删除行数，供前端日志/提示使用
   */
  static cleanupInvalid(): number {
    const rows = this.db.prepare('SELECT task_type, profile_id, model_name FROM ai_profile_bindings').all() as RawBinding[];

    if (rows.length === 0) return 0;

    // 加载所有 Profile 的 id → models 映射（一次性，避免逐行查询）
    const profileRows = this.db.prepare('SELECT id, models FROM api_profiles').all() as Array<{ id: string; models: string | null }>;
    const profileMap = new Map<string, string[]>();
    for (const r of profileRows) {
      try { profileMap.set(r.id, r.models ? JSON.parse(r.models) : []); } catch { profileMap.set(r.id, []); }
    }

    const invalidTaskTypes: string[] = [];
    for (const b of rows) {
      const isInvalid =
        !b.profile_id ||                                          // 条件1: profile_id 为 NULL
        !profileMap.has(b.profile_id) ||                          // 条件2: Profile 不存在
        !profileMap.get(b.profile_id)!.includes(b.model_name);    // 条件3: model_name 不在 Profile.models 中
      if (isInvalid) invalidTaskTypes.push(b.task_type);
    }

    if (invalidTaskTypes.length === 0) return 0;

    // 逐行删除（task_type 是主键，批量 IN 删除即可）
    const placeholders = invalidTaskTypes.map(() => '?').join(',');
    const result = this.db.prepare(`DELETE FROM ai_profile_bindings WHERE task_type IN (${placeholders})`).run(...invalidTaskTypes);
    return result.changes;
  }
}