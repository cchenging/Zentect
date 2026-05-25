import Database from 'better-sqlite3';
import { PathManager } from '../../utils/pathManager';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';
import { MigrationManager } from '../migrations/MigrationManager';

export class SQLiteConnection {
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
    if (!SQLiteConnection.instance) SQLiteConnection.instance = new SQLiteConnection();
    return SQLiteConnection.instance;
  }

  public getDB(): Database.Database { return this.db; }

  /**
   * 工业级灾难恢复机制 (Crash Recovery)
   * 必须在每次软件启动、数据库连接建好后立刻执行
   */
  private performDisasterRecovery() {
    try {
      const db = this.getDB();
      const transaction = db.transaction(() => {
        const mediaRes = db.prepare(`UPDATE media_assets SET status = 'failed' WHERE status = 'processing'`).run();
        const jobRes = db.prepare(`UPDATE jobs_queue SET status = 'failed' WHERE status = 'processing'`).run();

        if (mediaRes.changes > 0 || jobRes.changes > 0) {
          AppLogger.info(LOG_TAGS.BOOTSTRAP, `容灾恢复: 释放僵尸媒体锁 ${mediaRes.changes} 个，僵尸后台任务 ${jobRes.changes} 个`);
        }
      });
      transaction();
    } catch (e) {
      AppLogger.error(LOG_TAGS.BOOTSTRAP, '僵尸清洗异常', e);
    }
  }
}
