// 📁 路径: src/main/database/repositories/__tests__/RoleRepository.merge.test.ts
// 🎭 P0.5+ RoleRepository 合并/拆分/删除逻辑集成测试
// 使用内存 SQLite 验证事务操作的正确性和数据一致性

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// === Mock 依赖 ===

vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { BOOTSTRAP: 'bootstrap', DB: 'db' },
}));

/** 内存 SQLite 数据库实例 */
let memDB: Database.Database;

vi.mock('../../../../modules/infra/database/SQLiteConnection', () => ({
  SQLiteConnection: {
    getInstance: () => ({
      getDB: () => memDB,
    }),
  },
}));

import { RoleRepository } from '../RoleRepository';

/**
 * 初始化内存 DB 并创建 roles + shots 表
 */
function setupInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      system_id TEXT,
      name TEXT,
      pronoun TEXT,
      avatar TEXT,
      description TEXT,
      voice_id TEXT,
      faces_json TEXT DEFAULT '',
      merged_roles TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS shots (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      role_id TEXT,
      original_role_id TEXT,
      ai_text TEXT,
      original_text TEXT
    );
  `);
  return db;
}

/**
 * 插入测试角色
 */
function insertRole(db: Database.Database, role: Partial<any>) {
  db.prepare(`
    INSERT INTO roles (id, project_id, name, pronoun, avatar, description, voice_id, faces_json, merged_roles, is_deleted)
    VALUES (@id, @projectId, @name, @pronoun, @avatar, @description, @voiceId, @facesJson, @mergedRoles, 0)
  `).run({
    id: role.id || 'role_1',
    projectId: role.project_id || 'proj_1',
    name: role.name || '角色1',
    pronoun: role.pronoun || '',
    avatar: role.avatar || null,
    description: role.description || null,
    voiceId: role.voice_id || null,
    facesJson: role.faces_json || '',
    mergedRoles: role.merged_roles || null,
  });
}

/**
 * 插入测试镜头
 */
function insertShot(db: Database.Database, id: string, projectId: string, roleId: string | null) {
  db.prepare(`
    INSERT INTO shots (id, project_id, role_id, ai_text, original_text)
    VALUES (@id, @projectId, @roleId, '', '')
  `).run({ id, projectId, roleId });
}

describe('🎭 P0.5+ RoleRepository 合并/拆分/删除', () => {
  let repo: RoleRepository;

  beforeEach(() => {
    memDB = setupInMemoryDB();
    repo = new RoleRepository();
  });

  describe('mergeRoles', () => {
    it('应软删除 source 角色 + 追加到 target.merged_roles', () => {
      insertRole(memDB, { id: 'r1', name: '张三', project_id: 'proj_1' });
      insertRole(memDB, { id: 'r2', name: '李四', project_id: 'proj_1' });

      repo.mergeRoles('r1', 'r2', 'proj_1');

      // source 软删除
      const source = memDB.prepare('SELECT * FROM roles WHERE id = ?').get('r1') as any;
      expect(source.is_deleted).toBe(1);

      // target 的 merged_roles 包含 source 信息
      const target = memDB.prepare('SELECT * FROM roles WHERE id = ?').get('r2') as any;
      const merged = JSON.parse(target.merged_roles);
      expect(merged).toHaveLength(1);
      expect(merged[0].id).toBe('r1');
      expect(merged[0].name).toBe('张三');
    });

    it('应迁移 shots 表的 role_id 引用', () => {
      insertRole(memDB, { id: 'r1', project_id: 'proj_1' });
      insertRole(memDB, { id: 'r2', project_id: 'proj_1' });
      insertShot(memDB, 'shot_1', 'proj_1', 'r1');

      repo.mergeRoles('r1', 'r2', 'proj_1');

      const shot = memDB.prepare('SELECT * FROM shots WHERE id = ?').get('shot_1') as any;
      expect(shot.role_id).toBe('r2');
      expect(shot.original_role_id).toBe('r1'); // 保留溯源
    });

    it('应合并 faces_json（按 face_path 去重）', () => {
      insertRole(memDB, {
        id: 'r1',
        faces_json: JSON.stringify([
          { face_path: '/face_1.jpg', frame_index: 0 },
          { face_path: '/face_2.jpg', frame_index: 5 },
        ]),
      });
      insertRole(memDB, {
        id: 'r2',
        faces_json: JSON.stringify([
          { face_path: '/face_2.jpg', frame_index: 10 }, // 重复路径，应被去重
          { face_path: '/face_3.jpg', frame_index: 15 },
        ]),
      });

      repo.mergeRoles('r1', 'r2', 'proj_1');

      const target = memDB.prepare('SELECT faces_json FROM roles WHERE id = ?').get('r2') as any;
      const faces = JSON.parse(target.faces_json);
      // 应包含 3 个唯一 face_path
      expect(faces).toHaveLength(3);
      const paths = faces.map((f: any) => f.face_path);
      expect(paths).toContain('/face_1.jpg');
      expect(paths).toContain('/face_2.jpg');
      expect(paths).toContain('/face_3.jpg');
    });

    it('source === target 时应直接返回（无操作）', () => {
      insertRole(memDB, { id: 'r1', name: '张三' });

      repo.mergeRoles('r1', 'r1', 'proj_1');

      const role = memDB.prepare('SELECT * FROM roles WHERE id = ?').get('r1') as any;
      expect(role.is_deleted).toBe(0);
      expect(role.merged_roles).toBeNull();
    });
  });

  describe('unmergeRole', () => {
    it('应从 target.merged_roles 移除 source + 恢复 source 角色', () => {
      insertRole(memDB, {
        id: 'r2',
        name: '李四',
        merged_roles: JSON.stringify([
          { id: 'r1', name: '张三', avatar: '/avatar1.jpg', pronoun: '他', description: '主角', voice_id: 'v1' },
        ]),
      });
      // r1 需要存在（被软删除状态）
      insertRole(memDB, { id: 'r1', name: '张三_旧', avatar: null });
      memDB.prepare('UPDATE roles SET is_deleted = 1 WHERE id = ?').run('r1');

      repo.unmergeRole('r1', 'r2');

      // source 恢复
      const source = memDB.prepare('SELECT * FROM roles WHERE id = ?').get('r1') as any;
      expect(source.is_deleted).toBe(0);
      expect(source.name).toBe('张三'); // 恢复原始名称
      expect(source.avatar).toBe('/avatar1.jpg');

      // target 的 merged_roles 清空
      const target = memDB.prepare('SELECT merged_roles FROM roles WHERE id = ?').get('r2') as any;
      const merged = JSON.parse(target.merged_roles);
      expect(merged).toHaveLength(0);
    });

    it('应恢复 shots 表的 role_id 引用', () => {
      insertRole(memDB, {
        id: 'r2',
        merged_roles: JSON.stringify([{ id: 'r1', name: '张三' }]),
      });
      insertRole(memDB, { id: 'r1' });
      memDB.prepare('UPDATE roles SET is_deleted = 1 WHERE id = ?').run('r1');
      // shot 当前指向 r2（合并后），original_role_id=r1
      insertShot(memDB, 'shot_1', 'proj_1', 'r2');
      memDB.prepare('UPDATE shots SET original_role_id = ? WHERE id = ?').run('r1', 'shot_1');

      repo.unmergeRole('r1', 'r2');

      const shot = memDB.prepare('SELECT * FROM shots WHERE id = ?').get('shot_1') as any;
      expect(shot.role_id).toBe('r1');
      expect(shot.original_role_id).toBeNull();
    });
  });

  describe('deleteRole', () => {
    it('应软删除角色 + 清理 shots 引用', () => {
      insertRole(memDB, { id: 'r1', name: '张三' });
      insertShot(memDB, 'shot_1', 'proj_1', 'r1');

      repo.deleteRole('r1', 'proj_1');

      const role = memDB.prepare('SELECT is_deleted FROM roles WHERE id = ?').get('r1') as any;
      expect(role.is_deleted).toBe(1);

      const shot = memDB.prepare('SELECT * FROM shots WHERE id = ?').get('shot_1') as any;
      expect(shot.role_id).toBeNull();
      expect(shot.original_role_id).toBe('r1'); // 保留溯源
    });
  });

  describe('update（扩展字段）', () => {
    it('应支持更新 avatar 和 faces_json 字段', () => {
      insertRole(memDB, { id: 'r1', name: '张三' });

      repo.update('r1', {
        name: '张三丰',
        avatar: '/new_avatar.jpg',
        faces_json: JSON.stringify([{ face_path: '/f1.jpg' }]),
      });

      const role = memDB.prepare('SELECT * FROM roles WHERE id = ?').get('r1') as any;
      expect(role.name).toBe('张三丰');
      expect(role.avatar).toBe('/new_avatar.jpg');
      expect(JSON.parse(role.faces_json)).toHaveLength(1);
    });

    it('空字段对象时应直接返回（无操作）', () => {
      insertRole(memDB, { id: 'r1', name: '张三' });

      repo.update('r1', {});

      const role = memDB.prepare('SELECT name FROM roles WHERE id = ?').get('r1') as any;
      expect(role.name).toBe('张三'); // 未变化
    });
  });
});
