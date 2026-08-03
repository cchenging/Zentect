// 📁 路径: src/modules/infra/database/__tests__/SchemaValidator.test.ts
// 🛑 原则 3:schema 契约校验器测试

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SchemaValidator } from '../SchemaValidator';

/** 创建一个符合契约的完整内存数据库 */
function createValidDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT, path TEXT, type TEXT, status TEXT, category TEXT,
      cover_path TEXT, duration TEXT, canvas_data TEXT, metadata TEXT, disk_size INTEGER,
      video_path TEXT, is_draft INTEGER, current_step TEXT, show_id TEXT, episode_number INTEGER,
      is_deleted INTEGER, create_time DATETIME, update_time DATETIME
    );
    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY, project_id TEXT, episode_num INTEGER, type TEXT, name TEXT,
      file_path TEXT, cover_path TEXT, duration TEXT, status TEXT, width INTEGER, height INTEGER,
      fps REAL, frames INTEGER, extracted_audio TEXT, extracted_vocals TEXT, extracted_bgm TEXT,
      extracted_text TEXT, extract_duration REAL, narration_script TEXT,
      is_deleted INTEGER, create_time DATETIME, update_time DATETIME
    );
    CREATE TABLE roles (
      id TEXT PRIMARY KEY, project_id TEXT, system_id TEXT, name TEXT, pronoun TEXT, avatar TEXT,
      description TEXT, voice_id TEXT, merged_roles TEXT, faces_json TEXT, global_character_id TEXT,
      is_deleted INTEGER, create_time DATETIME, update_time DATETIME
    );
    CREATE TABLE shots (
      id TEXT PRIMARY KEY, project_id TEXT, episode_num INTEGER, time_code TEXT, duration REAL,
      ai_text TEXT, original_text TEXT, role_id TEXT, original_role_id TEXT, cover_path TEXT,
      reasoning TEXT, characters TEXT, camera TEXT, audio_path TEXT, audio_duration REAL,
      align_strategy TEXT, start_time REAL, end_time REAL, audio_emotion TEXT, vision_text TEXT,
      context_frames TEXT, is_deleted INTEGER, create_time DATETIME, update_time DATETIME
    );
    CREATE TABLE global_characters (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, embedding_center TEXT NOT NULL,
      embedding_version TEXT, voice_id TEXT, pronoun TEXT, description TEXT,
      appearance_count INTEGER, source_project_ids TEXT,
      is_deleted INTEGER, create_time DATETIME, update_time DATETIME
    );
    CREATE TABLE shows (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, cover_path TEXT,
      episode_count INTEGER, is_deleted INTEGER, create_time DATETIME, update_time DATETIME
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chat_history (
      id TEXT PRIMARY KEY, project_id TEXT, role TEXT, content TEXT, action_payload TEXT,
      created_at DATETIME, executed INTEGER
    );
    CREATE TABLE jobs_queue (
      id TEXT PRIMARY KEY, project_id TEXT, target_id TEXT, task_type TEXT, payload TEXT,
      status TEXT, message TEXT, progress REAL, retry_count INTEGER, created_at DATETIME, updated_at DATETIME
    );
    CREATE TABLE api_profiles (
      id TEXT PRIMARY KEY, alias TEXT, enabled INTEGER, is_preset INTEGER, preset_type TEXT
    );
  `);
  return db;
}

describe('SchemaValidator', () => {
  it('完整 schema → 校验通过', () => {
    const db = createValidDb();
    expect(() => SchemaValidator.validate(db)).not.toThrow();
    db.close();
  });

  it('缺失表 → fail-fast 抛错', () => {
    const db = createValidDb();
    db.exec('DROP TABLE global_characters');

    expect(() => SchemaValidator.validate(db)).toThrow(/缺失表: global_characters/);
    db.close();
  });

  it('缺失列 → fail-fast 抛错', () => {
    const db = createValidDb();
    // SQLite 不支持 DROP COLUMN(旧版),用重建表模拟缺失列
    db.exec('ALTER TABLE roles RENAME COLUMN global_character_id TO _temp_gcid');
    db.exec('ALTER TABLE roles RENAME COLUMN _temp_gcid TO _dropped');

    expect(() => SchemaValidator.validate(db)).toThrow(/表 roles 缺失列: global_character_id/);
    db.close();
  });

  it('check 方法返回结构化结果(不抛错)', () => {
    const db = createValidDb();
    db.exec('DROP TABLE shows');

    const result = SchemaValidator.check(db);
    expect(result.ok).toBe(false);
    expect(result.missingTables).toContain('shows');
    db.close();
  });

  it('多个缺失 → 错误信息包含所有缺失项', () => {
    const db = createValidDb();
    db.exec('DROP TABLE global_characters');
    db.exec('DROP TABLE shows');

    expect(() => SchemaValidator.validate(db)).toThrow(/global_characters.*shows|shows.*global_characters/);
    db.close();
  });
});
