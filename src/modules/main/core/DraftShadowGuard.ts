// 📁 路径：src/main/core/DraftShadowGuard.ts
// Layer 3 进阶: 主进程影子 WAL 自动保存 — 300ms 防抖写入 SQLite editor_drafts 表
import { SQLiteConnection } from '../database/core/SQLiteConnection';
import { DatabaseWriteQueue } from '../pipeline/DatabaseWriteQueue';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import type { Statement } from 'better-sqlite3';

export class DraftShadowGuard {
  private static saveTimeout: NodeJS.Timeout | null = null;
  /** 防抖间隔（毫秒） */
  private static readonly DEBOUNCE_MS = 300;
  /** 预编译 SQL 缓存 — 一次编译终身复用，消除句柄膨胀 */
  private static upsertStmt: Statement | null = null;

  /**
   * 获取或初始化预编译 SQL 语句
   */
  private static getUpsertStmt(): Statement | null {
    if (this.upsertStmt) return this.upsertStmt;
    const db = SQLiteConnection.getInstance().getDB();
    if (!db) return null;
    this.upsertStmt = db.prepare(`
      INSERT INTO editor_drafts (project_id, draft_json, updated_at, sync_source, status)
      VALUES (?, ?, ?, 'auto', 'active')
      ON CONFLICT(project_id) DO UPDATE SET
        draft_json = excluded.draft_json,
        updated_at = excluded.updated_at,
        sync_source = 'auto',
        status = 'active'
    `);
    return this.upsertStmt;
  }

  /**
   * 主进程影子 WAL 自动保存
   * 前端每次修改时通过 IPC 调用，主进程 300ms 防抖后写入 SQLite
   * 确保异常退出时编辑器上下文不丢失
   * @param projectId 项目 ID
   * @param draftPayload 草稿 JSON 字符串
   */
  public static persistShadowSnapshot(projectId: string, draftPayload: string): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);

    this.saveTimeout = setTimeout(() => {
      DraftShadowGuard.flushToDB(projectId, draftPayload);
    }, this.DEBOUNCE_MS);
  }

  /**
   * 立即同步写入（用于窗口关闭前紧急保存）
   */
  public static flushImmediate(projectId: string, draftPayload: string): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    DraftShadowGuard.flushToDB(projectId, draftPayload);
  }

  /**
   * 执行数据库写入 — 通过 DatabaseWriteQueue 串行化，使用预编译 SQL 缓存
   */
  private static flushToDB(projectId: string, draftPayload: string): void {
    const writeQueue = DatabaseWriteQueue.getInstance();
    writeQueue.enqueue(() => {
      const stmt = DraftShadowGuard.getUpsertStmt();
      if (!stmt) return;

      const now = new Date().toISOString();
      stmt.run(projectId, draftPayload, now);

      AppLogger.info(LOG_TAGS.DATABASE, `[Auto-save] Local-First 影子草稿落盘成功，项目 ID: ${projectId}`);
    }).catch((error) => {
      AppLogger.error(LOG_TAGS.DATABASE, 'WAL 影子自动保存失败', error);
    });
  }
}
