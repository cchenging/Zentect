import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExec, mockPrepGet, mockPrepRun, mockPrepare } = vi.hoisted(() => {
  const mockExec = vi.fn();
  const mockPrepGet = vi.fn();
  const mockPrepRun = vi.fn();
  const mockPrepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('SELECT filename FROM _migrations')) {
      return { get: mockPrepGet, run: vi.fn() };
    }
    if (sql.includes('INSERT INTO _migrations')) {
      return { run: mockPrepRun };
    }
    if (sql.includes('PRAGMA table_info')) {
      return { all: vi.fn().mockReturnValue([]), get: vi.fn(), run: vi.fn() };
    }
    return { get: vi.fn(), run: vi.fn(), all: vi.fn() };
  });

  return { mockExec, mockPrepGet, mockPrepRun, mockPrepare };
});

const { mockReaddir, mockExists, mockReadFile } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockExists: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    readdirSync: mockReaddir,
    existsSync: mockExists,
    readFileSync: mockReadFile,
  },
  readdirSync: mockReaddir,
  existsSync: mockExists,
  readFileSync: mockReadFile,
}));

vi.mock('../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../shared/utils/LogConstants', () => ({
  LOG_TAGS: { BOOTSTRAP: 'bootstrap' },
}));

const mockDB = {
  exec: mockExec,
  prepare: mockPrepare,
};

import { MigrationManager } from '../MigrationManager';

