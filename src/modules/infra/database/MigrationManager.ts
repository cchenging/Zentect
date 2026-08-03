import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { AppLogger } from '../logger/AppLogger';
import { LOG_TAGS } from '../logger/LogConstants';
import type { MigrationStatus, IMigrationManager } from './types';

interface ColumnInfo {
  name: string;
  type: string;
  cid: number;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

/**
 * 数据库迁移管理器
 * 从 migrations/ 目录按顺序加载并执行 SQL 迁移文件
 * 支持幂等执行 (IF NOT EXISTS)，安全重复运行
 */
export class MigrationManager implements IMigrationManager {
  private db: Database.Database;
  private migrationsDir: string;

  constructor(db: Database.Database, migrationsDir?: string) {
    this.db = db;
    if (migrationsDir) {
      this.migrationsDir = migrationsDir;
    } else {
      const appRoot = app.getAppPath();
      const candidates = [
        path.join(__dirname, 'migrations'),
        path.join(appRoot, 'src', 'main', 'database', 'migrations'),
        path.join(process.cwd(), 'src', 'main', 'database', 'migrations'),
        path.join(__dirname, '..', '..', '..', 'src', 'main', 'database', 'migrations'),
      ];
      const found = candidates.find((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      });
      this.migrationsDir = found || candidates[0];
      AppLogger.info(LOG_TAGS.BOOTSTRAP, `迁移目录定位: ${this.migrationsDir}`);
    }
  }

  /** 实现 IMigrationManager.run() */
  run(): void {
    this.runAll();
  }

  /** 实现 IMigrationManager.getStatus() */
  getStatus(): MigrationStatus[] {
    this.initMetaTable();
    const allFiles = this.getMigrationFiles();
    const executed = this.db
      .prepare('SELECT filename, executed_at FROM _migrations')
      .all() as { filename: string; executed_at: string }[];

    const executedMap = new Map(executed.map((e) => [e.filename, e.executed_at]));

    return allFiles.map((filename) => ({
      filename,
      executedAt: executedMap.get(filename) || null,
    }));
  }

  /** 执行所有 SQL 迁移文件 (CREATE TABLE / CREATE INDEX - 原生幂等) */
  runAll(): void {
    this.initMetaTable();

    const files = this.getMigrationFiles();
    for (const file of files) {
      this.runFile(file);
    }
  }

