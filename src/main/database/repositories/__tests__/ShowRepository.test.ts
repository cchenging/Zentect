// 📁 路径: src/main/database/repositories/__tests__/ShowRepository.test.ts
// 🎬 P2-A 剧集语义层 — CRUD/项目绑定/事务原子性单元测试
// 使用内存 SQLite 验证：
//   1. create/findAll/findById/update/delete CRUD
//   2. bindProject/unbindProject 项目关联（含 episodeNumber 自动递增）
//   3. findProjectsByShowId 按集数升序查询
//   4. delete 事务原子性（软删剧集同时解绑所有项目）
//   5. episode_count 缓存字段自动重算

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

/** 内存 SQLite 实例 */
let memDB: Database.Database;

vi.mock('../../../../modules/infra/database/SQLiteConnection', () => ({
  SQLiteConnection: {
    getInstance: () => ({
      getDB: () => memDB,
    }),
  },
}));

import { ShowRepository } from '../ShowRepository';

/**
 * 初始化内存 DB 并创建 shows + projects 表（与迁移 028 一致）
 */
function setupInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE IF NOT EXISTS shows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cover_path TEXT,
      description TEXT,
      episode_count INTEGER NOT NULL DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      show_id TEXT,
      episode_number INTEGER,
      cover_path TEXT,
      duration TEXT,
      status TEXT DEFAULT 'active',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

/**
 * 插入测试用项目记录
 */
function insertTestProject(db: Database.Database, id: string, name: string): void {
  db.prepare(`
    INSERT INTO projects (id, name, show_id, episode_number, status, is_deleted)
    VALUES (?, ?, NULL, NULL, 'active', 0)
  `).run(id, name);
}