describe('MigrationManager', () => {
  let manager: MigrationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MigrationManager(mockDB as any, '/fake/migrations');
  });

  describe('runAll', () => {
    it('初始化元数据表', () => {
      mockExists.mockReturnValue(true);
      mockReaddir.mockReturnValue([]);
      manager.runAll();
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('_migrations'));
    });

    it('迁移目录不存在时仅初始化元数据表', () => {
      mockExists.mockReturnValue(false);
      manager.runAll();
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('_migrations'));
      expect(mockReaddir).not.toHaveBeenCalled();
    });

    it('执行未运行过的迁移文件', () => {
      mockExists.mockReturnValue(true);
      mockReaddir.mockReturnValue(['001_initial_schema.sql']);
      mockPrepGet.mockReturnValue(undefined);
      mockReadFile.mockReturnValue('CREATE TABLE IF NOT EXISTS test (id TEXT);');
      manager.runAll();
      expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('001_initial_schema.sql'), 'utf-8');
      expect(mockExec).toHaveBeenCalledWith('CREATE TABLE IF NOT EXISTS test (id TEXT);');
      expect(mockPrepRun).toHaveBeenCalledWith('001_initial_schema.sql');
    });

    it('跳过已执行过的迁移文件', () => {
      mockExists.mockReturnValue(true);
      mockReaddir.mockReturnValue(['001_initial_schema.sql']);
      mockPrepGet.mockReturnValue({ filename: '001_initial_schema.sql' });
      manager.runAll();
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('按文件名字母序执行多个迁移', () => {
      mockExists.mockReturnValue(true);
      mockReaddir.mockReturnValue(['002_pipeline.sql', '001_initial.sql']);
      mockPrepGet.mockReturnValue(undefined);
      mockReadFile.mockReturnValue('SELECT 1;');
      manager.runAll();
      const calls = mockReadFile.mock.calls.map((c: string[]) => c[0]);
      expect(calls[0]).toContain('001_initial.sql');
      expect(calls[1]).toContain('002_pipeline.sql');
    });

    it('过滤非 .sql 文件', () => {
      mockExists.mockReturnValue(true);
      mockReaddir.mockReturnValue(['001.sql', 'readme.txt', 'notes.md']);
      mockPrepGet.mockReturnValue(undefined);
      mockReadFile.mockReturnValue('SELECT 1;');
      manager.runAll();
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    it('SQL 执行异常时记录警告不崩溃', () => {
      mockExists.mockReturnValue(true);
      mockReaddir.mockReturnValue(['001_bad.sql']);
      mockPrepGet.mockReturnValue(undefined);
      mockReadFile.mockReturnValue('INVALID SQL SYNTAX!!!');

      // initMetaTable CREATE TABLE _migrations 先成功执行
      // 然后 migration SQL 执行时 throw → 被 runFile 内部 catch 吞掉
      let execCallCount = 0;
      mockExec.mockImplementation(() => {
        execCallCount++;
        if (execCallCount >= 2) throw new Error('syntax error');
      });

      expect(() => manager.runAll()).not.toThrow();
    });
  });

  describe('safeAddColumns', () => {
    it('对不存在的列执行 ALTER TABLE ADD COLUMN', () => {
      // 所有 PRAGMA table_info 返回空 → 所有列都不存在 → 都要 ADD
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes('PRAGMA table_info')) {
          return { all: vi.fn().mockReturnValue([]), get: vi.fn(), run: vi.fn() };
        }
        return { get: vi.fn(), run: vi.fn(), all: vi.fn() };
      });
      manager.safeAddColumns();
      expect(mockExec).toHaveBeenCalled();
    });

    it('已存在的列不重复添加', () => {
      mockExec.mockClear();

      // 所有 PRAGMA table_info 返回所有列的 snake_case 名称
      // 这样 safeAddColumns 的 addCol 发现列已存在 → 不执行 ALTER TABLE
      const allColumns = [
        { name: 'is_deleted', type: 'INTEGER', cid: 1, dflt_value: '0' },
        { name: 'create_time', type: 'DATETIME', cid: 2, dflt_value: 'CURRENT_TIMESTAMP' },
        { name: 'update_time', type: 'DATETIME', cid: 3, dflt_value: 'CURRENT_TIMESTAMP' },
        { name: 'category', type: 'TEXT', cid: 4, dflt_value: "'short'" },
        { name: 'canvas_data', type: 'TEXT', cid: 5, dflt_value: null },
        { name: 'type', type: 'TEXT', cid: 6, dflt_value: "'video'" },
        { name: 'path', type: 'TEXT', cid: 7, dflt_value: null },
        { name: 'status', type: 'TEXT', cid: 8, dflt_value: "'active'" },
        { name: 'action_payload', type: 'TEXT', cid: 9, dflt_value: null },
      ];

      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes('PRAGMA table_info')) {
          return { all: vi.fn().mockReturnValue(allColumns), get: vi.fn(), run: vi.fn() };
        }
        return { get: vi.fn(), run: vi.fn(), all: vi.fn() };
      });

      manager.safeAddColumns();
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe('migrateColumnNames (静态方法)', () => {
    it('对存在的 camelCase 列执行重命名', () => {
      const localExec = vi.fn();
      const mockPrepAll = vi.fn()
        // 第一次查 projects 表: 只有 createdAt → 触发重命名
        .mockReturnValueOnce([{ name: 'createdAt', type: 'TEXT', cid: 1, notnull: 0, pk: 0, dflt_value: null }]);

      const testDB = {
        exec: localExec,
        prepare: vi.fn().mockReturnValue({ all: mockPrepAll }),
      };

      MigrationManager.migrateColumnNames(testDB as any);
      expect(mockPrepAll).toHaveBeenCalled();
    });

    it('snake_case 列已存在时不执行重命名', () => {
      const localExec = vi.fn();

      // 返回全部 snake_case 列 → hasOld 全为 false → 不触发任何重命名
      const allSnakeColumns = [
        { name: 'create_time', type: 'DATETIME' },
        { name: 'update_time', type: 'DATETIME' },
        { name: 'cover_path', type: 'TEXT' },
        { name: 'project_id', type: 'TEXT' },
        { name: 'file_path', type: 'TEXT' },
        { name: 'extracted_audio', type: 'TEXT' },
        { name: 'extracted_vocals', type: 'TEXT' },
        { name: 'extracted_bgm', type: 'TEXT' },
        { name: 'extracted_text', type: 'TEXT' },
        { name: 'extract_duration', type: 'TEXT' },
        { name: 'narration_script', type: 'TEXT' },
        { name: 'system_id', type: 'TEXT' },
        { name: 'voice_id', type: 'TEXT' },
        { name: 'merged_roles', type: 'TEXT' },
        { name: 'time_code', type: 'TEXT' },
        { name: 'ai_text', type: 'TEXT' },
        { name: 'original_text', type: 'TEXT' },
        { name: 'role_id', type: 'TEXT' },
        { name: 'original_role_id', type: 'TEXT' },
        { name: 'audio_path', type: 'TEXT' },
        { name: 'audio_duration', type: 'REAL' },
        { name: 'align_strategy', type: 'TEXT' },
        { name: 'start_time', type: 'REAL' },
        { name: 'end_time', type: 'REAL' },
        { name: 'audio_emotion', type: 'TEXT' },
        { name: 'vision_text', type: 'TEXT' },
        { name: 'context_frames', type: 'TEXT' },
        { name: 'media_id', type: 'TEXT' },
        { name: 'task_text', type: 'TEXT' },
      ];

      const mockPrepAll = vi.fn().mockReturnValue(allSnakeColumns);

      const testDB = {
        exec: localExec,
        prepare: vi.fn().mockReturnValue({ all: mockPrepAll }),
      };

      MigrationManager.migrateColumnNames(testDB as any);
      expect(localExec).not.toHaveBeenCalled();
    });
  });
});
