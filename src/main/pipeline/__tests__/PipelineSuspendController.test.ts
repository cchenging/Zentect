import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockEventBus = {
  emitPipelineSuspended: vi.fn(),
  emitPipelineResumed: vi.fn(),
  emitUserActionRequired: vi.fn(),
};

vi.mock('../../engine/TaskEventBus', () => ({
  TaskEventBus: {
    getInstance: () => mockEventBus,
  },
}));

vi.mock('../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PipelineSuspendController } from '../PipelineSuspendController';

describe('PipelineSuspendController', () => {
  let controller: PipelineSuspendController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new PipelineSuspendController();
  });

  afterEach(() => {
    controller.destroy();
  });

  describe('suspend', () => {
    it('creates suspension and returns a promise that blocks', async () => {
      const suspPromise = controller.suspend('prj1', 'm1', 's1', 'confirm_cast', { role: 'actor' });

      expect(controller.isSuspended('prj1', 'm1')).toBe(true);
      expect(mockEventBus.emitPipelineSuspended).toHaveBeenCalledWith({
        projectId: 'prj1', mediaId: 'm1', stepId: 's1',
      });
      expect(mockEventBus.emitUserActionRequired).toHaveBeenCalledWith({
        projectId: 'prj1', mediaId: 'm1', stepId: 's1',
        actionType: 'confirm_cast', context: { role: 'actor' },
      });

      controller.resume({ projectId: 'prj1', mediaId: 'm1', userInput: {} });
      await expect(suspPromise).resolves.toBeUndefined();
    });
  });

  describe('resume', () => {
    it('resolves the suspended promise and cleans up', async () => {
      const suspPromise = controller.suspend('prj1', 'm1', 's1', 'fix_credentials');

      const result = controller.resume({ projectId: 'prj1', mediaId: 'm1', userInput: { key: 'new-key' } });
      expect(result.success).toBe(true);
      expect(mockEventBus.emitPipelineResumed).toHaveBeenCalledWith({
        projectId: 'prj1', mediaId: 'm1',
      });
      expect(controller.isSuspended('prj1', 'm1')).toBe(false);

      await expect(suspPromise).resolves.toBeUndefined();
    });

    it('returns error when no suspension exists', () => {
      const result = controller.resume({ projectId: 'prj1', mediaId: 'm1', userInput: {} });
      expect(result.success).toBe(false);
      expect(result.message).toContain('未找到');
    });
  });

  describe('abandon', () => {
    it('removes suspension without resolving', () => {
      controller.suspend('prj1', 'm1', 's1', 'confirm_cast');
      expect(controller.isSuspended('prj1', 'm1')).toBe(true);

      controller.abandon('prj1', 'm1');
      expect(controller.isSuspended('prj1', 'm1')).toBe(false);
    });
  });

  describe('getSuspension', () => {
    it('returns suspension context when exists', () => {
      controller.suspend('prj1', 'm1', 's1', 'confirm_cast', { role: 'actor' });
      const ctx = controller.getSuspension('prj1', 'm1');
      expect(ctx).toBeDefined();
      expect(ctx!.actionType).toBe('confirm_cast');
      expect(ctx!.context).toEqual({ role: 'actor' });
    });

    it('returns undefined when no suspension', () => {
      expect(controller.getSuspension('prj1', 'm1')).toBeUndefined();
    });
  });

  describe('getActiveSuspensions', () => {
    it('returns all active suspensions', () => {
      controller.suspend('prj1', 'm1', 's1', 'confirm_cast');
      controller.suspend('prj2', 'm2', 's2', 'fix_credentials');
      expect(controller.getActiveSuspensions()).toHaveLength(2);
    });
  });

  describe('isSuspended', () => {
    it('returns true when suspended', () => {
      controller.suspend('prj1', 'm1', 's1', 'confirm_cast');
      expect(controller.isSuspended('prj1', 'm1')).toBe(true);
    });

    it('returns false when not suspended', () => {
      expect(controller.isSuspended('prj1', 'm1')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('clears all suspensions', () => {
      controller.suspend('prj1', 'm1', 's1', 'confirm_cast');
      controller.destroy();
      expect(controller.getActiveSuspensions()).toHaveLength(0);
    });
  });
});
