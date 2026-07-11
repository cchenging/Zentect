import Database from 'better-sqlite3';
import { PathManager } from '../../../main/utils/pathManager';
import { AppLogger } from '../logger/AppLogger';
import { LOG_TAGS } from '../logger/LogConstants';
import { MigrationManager } from './MigrationManager';
import type { DatabaseConnection } from './types';

/**
 * SQLite 连接管理器（单例）
 * 实现 DatabaseConnection 接口，统一全项目数据库访问入口
 */
export class SQLiteConnection implements DatabaseConnection {
  private static instance: SQLiteConnection;
  private db: Database.Database;

  private constructor() {
    const dbPath = PathManager.getDatabasePath();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    const migrationManager = new MigrationManager(this.db);
    migrationManager.runAll();
    MigrationManager.migrateColumnNames(this.db);
    migrationManager.safeAddColumns();

    this.performDisasterRecovery();
  }

  public static getInstance(): SQLiteConnection {
    if (!SQLiteConnection.instance) {
      SQLiteConnection.instance = new SQLiteConnection();
    }
    return SQLiteConnection.instance;
  }

  public getDB(): Database.Database {
    return this.db;
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '数据库连接已关闭');
    }
  }

  /**
   * 工业级灾难恢复机制 (Crash Recovery)
   * 启动时清洗僵尸 processing 状态
   */
  private performDisasterRecovery(): void {
    try {
      const db = this.getDB();
      const transaction = db.transaction(() => {
        const mediaRes = db
          .prepare(`UPDATE media_assets SET status = 'failed' WHERE status = 'processing'`)
          .run();
        const jobRes = db
          .prepare(`UPDATE jobs_queue SET status = 'failed' WHERE status = 'processing'`)
          .run();

        if (mediaRes.changes > 0 || jobRes.changes > 0) {
          AppLogger.info(
            LOG_TAGS.BOOTSTRAP,
            `容灾恢复: 释放僵尸媒体锁 ${mediaRes.changes} 个，僵尸后台任务 ${jobRes.changes} 个`
          );
        }
      });
      transaction();
    } catch (e) {
      AppLogger.error(LOG_TAGS.BOOTSTRAP, '僵尸清洗异常', e);
    }
  }
}