describe('ShowRepository', () => {
  let repo: ShowRepository;

  beforeEach(() => {
    memDB = setupInMemoryDB();
    repo = new ShowRepository();
  });

  describe('CRUD', () => {
    it('create 创建剧集后 findById 能查到', () => {
      const show = repo.create({ id: 'show_001', name: '琅琊榜' });
      expect(show.id).toBe('show_001');
      expect(show.name).toBe('琅琊榜');
      expect(show.episodeCount).toBe(0);

      const found = repo.findById('show_001');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('琅琊榜');
    });

    it('findAll 返回所有未删除剧集', () => {
      repo.create({ id: 'show_001', name: '剧集A' });
      repo.create({ id: 'show_002', name: '剧集B' });

      const all = repo.findAll();
      expect(all).toHaveLength(2);
      // 同秒创建时 update_time 相同，排序不稳定，只验证两条记录都存在
      const ids = all.map((s) => s.id).sort();
      expect(ids).toEqual(['show_001', 'show_002']);
    });

    it('update 更新名称/封面/描述', () => {
      repo.create({ id: 'show_001', name: '旧名' });
      repo.update('show_001', { name: '新名', coverPath: '/cover.jpg', description: '简介' });

      const updated = repo.findById('show_001')!;
      expect(updated.name).toBe('新名');
      expect(updated.coverPath).toBe('/cover.jpg');
      expect(updated.description).toBe('简介');
    });

    it('delete 软删后 findById 返回 null', () => {
      repo.create({ id: 'show_001', name: '待删' });
      const result = repo.delete('show_001');
      expect(result.unbindCount).toBe(0);
      expect(repo.findById('show_001')).toBeNull();
      expect(repo.findAll()).toHaveLength(0);
    });
  });

  describe('bindProject 项目绑定', () => {
    it('绑定项目到剧集，episodeNumber 自动递增', () => {
      repo.create({ id: 'show_001', name: '剧集' });
      insertTestProject(memDB, 'proj_001', '第1集项目');
      insertTestProject(memDB, 'proj_002', '第2集项目');

      // 第一个项目：episodeNumber 自动取 1
      repo.bindProject('proj_001', 'show_001');
      // 第二个项目：episodeNumber 自动取 2
      repo.bindProject('proj_002', 'show_001');

      const projects = repo.findProjectsByShowId('show_001');
      expect(projects).toHaveLength(2);
      expect(projects[0].episodeNumber).toBe(1);
      expect(projects[1].episodeNumber).toBe(2);

      // episode_count 缓存字段应自动重算为 2
      const show = repo.findById('show_001')!;
      expect(show.episodeCount).toBe(2);
    });

    it('绑定项目时显式指定 episodeNumber', () => {
      repo.create({ id: 'show_001', name: '剧集' });
      insertTestProject(memDB, 'proj_001', '第5集项目');

      repo.bindProject('proj_001', 'show_001', 5);

      const projects = repo.findProjectsByShowId('show_001');
      expect(projects[0].episodeNumber).toBe(5);
    });

    it('findProjectsByShowId 按集数升序排列', () => {
      repo.create({ id: 'show_001', name: '剧集' });
      insertTestProject(memDB, 'proj_003', '第3集');
      insertTestProject(memDB, 'proj_001', '第1集');
      insertTestProject(memDB, 'proj_002', '第2集');

      // 故意按 3,1,2 顺序绑定（显式指定集数）
      repo.bindProject('proj_003', 'show_001', 3);
      repo.bindProject('proj_001', 'show_001', 1);
      repo.bindProject('proj_002', 'show_001', 2);

      const projects = repo.findProjectsByShowId('show_001');
      expect(projects.map((p) => p.episodeNumber)).toEqual([1, 2, 3]);
    });
  });

  describe('unbindProject 项目解绑', () => {
    it('解绑后项目不再属于该剧集，episode_count 重算', () => {
      repo.create({ id: 'show_001', name: '剧集' });
      insertTestProject(memDB, 'proj_001', '第1集');
      insertTestProject(memDB, 'proj_002', '第2集');

      repo.bindProject('proj_001', 'show_001');
      repo.bindProject('proj_002', 'show_001');
      expect(repo.findById('show_001')!.episodeCount).toBe(2);

      // 解绑第1个项目
      repo.unbindProject('proj_001');

      const projects = repo.findProjectsByShowId('show_001');
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe('proj_002');

      // episode_count 应重算为 1
      expect(repo.findById('show_001')!.episodeCount).toBe(1);
    });

    it('解绑未关联剧集的项目不报错', () => {
      insertTestProject(memDB, 'proj_001', '独立项目');
      // 未绑定过，解绑应静默成功
      expect(() => repo.unbindProject('proj_001')).not.toThrow();
    });
  });

  describe('delete 事务原子性', () => {
    it('删除剧集时同时解绑其下所有项目', () => {
      repo.create({ id: 'show_001', name: '剧集' });
      insertTestProject(memDB, 'proj_001', '第1集');
      insertTestProject(memDB, 'proj_002', '第2集');
      insertTestProject(memDB, 'proj_003', '第3集');

      repo.bindProject('proj_001', 'show_001');
      repo.bindProject('proj_002', 'show_001');
      repo.bindProject('proj_003', 'show_001');

      // 删除剧集，应解绑 3 个项目
      const result = repo.delete('show_001');
      expect(result.unbindCount).toBe(3);

      // 剧集已软删
      expect(repo.findById('show_001')).toBeNull();

      // 项目仍存在，但 show_id 已置 NULL
      const projects = repo.findProjectsByShowId('show_001');
      expect(projects).toHaveLength(0);

      // 验证项目记录本身未被删除，只是 show_id 被清空
      const proj1 = memDB.prepare('SELECT show_id FROM projects WHERE id = ?').get('proj_001') as { show_id: string | null };
      expect(proj1.show_id).toBeNull();
    });
  });

  describe('countProjectsByShowId', () => {
    it('统计剧集下项目数', () => {
      repo.create({ id: 'show_001', name: '剧集' });
      insertTestProject(memDB, 'proj_001', '第1集');
      insertTestProject(memDB, 'proj_002', '第2集');

      repo.bindProject('proj_001', 'show_001');
      repo.bindProject('proj_002', 'show_001');

      expect(repo.countProjectsByShowId('show_001')).toBe(2);
    });

    it('空剧集返回 0', () => {
      repo.create({ id: 'show_001', name: '空剧集' });
      expect(repo.countProjectsByShowId('show_001')).toBe(0);
    });
  });

  describe('generateId', () => {
    it('生成的 ID 以 show_ 前缀开头', () => {
      const id = ShowRepository.generateId();
      expect(id.startsWith('show_')).toBe(true);
      expect(id.length).toBeGreaterThan('show_'.length);
    });

    it('多次生成 ID 不重复', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(ShowRepository.generateId());
      }
      expect(ids.size).toBe(100);
    });
  });
});
