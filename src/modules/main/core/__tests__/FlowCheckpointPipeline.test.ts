// 📁 路径：src/main/core/__tests__/FlowCheckpointPipeline.test.ts
// Layer 4 进阶: 断点续传管道单元测试
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock MultiChannelPipeline
vi.mock('../MultiChannelPipeline', () => ({
  MultiChannelPipeline: {
    executeWithFailover: vi.fn((primary) => primary()),
  },
}));

vi.mock('../AppLogger', () => ({
  AppLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { FlowCheckpointPipeline } from '../FlowCheckpointPipeline';

// 创建 mock CheckpointRepository
const mockFindByStep = vi.fn();
const mockUpsert = vi.fn();
const mockRepo = { findByStep: mockFindByStep, upsert: mockUpsert } as any;

describe('FlowCheckpointPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Checkpoint 命中时应直接返回缓存结果', async () => {
    mockFindByStep.mockReturnValue({
      status: 'completed',
      checkpoint_data: '{"result": "cached"}',
    });

    const result = await FlowCheckpointPipeline.executeWithCheckpoint(
      'proj-1', 'media-1', 'node-1', 1,
      () => Promise.resolve('primary'),
      () => Promise.resolve('fallback'),
      mockRepo
    );

    expect(result).toBe('{"result": "cached"}');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('Checkpoint 未命中时应执行主通道调用', async () => {
    mockFindByStep.mockReturnValue(undefined);

    const result = await FlowCheckpointPipeline.executeWithCheckpoint(
      'proj-1', 'media-1', 'node-1', 1,
      () => Promise.resolve('primary-result'),
      () => Promise.resolve('fallback-result'),
      mockRepo
    );

    expect(result).toBe('primary-result');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        stepId: 'node-1',
        status: 'completed',
      })
    );
  });

  it('Checkpoint 存在但状态非 completed 时应重新执行', async () => {
    mockFindByStep.mockReturnValue({
      status: 'failed',
      checkpoint_data: null,
    });

    const result = await FlowCheckpointPipeline.executeWithCheckpoint(
      'proj-1', 'media-1', 'node-1', 1,
      () => Promise.resolve('new-result'),
      () => Promise.resolve('fallback-result'),
      mockRepo
    );

    expect(result).toBe('new-result');
    expect(mockUpsert).toHaveBeenCalled();
  });
});
