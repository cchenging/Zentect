// 📁 路径：src/main/core/__tests__/CacheGarbageCollector.test.ts
// Layer 6 基建: 磁盘缓存垃圾回收单元测试
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock PathManager 以避免 Electron 环境依赖
vi.mock('../../utils/pathManager', () => ({
  PathManager: {
    getProjectsRootPath: vi.fn(),
  },
}));

import { CacheGarbageCollector } from '../../utils/CacheGarbageCollector';
import { PathManager } from '../../utils/pathManager';

describe('CacheGarbageCollector', () => {
  let tempDir: string;
  let cacheDir: string;

  beforeEach(() => {
    // 创建临时目录模拟缓存根
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentect-gc-test-'));
    cacheDir = path.join(tempDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Mock PathManager 返回临时目录
    vi.mocked(PathManager.getProjectsRootPath).mockReturnValue(tempDir);
  });

  afterEach(() => {
    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('应清理超过 7 天的文件', () => {
    const oldFile = path.join(cacheDir, 'old-file.txt');
    fs.writeFileSync(oldFile, 'old data');
    // 修改 mtime 为 8 天前
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, new Date(eightDaysAgo), new Date(eightDaysAgo));

    CacheGarbageCollector.runSilentGC();

    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('应清理超过 7 天的目录', () => {
    const oldDir = path.join(cacheDir, 'old-dir');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'frame.jpg'), 'fake');
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldDir, new Date(eightDaysAgo), new Date(eightDaysAgo));

    CacheGarbageCollector.runSilentGC();

    expect(fs.existsSync(oldDir)).toBe(false);
  });

  it('不应删除 7 天内的文件', () => {
    const recentFile = path.join(cacheDir, 'recent-file.txt');
    fs.writeFileSync(recentFile, 'recent data');

    CacheGarbageCollector.runSilentGC();

    expect(fs.existsSync(recentFile)).toBe(true);
  });

  it('缓存目录不存在时不应报错', () => {
    // 指向不存在的目录
    vi.mocked(PathManager.getProjectsRootPath).mockReturnValue(
      path.join(os.tmpdir(), 'non-exist-' + Date.now())
    );
    expect(() => CacheGarbageCollector.runSilentGC()).not.toThrow();
  });
});