  /**
   * 安全补齐字段 (ALTER TABLE ADD COLUMN)
   * SQLite 不支持 IF NOT EXISTS on ALTER TABLE，程序化检查
   */
  safeAddColumns(): void {
    const addCol = (table: string, col: string, def: string): void => {
      try {
        const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
        if (!cols.some((c) => c.name === col)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN "${col}" ${def}`);
          AppLogger.info(LOG_TAGS.BOOTSTRAP, `安全补齐字段: ${table}.${col} ${def}`);
        }
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.BOOTSTRAP, `字段补齐异常: ${table}.${col}`, { error: e.message });
      }
    };

    const coreTables = ['projects', 'media_assets', 'roles', 'shots'];
    for (const t of coreTables) {
      addCol(t, 'is_deleted', 'INTEGER DEFAULT 0');
      addCol(t, 'create_time', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
      addCol(t, 'update_time', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
    }

    addCol('projects', 'category', "TEXT DEFAULT 'short'");
    addCol('projects', 'canvas_data', 'TEXT');
    addCol('projects', 'type', "TEXT DEFAULT 'video'");
    addCol('projects', 'path', 'TEXT');
    addCol('projects', 'status', "TEXT DEFAULT 'active'");
    addCol('projects', 'metadata', 'TEXT');
    addCol('projects', 'video_path', 'TEXT');
    addCol('projects', 'is_draft', 'INTEGER NOT NULL DEFAULT 1');
    addCol('projects', 'current_step', "TEXT NOT NULL DEFAULT 'import'");
    // 🎬 P2-A 剧集层：projects 关联到剧集（show_id 为 NULL 表示独立项目，向后兼容）
    addCol('projects', 'show_id', 'TEXT');
    addCol('projects', 'episode_number', 'INTEGER');

    addCol('chat_history', 'action_payload', 'TEXT');

    // 🛑 原则 1:删除兜底建表(global_characters/shows)— 那是 migration 的职责
    // 旧版兜底建表掩盖了 migration 未执行的问题,导致 schema 不一致被静默吞掉
    // 现在由 SchemaValidator 在启动时 fail-fast 校验,缺失就拒绝启动
    // safeAddColumns 只负责 ALTER TABLE ADD COLUMN(SQLite 不支持 IF NOT EXISTS 的变通)
    addCol('roles', 'global_character_id', 'TEXT');

    // 🔧 修复 Bug：补齐 api_profiles 扩展字段（alias/enabled/is_preset/preset_type）
    // 原 migration 020/021 文件名与 020_audio_separation_config / 021_backfill_project_cover 冲突
    // 导致 alias 列未添加，apiProfile:update 报 "no such column: alias"
    // 此处作为双保险，确保字段存在
    addCol('api_profiles', 'alias', 'TEXT');
    addCol('api_profiles', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
    addCol('api_profiles', 'is_preset', 'INTEGER NOT NULL DEFAULT 0');
    addCol('api_profiles', 'preset_type', 'TEXT');

    AppLogger.info(LOG_TAGS.BOOTSTRAP, '数据库治理字段补齐完成');
  }

  /** 初始化迁移元数据表 */
  private initMetaTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /** 获取排序后的迁移文件列表 */
  private getMigrationFiles(): string[] {
    if (!fs.existsSync(this.migrationsDir)) {
      AppLogger.warn(LOG_TAGS.BOOTSTRAP, `迁移目录不存在: ${this.migrationsDir}`);
      return [];
    }

    return fs
      .readdirSync(this.migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
  }

  /** 执行单个迁移文件 (幂等)
   * 🛑 原则 1:不吞错。ALTER TABLE 的 "duplicate column" 是唯一幂等场景,可跳过。
   *    其他错误必须抛出,不标记 _migrations,让 SchemaValidator fail-fast。
   *    旧版 bug:所有错误都被吞 + 标记已执行 → migration 实际没生效但下次跳过 → schema 不一致
   */
  private runFile(filename: string): void {
    const alreadyExecuted = this.db
      .prepare('SELECT filename FROM _migrations WHERE filename = ?')
      .get(filename);

    if (alreadyExecuted) {
      return;
    }

    const filepath = path.join(this.migrationsDir, filename);
    let sql: string;

    try {
      sql = fs.readFileSync(filepath, 'utf-8');
    } catch {
      // 🛑 原则 1:无法读取迁移文件是严重错误,抛出而非静默返回
      throw new Error(`无法读取迁移文件: ${filename}`);
    }

    // 🛑 修复:先按行移除注释(以 -- 开头),再按分号拆分语句
    // 旧版 bug:直接 split(';') 后 filter(!startsWith('--'))
    //   → migration 027/028 每个语句块都以注释开头 → 整个块被过滤掉
    //   → CREATE TABLE 没执行但 _migrations 标记为已执行 → schema 不一致
    const cleanedSql = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const statements = cleanedSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    let executedCount = 0;
    let idempotentSkips = 0;
    for (const stmt of statements) {
      try {
        this.db.exec(stmt);
        executedCount++;
      } catch (error: any) {
        const msg = error.message || '';
        // 🛑 唯一幂等场景:duplicate column name(字段已存在)。跳过但不报错。
        if (msg.includes('duplicate column name')) {
          idempotentSkips++;
          AppLogger.debug(LOG_TAGS.BOOTSTRAP, `迁移语句幂等跳过: ${filename}`, { sql: stmt.slice(0, 80), error: msg });
        } else {
          // 🛑 原则 1:其他错误不吞,直接抛出。不标记 _migrations,让用户看到真实问题。
          throw new Error(`迁移文件 ${filename} 执行失败: ${msg} (SQL: ${stmt.slice(0, 100)})`);
        }
      }
    }

    this.db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(filename);
    AppLogger.info(LOG_TAGS.BOOTSTRAP, `迁移执行完成: ${filename} (${executedCount} 条语句, ${idempotentSkips} 幂等跳过)`);
  }

  /** 列名前缀迁移 (camelCase → snake_case) */
  static migrateColumnNames(db: Database.Database): void {
    const rename = (table: string, oldC: string, newC: string) => {
      try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
        const hasOld = cols.some((c) => c.name === oldC);
        const hasNew = cols.some((c) => c.name === newC);
        if (hasOld && !hasNew) {
          db.exec(`ALTER TABLE ${table} RENAME COLUMN "${oldC}" TO "${newC}"`);
        }
      } catch (e) {
        AppLogger.warn(LOG_TAGS.BOOTSTRAP, `列重命名异常 ${table}: ${oldC} -> ${newC}`, e);
      }
    };

    const tablesForRename = [
      {
        t: 'projects',
        maps: [
          ['createdAt', 'create_time'],
          ['updatedAt', 'update_time'],
          ['coverPath', 'cover_path'],
        ],
      },
      {
        t: 'media_assets',
        maps: [
          ['projectId', 'project_id'],
          ['filePath', 'file_path'],
          ['coverPath', 'cover_path'],
          ['extractedAudio', 'extracted_audio'],
          ['extractedVocals', 'extracted_vocals'],
          ['extractedBgm', 'extracted_bgm'],
          ['extractedText', 'extracted_text'],
          ['extractDuration', 'extract_duration'],
          ['narrationScript', 'narration_script'],
          ['createdAt', 'create_time'],
          ['updatedAt', 'update_time'],
        ],
      },
      {
        t: 'roles',
        maps: [
          ['projectId', 'project_id'],
          ['systemId', 'system_id'],
          ['voiceId', 'voice_id'],
          ['mergedRoles', 'merged_roles'],
          ['createdAt', 'create_time'],
          ['updatedAt', 'update_time'],
        ],
      },
      {
        t: 'shots',
        maps: [
          ['projectId', 'project_id'],
          ['timeCode', 'time_code'],
          ['aiText', 'ai_text'],
          ['originalText', 'original_text'],
          ['roleId', 'role_id'],
          ['originalRoleId', 'original_role_id'],
          ['coverPath', 'cover_path'],
          ['audioPath', 'audio_path'],
          ['audioDuration', 'audio_duration'],
          ['alignStrategy', 'align_strategy'],
          ['startTime', 'start_time'],
          ['endTime', 'end_time'],
          ['audioEmotion', 'audio_emotion'],
          ['visionText', 'vision_text'],
          ['contextFrames', 'context_frames'],
          ['createdAt', 'create_time'],
          ['updatedAt', 'update_time'],
        ],
      },
      {
        t: 'background_tasks',
        maps: [
          ['mediaId', 'media_id'],
          ['projectId', 'project_id'],
          ['updatedAt', 'update_time'],
          ['createdAt', 'create_time'],
          ['taskText', 'task_text'],
        ],
      },
    ];

    for (const item of tablesForRename) {
      for (const map of item.maps) {
        rename(item.t, map[0], map[1]);
      }
    }
  }
}
