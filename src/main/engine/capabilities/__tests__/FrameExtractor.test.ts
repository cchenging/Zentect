import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron app — FrameExtractor 内部通过 processManager 间接引用。
// ⚠️ 该 mock 会整体替换全局 setup.ts 的 electron mock，故必须补齐 AppLogger 顶层用到的成员：
//    AppLogger（经 pathManager 间接引入）模块加载期会执行 `if (app.isReady())`，
//    缺 isReady 时整个文件在 import 阶段即崩（"app.isReady is not a function"）。
vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    isReady: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => '/mock/app/path'),
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
