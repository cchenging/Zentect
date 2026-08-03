// 📁 路径: src/modules/infra/database/SchemaValidator.ts
// 🛑 原则 3:schema 契约校验 — 启动时校验所有 SQL 引用的表和列都存在,缺失就 fail-fast
// 旧版 bug:migration 027 未执行但 _migrations 已记录 → global_characters 表缺失 →
//          运行时 SQLITE_ERROR → 事务回滚 → 状态回写失败
// 修复:启动时强制校验,缺失就拒绝启动并报错,不降级不兜底

import type Database from 'better-sqlite3';
import { AppLogger } from '../logger/AppLogger';
import { LOG_TAGS } from '../logger/LogConstants';

/** 表 → 必须存在的列清单 */
const SCHEMA_CONTRACT: Record<string, string[]> = {
  projects: [
    'id', 'name', 'path', 'type', 'status', 'category', 'cover_path', 'duration',
    'canvas_data', 'metadata', 'disk_size', 'video_path', 'is_draft', 'current_step',
    'show_id', 'episode_number',
    'is_deleted', 'create_time', 'update_time',
  ],
  media_assets: [
    'id', 'project_id', 'episode_num', 'type', 'name', 'file_path', 'cover_path',
    'duration', 'status', 'width', 'height', 'fps', 'frames',
    'extracted_audio', 'extracted_vocals', 'extracted_bgm', 'extracted_text',
    'extract_duration', 'narration_script',
    'is_deleted', 'create_time', 'update_time',
  ],
  roles: [
    'id', 'project_id', 'system_id', 'name', 'pronoun', 'avatar', 'description',
    'voice_id', 'merged_roles', 'faces_json', 'global_character_id',
    'is_deleted', 'create_time', 'update_time',
  ],
  shots: [
    'id', 'project_id', 'episode_num', 'time_code', 'duration', 'ai_text', 'original_text',
    'role_id', 'original_role_id', 'cover_path', 'reasoning', 'characters', 'camera',
    'audio_path', 'audio_duration', 'align_strategy', 'start_time', 'end_time',
    'audio_emotion', 'vision_text', 'context_frames',
    'is_deleted', 'create_time', 'update_time',
  ],
  global_characters: [
    'id', 'name', 'avatar', 'embedding_center', 'embedding_version',
    'voice_id', 'pronoun', 'description', 'appearance_count', 'source_project_ids',
    'is_deleted', 'create_time', 'update_time',
  ],
  shows: [
    'id', 'name', 'description', 'cover_path', 'episode_count',
    'is_deleted', 'create_time', 'update_time',
  ],
  settings: ['key', 'value'],
  chat_history: ['id', 'project_id', 'role', 'content', 'action_payload', 'created_at'],
  jobs_queue: ['id', 'project_id', 'target_id', 'task_type', 'payload', 'status', 'message', 'progress', 'retry_count', 'created_at', 'updated_at'],
  api_profiles: ['id', 'alias', 'enabled', 'is_preset', 'preset_type'],
};

/** 校验结果 */
export interface SchemaValidationResult {
  ok: boolean;
  missingTables: string[];
  missingColumns: { table: string; columns: string[] }[];
}

/**
 * schema 契约校验器
 * 在数据库初始化(migration + safeAddColumns)完成后调用
 * 缺失表/列就抛错,拒绝启动 — fail-fast,不降级
 */
export class SchemaValidator {
  /**
   * 校验数据库 schema 是否满足代码契约
   * @param db better-sqlite3 实例
   * @throws Error 当表或列缺失时,抛出包含详细信息的错误
   */
  static validate(db: Database.Database): void {
    const result = SchemaValidator.check(db);

    if (result.ok) {
      AppLogger.info(LOG_TAGS.BOOTSTRAP, `schema 契约校验通过 (${Object.keys(SCHEMA_CONTRACT).length} 张表)`);
      return;
    }

    // 🛑 原则 1:fail-fast,不降级。拼装详细错误信息后抛出
    const parts: string[] = [];
    if (result.missingTables.length > 0) {
      parts.push(`缺失表: ${result.missingTables.join(', ')}`);
    }
    for (const mc of result.missingColumns) {
      parts.push(`表 ${mc.table} 缺失列: ${mc.columns.join(', ')}`);
    }
    const errMsg = `schema 契约校验失败 — ${parts.join(' | ')}。请检查 migration 文件是否正确执行。`;
    AppLogger.error(LOG_TAGS.BOOTSTRAP, errMsg);
    throw new Error(errMsg);
  }

  /**
   * 检查 schema(不抛错,返回结构化结果)
   */
  static check(db: Database.Database): SchemaValidationResult {
    const missingTables: string[] = [];
    const missingColumns: { table: string; columns: string[] }[] = [];

    for (const [table, requiredCols] of Object.entries(SCHEMA_CONTRACT)) {
      // 检查表是否存在
      const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(table);

      if (!tableExists) {
        missingTables.push(table);
        continue;
      }

      // 检查列是否存在
      const actualCols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      const actualColNames = new Set(actualCols.map((c) => c.name));
      const missing = requiredCols.filter((col) => !actualColNames.has(col));

      if (missing.length > 0) {
        missingColumns.push({ table, columns: missing });
      }
    }

    return {
      ok: missingTables.length === 0 && missingColumns.length === 0,
      missingTables,
      missingColumns,
    };
  }
}
