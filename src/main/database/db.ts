// 📁 路径: src/main/database/db.ts
import { SQLiteConnection } from './core/SQLiteConnection';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { encryptData, decryptData } from '../utils/crypto';
import type Database from 'better-sqlite3';

/**
 * @deprecated 🚨 上帝对象已被隔离降级！🚨
 * Project 相关的逻辑已被彻底剥离至 ProjectService 与 ProjectRepository。
 * 该类目前仅作为 Media, AI 等未重构模块的向下兼容面(Facade)。
 */
export class DBManager {
  private static instance: DBManager;
  private db: Database.Database;

  private constructor() {
    // 💥 接入底层大一统连接池，彻底消灭多实例数据库互锁的隐患
    this.db = SQLiteConnection.getInstance().getDB();
  }
  
  static getInstance() {
    if (!DBManager.instance) DBManager.instance = new DBManager();
    return DBManager.instance;
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  // === 仅保留供尚未重构的其它 Controller 调用的通用旧方法 ===
  get<T>(key: string, defaultValue: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string };
    if (!row) return defaultValue;
    try { return JSON.parse(decryptData(row.value)); } catch { return row.value as unknown as T; }
  }

  set(key: string, value: any) {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, encryptData(JSON.stringify(value)));
  }

  // 💥 映射为标准的蛇形命名
  public upsertTask(task: { mediaId: string, projectId: string, status: string, progress: number, text: string }) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO background_tasks (media_id, project_id, status, progress, task_text, update_time)
        VALUES (@mediaId, @projectId, @status, @progress, @text, @updatedAt)
        ON CONFLICT(media_id) DO UPDATE SET
        status = @status, progress = @progress, task_text = @text, update_time = @updatedAt
      `);
      stmt.run({ ...task, updatedAt: Date.now() });
    } catch (e) {
      AppLogger.error(LOG_TAGS.SCHEDULER, '背景任务写入失败', e);
    }
  }

  public getTasksByProject(projectId: string): any[] {
    try {
      const rows = this.db.prepare('SELECT media_id, project_id, status, progress, task_text FROM background_tasks WHERE project_id = ?').all(projectId);
      // 翻译给前端
      return rows.map((r: any) => ({ mediaId: r.media_id, projectId: r.project_id, status: r.status, progress: r.progress, text: r.task_text }));
    } catch (e) {
      AppLogger.warn(LOG_TAGS.SCHEDULER, '获取背景任务列表失败', e);
      return [];
    }
  }
}
