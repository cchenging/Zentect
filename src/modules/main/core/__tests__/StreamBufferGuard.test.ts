// 📁 路径：src/main/core/__tests__/StreamBufferGuard.test.ts
// Layer 4 进阶: 流式断点保护单元测试
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamBufferGuard } from '../StreamBufferGuard';

describe('StreamBufferGuard', () => {
  let guard: StreamBufferGuard;

  beforeEach(() => {
    guard = new StreamBufferGuard();
  });

  it('追加数据后应能获取缓存', () => {
    guard.append('hello');
    guard.append(' world');
    expect(guard.getCache()).toBe('hello world');
  });

  it('reset 应清空缓存', () => {
    guard.append('data');
    guard.reset();
    expect(guard.getCache()).toBe('');
  });

  it('完整 JSON 应通过验证', () => {
    guard.append('```json\n[{"id": 1}]\n```');
    const result = guard.rollbackOrResolve();
    expect(result).toBe('[{"id": 1}]');
  });

  it('残缺 JSON 应回滚为空契约', () => {
    guard.append('```json\n[{"id": 1}, {"id": 2');
    const result = guard.rollbackOrResolve();
    expect(result).toBe('[]');
  });

  it('纯文本非 JSON 应回滚为空契约', () => {
    guard.append('This is not JSON at all');
    const result = guard.rollbackOrResolve();
    expect(result).toBe('[]');
  });

  it('带前后废话的完整 JSON 应通过验证', () => {
    guard.append('好的，以下是结果：\n{"key": "value"}\n以上是输出。');
    const result = guard.rollbackOrResolve();
    expect(result).toBe('{"key": "value"}');
  });

  it('空缓存应回滚为空契约', () => {
    const result = guard.rollbackOrResolve();
    expect(result).toBe('[]');
  });
});
