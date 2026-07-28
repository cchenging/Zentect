// 路径: src/main/engine/__tests__/PythonClient.test.ts
// PythonClient 单元测试
// 覆盖：单例模式、getPort 就绪等待、call 同步调用、callAsync 异步流程

import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mock 依赖（vi.hoisted 避免 hoisting 冲突） ===
const { mockIsOnline, mockWaitForReady, mockGetPort, mockHttpPost, mockSubscribe } = vi.hoisted(() => ({
  mockIsOnline: vi.fn(),
  mockWaitForReady: vi.fn(),
  mockGetPort: vi.fn(),
  mockHttpPost: vi.fn(),
  mockSubscribe: vi.fn(),
}));

vi.mock('../../core/AIDaemon', () => ({
  AIDaemon: {
    getInstance: vi.fn().mockReturnValue({
      isOnline: mockIsOnline,
      waitForReady: mockWaitForReady,
      getPort: mockGetPort,
    }),
  },
}));

vi.mock('../../core/HttpClient', () => ({
  HttpClient: vi.fn(function(this: any, opts?: any) {
    this.post = mockHttpPost;
    this.timeoutMs = opts?.timeoutMs || 90000;
  }),
}));

vi.mock('../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { MEDIA_ENGINE: 'media-engine' },
}));

vi.mock('../media/PythonProgressSubscriber', () => ({
  PythonProgressSubscriber: {
    subscribe: mockSubscribe,
  },
}));

import { PythonClient } from '../PythonClient';

describe('PythonClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置单例
    (PythonClient as any).instance = undefined;
    mockIsOnline.mockReturnValue(true);
    mockGetPort.mockReturnValue(8765);
    mockWaitForReady.mockResolvedValue(undefined);
    mockHttpPost.mockResolvedValue({ success: true, data: {} });
    mockSubscribe.mockResolvedValue({ done: true, result: { success: true } });
  });

  // ══════════════════════════════════════════
  // 单例
  // ══════════════════════════════════════════

  it('是单例模式', () => {
    const c1 = PythonClient.getInstance();
    const c2 = PythonClient.getInstance();
    expect(c1).toBe(c2);
  });

  // ══════════════════════════════════════════
  // call 同步调用
  // ══════════════════════════════════════════

  it('call 构建正确 URL 并调用 HttpClient.post', async () => {
    const client = PythonClient.getInstance();
    await client.call('/api/vision', { image: 'test.jpg' });

    expect(mockHttpPost).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/vision',
      { image: 'test.jpg' },
      { signal: undefined }
    );
  });

  it('call 路径不以 / 开头时自动补全', async () => {
    const client = PythonClient.getInstance();
    await client.call('api/vision', {});

    expect(mockHttpPost).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/vision',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('call 传递 AbortSignal', async () => {
    const controller = new AbortController();
    const client = PythonClient.getInstance();
    await client.call('/api/vision', {}, controller.signal);

    expect(mockHttpPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      { signal: controller.signal }
    );
  });

  it('call 失败时抛出异常', async () => {
    mockHttpPost.mockRejectedValue(new Error('Connection refused'));
    const client = PythonClient.getInstance();
    await expect(client.call('/api/vision', {})).rejects.toThrow('Connection refused');
  });

  it('daemon 离线时等待就绪后再获取端口', async () => {
    mockIsOnline.mockReturnValue(false);
    const client = PythonClient.getInstance();
    await client.call('/api/vision', {});
    expect(mockWaitForReady).toHaveBeenCalled();
    expect(mockGetPort).toHaveBeenCalled();
  });

  // ══════════════════════════════════════════
  // callAsync 异步调用
  // ══════════════════════════════════════════

  it('callAsync POST 触发任务后订阅 SSE 流', async () => {
    const client = PythonClient.getInstance();
    const onProgress = vi.fn();

    const result = await client.callAsync(
      '/api/separate',
      { audio_path: '/test.wav' },
      onProgress,
      { timeoutMs: 120000, streamPath: '/api/separate/stream/' }
    );

    // POST 触发
    expect(mockHttpPost).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/separate',
      expect.objectContaining({ audio_path: '/test.wav', task_id: expect.any(String) }),
      expect.objectContaining({ signal: undefined })
    );

    // SSE 订阅
    expect(mockSubscribe).toHaveBeenCalledWith(
      expect.any(String),
      onProgress,
      120000,
      undefined,
      '/api/separate/stream/'
    );

    expect(result.done).toBe(true);
  });

  it('callAsync POST 触发失败时返回错误', async () => {
    mockHttpPost.mockResolvedValue({ success: false });
    const client = PythonClient.getInstance();
    const result = await client.callAsync('/api/separate', {}, vi.fn());
    expect(result.done).toBe(true);
    expect(result.error).toBeDefined();
  });

  it('callAsync POST 抛出异常时返回错误', async () => {
    mockHttpPost.mockRejectedValue(new Error('Network error'));
    const client = PythonClient.getInstance();
    const result = await client.callAsync('/api/separate', {}, vi.fn());
    expect(result.done).toBe(true);
    expect(result.error).toContain('Network error');
  });

  it('callAsync 默认 streamPath 为 path + /stream/', async () => {
    const client = PythonClient.getInstance();
    await client.callAsync('/api/transcribe', { audio_path: '/t.wav' }, vi.fn(), { timeoutMs: 60000 });

    expect(mockSubscribe).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      60000,
      undefined,
      '/api/transcribe/stream/'
    );
  });

  it('callAsync 传递 AbortSignal', async () => {
    const controller = new AbortController();
    const client = PythonClient.getInstance();
    await client.callAsync('/api/separate', {}, vi.fn(), { signal: controller.signal });

    // POST 时传递 signal
    expect(mockHttpPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal })
    );

    // SSE 订阅时传递 signal
    expect(mockSubscribe).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.any(Number),
      controller.signal,
      expect.any(String)
    );
  });
});