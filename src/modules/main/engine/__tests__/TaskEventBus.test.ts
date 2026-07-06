import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock MainNotifier — TaskEventBus 内部依赖
vi.mock('../../core/MainNotifier', () => ({
  MainNotifier: {
    send: vi.fn(),
    notify: vi.fn(),
    toRenderer: vi.fn(),
  },
}));

vi.mock('../../../shared/utils/IpcConstants', () => ({
  IPC_CHANNELS: {
    PIPELINE_PROGRESS: 'pipeline:progress',
    PIPELINE_COMPLETED: 'pipeline:completed',
    PIPELINE_FAILED: 'pipeline:failed',
  },
}));

import { TaskEventBus } from '../TaskEventBus';

describe('TaskEventBus', () => {
  let bus: TaskEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = TaskEventBus.getInstance();
  });

  it('is a singleton', () => {
    const b2 = TaskEventBus.getInstance();
    expect(b2).toBe(bus);
  });

  it('emits pipeline progress events', () => {
    const spy = vi.fn();
    bus.on('pipeline:progress', spy);

    bus.emitPipelineProgress({
      projectId: 'prj1', stepId: 's1', stepName: '帧提取',
      stepProgress: 50, overallProgress: 7, status: 'running', message: '处理中...',
    });

    expect(spy).toHaveBeenCalled();
  });

  it('emits pipeline completed events', () => {
    const spy = vi.fn();
    bus.on('pipeline:completed', spy);
    bus.emitPipelineCompleted({ projectId: 'prj1', mediaId: 'm1', success: true });
    expect(spy).toHaveBeenCalled();
  });

  it('emits pipeline failed events', () => {
    const spy = vi.fn();
    bus.on('pipeline:failed', spy);
    bus.emitPipelineFailed({ projectId: 'prj1', mediaId: 'm1', success: false, error: 'FFmpeg crash' });
    expect(spy).toHaveBeenCalled();
  });

  it('emits pipeline suspended events', () => {
    const spy = vi.fn();
    bus.on('pipeline:suspended', spy);
    bus.emitPipelineSuspended({ projectId: 'prj1', mediaId: 'm1', stepId: 'step-asr' });
    expect(spy).toHaveBeenCalled();
  });

  it('emits user action required events', () => {
    const spy = vi.fn();
    bus.on('pipeline:require-user-action', spy);
    bus.emitUserActionRequired({ projectId: 'prj1', mediaId: 'm1', actionType: 'confirm_role', stepId: 'step-script', context: {} });
    expect(spy).toHaveBeenCalled();
  });
});
