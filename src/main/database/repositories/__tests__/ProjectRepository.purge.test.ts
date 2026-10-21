// 📁 路径: src/main/database/repositories/__tests__/ProjectRepository.purge.test.ts
// 项目删除「彻底清理」守门测试（2026-10-16）
// 覆盖：getProjectPath 读取真实路径 / purgeProjectScopedData 动态发现并硬删所有 project_id 表
//       （含 checkpoints、step_results、editor_drafts 等旧实现遗漏的表），且不误伤其它项目与无 project_id 表

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { BOOTSTRAP: 'bootstrap', DB: 'db' },
}));

let memDB: Database.Database;

vi.mock('../../../../modules/infra/database/SQLiteConnection', () => ({
  SQLiteConnection: { getInstance: () => ({ getDB: () => memDB }) },
}));

import { ProjectRepository } from '../ProjectRepository';

/** 内存 DB + projects/media_assets/roles/shots 及三张「旧实现会遗漏」的 project_id 表 */
function setupInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT, path TEXT,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP, is_deleted INTEGER DEFAULT 0
    );
    CREATE TABLE media_assets (id TEXT PRIMARY KEY, project_id TEXT, is_deleted INTEGER DEFAULT 0);
    CREATE TABLE roles (id TEXT PRIMARY KEY, project_id TEXT, is_deleted INTEGER DEFAULT 0);
    CREATE TABLE shots (id TEXT PRIMARY KEY, project_id TEXT, is_deleted INTEGER DEFAULT 0);
    CREATE TABLE pipeline_checkpoints (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE step_results (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE editor_drafts (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE workflow_templates (id TEXT PRIMARY KEY, title TEXT);
  `);
  const add = (t: string, id: string, pid: string) =>
    db.prepare(`INSERT INTO ${t}(id, project_id) VALUES (?, ?)`).run(id, pid);
  db.prepare(`INSERT INTO projects(id, name, path) VALUES ('p1', '剧A', 'F:/x/p1')`).run();
  db.prepare(`INSERT INTO projects(id, name, path) VALUES ('p2', '剧B', 'F:/x/p2')`).run();
  add('shots', 's1', 'p1'); add('shots', 's2', 'p2');
  add('media_assets', 'm1', 'p1'); add('media_assets', 'm2', 'p2');
  add('roles', 'r1', 'p1');
  add('pipeline_checkpoints', 'c1', 'p1'); add('pipeline_checkpoints', 'c2', 'p2');
  add('step_results', 'st1', 'p1');
  add('editor_drafts', 'e1', 'p1');
  db.prepare(`INSERT INTO workflow_templates(id, title) VALUES ('w1', '模板')`).run();
  return db;
}

const count = (db: Database.Database, t: string, where = ''): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${t}${where}`).get() as { c: number }).c;

describe('ProjectRepository - 项目彻底删除', () => {
  let repo: ProjectRepository;

  beforeEach(() => {
    memDB = setupInMemoryDB();
    repo = new ProjectRepository();
  });

  it('getProjectPath 返回 DB path，无记录返回 null（不再依赖 PathManager 造目录）', () => {
    expect(repo.getProjectPath('p1')).toBe('F:/x/p1');
    expect(repo.getProjectPath('不存在')).toBeNull();
  });

  it('purgeProjectScopedData 动态清空所有含 project_id 的表（含旧实现遗漏的 3 张），不误伤其它项目/无 project_id 表', () => {
    const res = repo.purgeProjectScopedData('p1');

    expect(res.failed).toEqual([]);
    expect([...res.tables].sort()).toEqual(
      ['editor_drafts', 'media_assets', 'pipeline_checkpoints', 'roles', 'shots', 'step_results'],
    );
    expect(res.rows).toBe(6);

    // p1 数据清零
    for (const t of res.tables) expect(count(memDB, t, ` WHERE project_id='p1'`)).toBe(0);
    // p2 数据不受影响
    expect(count(memDB, 'shots', ` WHERE project_id='p2'`)).toBe(1);
    expect(count(memDB, 'pipeline_checkpoints', ` WHERE project_id='p2'`)).toBe(1);
    // 无 project_id 的表不受影响
    expect(count(memDB, 'workflow_templates')).toBe(1);
    // projects 主表保留（走软删，维持列表 is_deleted=0 过滤契约）
    expect(count(memDB, 'projects')).toBe(2);
  });

  it('delete + purge 组合 = 项目软删（列表不可见）+ 项目数据清零', () => {
    repo.delete('p1');
    repo.purgeProjectScopedData('p1');

    const row = memDB.prepare(`SELECT is_deleted FROM projects WHERE id='p1'`).get() as { is_deleted: number };
    expect(row.is_deleted).toBe(1);
    expect(count(memDB, 'shots', ` WHERE project_id='p1'`)).toBe(0);
    expect(count(memDB, 'media_assets', ` WHERE project_id='p1'`)).toBe(0);
  });
});
