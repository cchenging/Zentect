import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../shared/utils/LogConstants', () => ({
  LOG_TAGS: { PIPELINE: 'pipeline', ENGINE: 'engine' },
}));

import { DatabaseWriteQueue } from '../DatabaseWriteQueue';

describe('DatabaseWriteQueue', () => {
  let queue: DatabaseWriteQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    DatabaseWriteQueue['instance'] = undefined as any;
    queue = DatabaseWriteQueue.getInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes enqueued function and resolves with result', async () => {
    const promise = queue.enqueue(() => 42);
    vi.advanceTimersByTime(10);
    await expect(promise).resolves.toBe(42);
  });

  it('rejects when function throws', async () => {
    const promise = queue.enqueue(() => { throw new Error('db error'); });
    vi.advanceTimersByTime(10);
    await expect(promise).rejects.toThrow('db error');
  });

  it('processes multiple tasks in order', async () => {
    const results: number[] = [];
    const p1 = queue.enqueue(() => results.push(1));
    const p2 = queue.enqueue(() => results.push(2));
    const p3 = queue.enqueue(() => results.push(3));

    vi.advanceTimersByTime(10);
    await Promise.all([p1, p2, p3]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('tracks pending count', async () => {
    queue.enqueue(() => 'a');
    expect(queue.pending).toBe(1);

    queue.enqueue(() => 'b');
    expect(queue.pending).toBe(2);

    vi.advanceTimersByTime(10);
    // After draining, pending should be 0
    expect(queue.pending).toBe(0);
  });

  it('handles empty drain gracefully', async () => {
    // Direct private drain call is not possible, so just test that no error occurs
    // when queue is empty after it processes
    const p = queue.enqueue(() => 'ok');
    vi.advanceTimersByTime(10);
    await expect(p).resolves.toBe('ok');
    expect(queue.pending).toBe(0);
  });

  it('is a singleton', () => {
    const q2 = DatabaseWriteQueue.getInstance();
    expect(q2).toBe(queue);
  });

  it('并发写入不丢数据', async () => {
    const counter = { value: 0 };
    const tasks: Promise<number>[] = [];
    const CONCURRENT = 20;

    for (let i = 0; i < CONCURRENT; i++) {
      tasks.push(queue.enqueue(() => {
        counter.value++;
        return counter.value;
      }));
    }

    // 快进足够步数让所有任务执行完
    for (let i = 0; i < CONCURRENT; i++) {
      vi.advanceTimersByTime(10);
    }

    const results = await Promise.all(tasks);
    expect(counter.value).toBe(CONCURRENT);
    // 顺序不保证但值从 1 到 CONCURRENT
    expect(results.sort((a, b) => a - b)).toEqual(
      Array.from({ length: CONCURRENT }, (_, i) => i + 1)
    );
  });

  it('公共 flush() 方法委托内部 drain', async () => {
    const fn = vi.fn(() => 'flushed');
    queue.enqueue(fn);
    await queue.flush();
    expect(fn).toHaveBeenCalled();
  });
});
