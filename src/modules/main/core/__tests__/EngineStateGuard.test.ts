// 📁 路径：src/main/core/__tests__/EngineStateGuard.test.ts
// Layer 3 算力互斥锁单元测试
import { describe, it, expect, beforeEach } from 'vitest';
import { EngineStateGuard } from '../EngineStateGuard';

describe('EngineStateGuard', () => {
  beforeEach(() => {
    // 每个测试前强制清空所有锁
    EngineStateGuard.forceReset();
  });

  it('首次锁定应成功', () => {
    const result = EngineStateGuard.acquire('node-1', 'vision-extract');
    expect(result).toBe(true);
  });

  it('同一节点重复锁定应被拦截', () => {
    EngineStateGuard.acquire('node-1', 'vision-extract');
    const result = EngineStateGuard.acquire('node-1', 'vision-extract');
    expect(result).toBe(false);
  });

  it('不同节点应可并行锁定', () => {
    const r1 = EngineStateGuard.acquire('node-1', 'vision-extract');
    const r2 = EngineStateGuard.acquire('node-2', 'audio-separate');
    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  it('释放后应可重新锁定', () => {
    EngineStateGuard.acquire('node-1', 'vision-extract');
    EngineStateGuard.release('node-1');
    const result = EngineStateGuard.acquire('node-1', 'vision-extract');
    expect(result).toBe(true);
  });

  it('isRunning 应正确反映节点状态', () => {
    expect(EngineStateGuard.isRunning('node-1')).toBe(false);
    EngineStateGuard.acquire('node-1', 'vision-extract');
    expect(EngineStateGuard.isRunning('node-1')).toBe(true);
    EngineStateGuard.release('node-1');
    expect(EngineStateGuard.isRunning('node-1')).toBe(false);
  });

  it('getActiveNodes 应返回所有活跃节点', () => {
    EngineStateGuard.acquire('node-1', 'vision-extract');
    EngineStateGuard.acquire('node-2', 'audio-separate');
    const active = EngineStateGuard.getActiveNodes();
    expect(active).toContain('node-1');
    expect(active).toContain('node-2');
  });

  it('forceReset 应清空所有锁', () => {
    EngineStateGuard.acquire('node-1', 'vision-extract');
    EngineStateGuard.acquire('node-2', 'audio-separate');
    EngineStateGuard.forceReset();
    expect(EngineStateGuard.getActiveNodes()).toHaveLength(0);
  });
});
