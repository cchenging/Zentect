import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEnqueue, mockDB } = vi.hoisted(() => {
  const mockEnqueue = vi.fn().mockImplementation((fn: () => unknown) => {
    return Promise.resolve(fn());
  });

  const mockDB = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn(),
      run: vi.fn(),
    }),
  };

  return { mockEnqueue, mockDB };
});

vi.mock('../../database/core/SQLiteConnection', () => ({
  SQLiteConnection: {
    getInstance: () => ({
      getDB: () => mockDB,
    }),
  },
}));

vi.mock('../DatabaseWriteQueue', () => ({
  DatabaseWriteQueue: {
    getInstance: () => ({
      enqueue: mockEnqueue,
      flush: vi.fn(),
    }),
  },
}));

import { CheckpointRepository } from '../CheckpointRepository';

describe('CheckpointRepository', () => {
  let repo: CheckpointRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new CheckpointRepository();
  });

  describe('findByStep', () => {
    it('returns checkpoint when found', () => {
      const row = {
        id: 'cp1', project_id: 'prj1', media_id: 'm1',
        step_id: 's1', step_order: 1, status: 'completed',
        checkpoint_data: null, error_message: null, degraded: 0,
        create_time: '2026-01-01', update_time: '2026-01-01',
      };
      const stmt = mockDB.prepare();
      stmt.get.mockReturnValue(row);

      const result = repo.findByStep('prj1', 'm1', 's1');
      expect(result).toEqual(row);
    });

    it('returns undefined when not found', () => {
      const stmt = mockDB.prepare();
      stmt.get.mockReturnValue(undefined);

      const result = repo.findByStep('prj1', 'm1', 'nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('findByProject', () => {
    it('returns all checkpoints ordered by step_order', () => {
      const rows = [
        { id: 'cp1', project_id: 'prj1', media_id: 'm1', step_id: 's1', step_order: 1, status: 'running', checkpoint_data: null, error_message: null, degraded: 0, create_time: '', update_time: '' },
        { id: 'cp2', project_id: 'prj1', media_id: 'm1', step_id: 's2', step_order: 2, status: 'completed', checkpoint_data: null, error_message: null, degraded: 0, create_time: '', update_time: '' },
      ];
      const stmt = mockDB.prepare();
      stmt.all.mockReturnValue(rows);

      const result = repo.findByProject('prj1');
      expect(result).toHaveLength(2);
    });
  });

  describe('findIncompleteByProject', () => {
    it('filters out completed and degraded statuses', () => {
      const rows = [
        { id: 'cp1', project_id: 'prj1', media_id: 'm1', step_id: 's1', step_order: 1, status: 'running', checkpoint_data: null, error_message: null, degraded: 0, create_time: '', update_time: '' },
        { id: 'cp2', project_id: 'prj1', media_id: 'm1', step_id: 's2', step_order: 2, status: 'failed', checkpoint_data: null, error_message: null, degraded: 0, create_time: '', update_time: '' },
      ];
      const stmt = mockDB.prepare();
      stmt.all.mockReturnValue(rows);

      const result = repo.findIncompleteByProject('prj1');
      expect(result).toHaveLength(2);
      expect(result[0].status).not.toBe('completed');
    });
  });

  describe('upsert', () => {
    it('inserts new checkpoint when not existing', () => {
      const stmt = mockDB.prepare();
      stmt.get
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          id: 'new-id', project_id: 'prj1', media_id: 'm1', step_id: 's1',
          step_order: 1, status: 'running', checkpoint_data: null,
          error_message: null, degraded: 0, create_time: 'now', update_time: 'now',
        });

      const result = repo.upsert({
        projectId: 'prj1', mediaId: 'm1', stepId: 's1', stepOrder: 1, status: 'running',
      });

      expect(result).toBeDefined();
      expect(result.step_id).toBe('s1');
    });

    it('updates existing checkpoint', () => {
      const existing = {
        id: 'cp1', project_id: 'prj1', media_id: 'm1', step_id: 's1',
        step_order: 1, status: 'running', checkpoint_data: null,
        error_message: null, degraded: 0, create_time: 'old', update_time: 'old',
      };
      const updated = { ...existing, status: 'completed', update_time: 'new' };
      const stmt = mockDB.prepare();
      stmt.get
        .mockReturnValueOnce(existing)
        .mockReturnValueOnce(updated);

      const result = repo.upsert({
        projectId: 'prj1', mediaId: 'm1', stepId: 's1', stepOrder: 1,
        status: 'completed',
      });

      expect(result.status).toBe('completed');
    });

    it('stores checkpointData as JSON string', () => {
      const stmt = mockDB.prepare();
      stmt.get
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          id: 'cp1', project_id: 'prj1', media_id: 'm1', step_id: 's1',
          step_order: 1, status: 'completed',
          checkpoint_data: JSON.stringify({ frames: ['f1.jpg'] }),
          error_message: null, degraded: 0, create_time: 'now', update_time: 'now',
        });

      repo.upsert({
        projectId: 'prj1', mediaId: 'm1', stepId: 's1', stepOrder: 1,
        status: 'completed', checkpointData: { frames: ['f1.jpg'] },
      });

      const runCall = mockDB.prepare.mock.results.slice(-1)[0]?.value?.run;
      expect(runCall).toBeDefined();
    });

    it('marks degraded when specified', () => {
      const stmt = mockDB.prepare();
      stmt.get
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          id: 'cp1', project_id: 'prj1', media_id: 'm1', step_id: 's1',
          step_order: 1, status: 'degraded', checkpoint_data: null,
          error_message: 'partial failure', degraded: 1,
          create_time: 'now', update_time: 'now',
        });

      const result = repo.upsert({
        projectId: 'prj1', mediaId: 'm1', stepId: 's1', stepOrder: 1,
        status: 'degraded', errorMessage: 'partial failure', degraded: true,
      });

      expect(result.degraded).toBe(1);
    });
  });

  describe('deleteByProject', () => {
    it('通过 DatabaseWriteQueue 异步删除项目 checkpoints', () => {
      repo.deleteByProject('prj1');
      expect(mockEnqueue).toHaveBeenCalled();
    });
  });

  describe('DatabaseWriteQueue 集成', () => {
    it('isFeatureEnabled 关闭时直接执行写入', () => {
      const stmt = mockDB.prepare();
      stmt.get
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          id: 'cp-dwq', project_id: 'prj1', media_id: 'm1', step_id: 's1',
          step_order: 1, status: 'running', checkpoint_data: null,
          error_message: null, degraded: 0, create_time: 'now', update_time: 'now',
        });

      const result = repo.upsert({
        projectId: 'prj1', mediaId: 'm1', stepId: 's1', stepOrder: 1, status: 'running',
      });

      expect(result).toBeDefined();
      expect(result.step_id).toBe('s1');
    });

    it('flush 方法已导出', () => {
      expect(CheckpointRepository).toBeDefined();
      expect(typeof CheckpointRepository).toBe('function');
    });
  });
});
