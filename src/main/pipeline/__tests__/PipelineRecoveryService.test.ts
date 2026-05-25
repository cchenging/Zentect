import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockCheckpointRepo = {
  findByProject: vi.fn(),
  findIncompleteByProject: vi.fn(),
  upsert: vi.fn(),
  deleteByProject: vi.fn(),
};

vi.mock('../CheckpointRepository', () => {
  return {
    CheckpointRepository: class {
      findByProject = mockCheckpointRepo.findByProject;
      findIncompleteByProject = mockCheckpointRepo.findIncompleteByProject;
      upsert = mockCheckpointRepo.upsert;
      deleteByProject = mockCheckpointRepo.deleteByProject;
    },
  };
});

import { PipelineRecoveryService } from '../PipelineRecoveryService';

const mkCP = (overrides: Record<string, any> = {}) => ({
  id: 'cp1', project_id: 'prj1', media_id: 'm1', step_id: 's1',
  step_order: 1, status: 'running', checkpoint_data: null,
  error_message: null, degraded: 0, create_time: '', update_time: '',
  ...overrides,
});

describe('PipelineRecoveryService', () => {
  let service: PipelineRecoveryService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    PipelineRecoveryService['instance'] = undefined as any;
    service = new PipelineRecoveryService();
  });

  describe('probeProject', () => {
    it('returns null when no checkpoints exist', () => {
      mockCheckpointRepo.findByProject.mockReturnValue([]);
      expect(service.probeProject('prj1')).toBeNull();
    });

    it('returns null when all checkpoints complete', () => {
      mockCheckpointRepo.findByProject.mockReturnValue([
        mkCP({ step_id: 's1', status: 'completed' }),
        mkCP({ id: 'cp2', step_id: 's2', status: 'completed' }),
      ]);
      mockCheckpointRepo.findIncompleteByProject.mockReturnValue([]);
      expect(service.probeProject('prj1')).toBeNull();
    });

    it('detects failed steps and returns recovery status', () => {
      mockCheckpointRepo.findByProject.mockReturnValue([
        mkCP({ step_id: 's1', status: 'completed' }),
        mkCP({ id: 'cp2', step_id: 's2', status: 'failed', error_message: 'FFmpeg crash' }),
      ]);
      mockCheckpointRepo.findIncompleteByProject.mockReturnValue([
        mkCP({ id: 'cp2', step_id: 's2', status: 'failed', error_message: 'FFmpeg crash' }),
      ]);

      const result = service.probeProject('prj1');
      expect(result).not.toBeNull();
      expect(result!.hasIncomplete).toBe(true);
      expect(result!.failedStepId).toBe('s2');
      expect(result!.completedSteps).toContain('s1');
      expect(result!.totalSteps).toBe(2);
    });

    it('marks running steps as failed for crash recovery', () => {
      mockCheckpointRepo.findByProject.mockReturnValue([
        mkCP({ step_id: 's1', status: 'completed' }),
        mkCP({ id: 'cp2', step_id: 's2', status: 'running' }),
      ]);
      mockCheckpointRepo.findIncompleteByProject.mockReturnValue([
        mkCP({ id: 'cp2', step_id: 's2', status: 'running' }),
      ]);

      service.probeProject('prj1');
      expect(mockCheckpointRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed', errorMessage: 'SYS_CRASH_RECOVERY' })
      );
    });
  });

  describe('probeAllProjects', () => {
    it('returns recovery statuses for multiple projects', () => {
      mockCheckpointRepo.findByProject.mockImplementation((projectId: string) => {
        if (projectId === 'prj1') return [];
        return [mkCP({ project_id: 'prj2', step_id: 's1', status: 'failed', error_message: 'err' })];
      });
      mockCheckpointRepo.findIncompleteByProject.mockImplementation((projectId: string) => {
        if (projectId === 'prj1') return [];
        return [mkCP({ project_id: 'prj2', step_id: 's1', status: 'failed', error_message: 'err' })];
      });

      const results = service.probeAllProjects(['prj1', 'prj2']);
      expect(results).toHaveLength(1);
      expect(results[0].projectId).toBe('prj2');
    });

    it('单个项目异常时不影响其他项目继续探测', () => {
      mockCheckpointRepo.findByProject.mockImplementation((projectId: string) => {
        if (projectId === 'bad-prj') throw new Error('DB connection lost');
        if (projectId === 'good-prj') return [
          mkCP({ project_id: 'good-prj', step_id: 's1', status: 'failed', error_message: 'err' })
        ];
        return [];
      });
      mockCheckpointRepo.findIncompleteByProject.mockImplementation((projectId: string) => {
        if (projectId === 'bad-prj') throw new Error('DB connection lost');
        if (projectId === 'good-prj') return [
          mkCP({ project_id: 'good-prj', step_id: 's1', status: 'failed', error_message: 'err' })
        ];
        return [];
      });

      const results = service.probeAllProjects(['bad-prj', 'good-prj']);
      expect(results).toHaveLength(1);
      expect(results[0].projectId).toBe('good-prj');
    });
  });

  describe('error isolation during running→failed transition', () => {
    it('upsert 部分失败时不影响其他 checkpoint 的标记', () => {
      mockCheckpointRepo.findByProject.mockReturnValue([
        mkCP({ id: 'cp1', step_id: 's1', status: 'running' }),
        mkCP({ id: 'cp2', step_id: 's2', status: 'running' }),
        mkCP({ id: 'cp3', step_id: 's3', status: 'running' }),
      ]);
      mockCheckpointRepo.findIncompleteByProject.mockReturnValue([
        mkCP({ id: 'cp1', step_id: 's1', status: 'running' }),
        mkCP({ id: 'cp2', step_id: 's2', status: 'running' }),
        mkCP({ id: 'cp3', step_id: 's3', status: 'running' }),
      ]);

      let callCount = 0
      mockCheckpointRepo.upsert.mockImplementation(() => {
        callCount++
        if (callCount === 2) throw new Error('中間 upsert 失敗')
      })

      service.probeProject('prj1')

      expect(mockCheckpointRepo.upsert).toHaveBeenCalledTimes(3)
    })
  })

  describe('continuePipeline', () => {
    it('returns shouldContinue when incomplete exists', () => {
      mockCheckpointRepo.findByProject.mockReturnValue([
        mkCP({ step_id: 's1', status: 'completed' }),
        mkCP({ id: 'cp2', step_id: 's2', status: 'failed' }),
      ]);

      const result = service.continuePipeline('prj1');
      expect(result.shouldContinue).toBe(true);
      expect(result.completedSteps).toContain('s1');
    });

    it('returns shouldContinue=false when all steps complete', () => {
      mockCheckpointRepo.findByProject.mockReturnValue([
        mkCP({ step_id: 's1', status: 'completed' }),
        mkCP({ id: 'cp2', step_id: 's2', status: 'completed' }),
      ]);

      const result = service.continuePipeline('prj1');
      expect(result.shouldContinue).toBe(false);
    });
  });

  describe('abandonPipeline', () => {
    it('deletes checkpoints for project', () => {
      service.abandonPipeline('prj1');
      expect(mockCheckpointRepo.deleteByProject).toHaveBeenCalledWith('prj1');
    });
  });
});
