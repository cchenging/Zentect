// 📁 路径：src/modules/settings/binding/backend/ProfileBindingRepo.ts
// Profile 绑定数据仓库：直接引用 infra 层，不依赖 @deprecated 旧模块

import { SQLiteConnection } from '../../../infra/database/SQLiteConnection';

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

export class ProfileBindingRepo {
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
}
