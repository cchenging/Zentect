import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron app — FrameExtractor 内部通过 processManager 间接引用
vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
  },
}));

vi.mock('../../utils/processManager', () => ({
  ProcessManager: {
    register: vi.fn(),
    kill: vi.fn(),
    killAll: vi.fn(),
    killTree: vi.fn(),
    startProcess: vi.fn(),
    processes: new Map(),
  },
}));

vi.mock('../../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: { MEDIA: 'media', FRAME: 'frame' },
}));

import { FrameExtractor } from '../FrameExtractor';

describe('FrameExtractor', () => {
  let extractor: FrameExtractor;

  beforeEach(() => {
    extractor = new FrameExtractor();
  });

  it('creates instance successfully', () => {
    expect(extractor).toBeDefined();
    expect(extractor).toBeInstanceOf(FrameExtractor);
  });
});
