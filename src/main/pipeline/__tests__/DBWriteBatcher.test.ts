import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../shared/utils/LogConstants', () => ({
  LOG_TAGS: { DATABASE: 'database' },
}));

// Mock DatabaseWriteQueue 使 enqueue 立即 resolve
vi.mock('../DatabaseWriteQueue', () => ({
  DatabaseWriteQueue: {
    getInstance: () => ({
      enqueue: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
    }),
  },
}));

import { DBWriteBatcher } from '../DBWriteBatcher';

describe('DBWriteBatcher', () => {
  let batcher: DBWriteBatcher<{ value: number }>;

  beforeEach(() => {
    vi.useFakeTimers();
    batcher = new DBWriteBatcher<{ value: number }>('test-batcher', 50);
  });

  afterEach(() => {
    batcher.destroy();
    vi.useRealTimers();
  });

  it('buffers entries and flushes them in batch', async () => {
    batcher.enqueue('key1', { value: 1 });
    batcher.enqueue('key2', { value: 2 });
    expect(batcher.bufferedCount).toBe(2);

    const p = batcher.forceFlush();
    await p;
    expect(batcher.bufferedCount).toBe(0);
  });

  it('replaces existing entry with same key by default', () => {
    batcher.enqueue('key', { value: 1 });
    batcher.enqueue('key', { value: 2 });
    expect(batcher.bufferedCount).toBe(1);
  });

  it('uses coalesce function when provided', () => {
    batcher.enqueue('key', { value: 1 }, (existing, incoming) => ({
      value: existing.value + incoming.value,
    }));
    batcher.enqueue('key', { value: 2 }, (existing, incoming) => ({
      value: existing.value + incoming.value,
    }));
    expect(batcher.bufferedCount).toBe(1);
  });

  it('forceFlush clears buffer', async () => {
    batcher.enqueue('k1', { value: 1 });
    batcher.enqueue('k2', { value: 2 });
    expect(batcher.bufferedCount).toBe(2);

    await batcher.forceFlush();
    expect(batcher.bufferedCount).toBe(0);
  });

  it('destroy clears buffer and pending timer', () => {
    batcher.enqueue('k1', { value: 1 });
    batcher.destroy();
    expect(batcher.bufferedCount).toBe(0);
  });

  it('handles empty batch gracefully', async () => {
    await batcher.forceFlush();
    expect(batcher.bufferedCount).toBe(0);
  });
});
