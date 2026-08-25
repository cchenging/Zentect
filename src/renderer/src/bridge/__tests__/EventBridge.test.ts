import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIpcOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockRemoveAllListeners = vi.fn();

vi.mock('../../../shared/utils/IpcConstants', () => ({
  IPC_CHANNELS: {
    ENGINE_PIPELINE_PROGRESS: 'engine:pipeline-progress',
    EVENT_TASK_PROGRESS: 'task:progress',
    EVENT_TASK_COMPLETED: 'task:completed',
    EVENT_APP_NOTIFY: 'app:notify',
    EVENT_EXTRACTION_SUCCESS: 'event:extraction-success',
    EVENT_MEDIA_UPDATED: 'event:media-updated',
    EVENT_NODE_STATE_CHANGE: 'event:node-state-change',
    ENGINE_REQUIRE_USER_ACTION: 'engine:require-user-action',
  },
}));

// Mock window.api before importing EventBridge
vi.stubGlobal('window', {
  api: {
    ipc: {
      on: mockIpcOn,
      removeListener: mockRemoveListener,
      removeAllListeners: mockRemoveAllListeners,
    },
  },
});

import { EventBridge } from '../EventBridge';

describe('EventBridge', () => {
  let bridge: EventBridge;

  beforeEach(() => {
    EventBridge['instance'] = undefined as any;
    vi.clearAllMocks();
    bridge = EventBridge.getInstance();
  });

  afterEach(() => {
    bridge.destroy();
  });

  it('is a singleton', () => {
    const b2 = EventBridge.getInstance();
    expect(b2).toBe(bridge);
  });

  describe('init', () => {
    it('registers IPC listeners for all unique channels', () => {
      bridge.init();
      // 💥 去重修复：init 中 ENGINE_PIPELINE_PROGRESS 出现两次（L31 & L39），
      //    旧实现重复绑定 ipc.on，新版本 channel() 按 Set 去重，实际仅 8 个唯一 channel
      expect(mockIpcOn).toHaveBeenCalledTimes(8);
    });

    it('is idempotent', () => {
      bridge.init();
      bridge.init();
      expect(mockIpcOn).toHaveBeenCalledTimes(8);
    });

    it('does not crash when window.api is unavailable', () => {
      vi.stubGlobal('window', undefined);
      const b = EventBridge.getInstance();
      expect(() => b.init()).not.toThrow();
      vi.stubGlobal('window', {
        api: { ipc: { on: mockIpcOn, removeListener: mockRemoveListener, removeAllListeners: mockRemoveAllListeners } },
      });
    });
  });

  describe('subscribe', () => {
    it('registers handler and returns unsubscribe function', () => {
      bridge.init();
      const handler = vi.fn();
      const unsubscribe = bridge.subscribe('engine:pipeline-progress', handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('routes IPC events to subscribed handlers exactly once (防重复核心验证)', () => {
      bridge.init();
      const handler = vi.fn();
      bridge.subscribe('engine:pipeline-progress', handler);

      // 💥 回归验证：找到所有注册到同一 channel 的底层 IPC 监听器，逐个触发
      //    修复前 subscribe + channel 各自独立绑定 ipc.on → 同一事件被处理 2 次
      //    修复后只复用 channel 的统一分发器 → 严格 1 次
      const ipcCalls = mockIpcOn.mock.calls.filter((c: any[]) => c[0] === 'engine:pipeline-progress');
      expect(ipcCalls.length).toBe(1); // 同一 channel 只能有一个底层 IPC 监听器

      const rawHandler = ipcCalls[0][1] as Function;
      rawHandler({}, { progress: 42 }); // 模拟一次 IPC 事件到达
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ progress: 42 }); // 已正确剥离 _event 参数
    });

    it('multiple subscribers on same channel all receive event once each', () => {
      bridge.init();
      const h1 = vi.fn();
      const h2 = vi.fn();
      bridge.subscribe('task:progress', h1);
      bridge.subscribe('task:progress', h2);

      const ipcCall = mockIpcOn.mock.calls.find((c: any[]) => c[0] === 'task:progress');
      expect(ipcCall).toBeDefined();
      (ipcCall![1] as Function)({}, { percent: 99 });

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });
  });

  describe('unsubscribe', () => {
    it('removes specific handler', () => {
      bridge.init();
      const handler = vi.fn();
      bridge.subscribe('engine:pipeline-progress', handler);
      bridge.unsubscribe('engine:pipeline-progress', handler);

      // 💥 修复同步：subscribe 不再自绑定独立 ipc.on，所以 unsubscribe 不会再
      //    调用 removeListener（只从分发集合中剔除）。通过分发触发一次验证 handler 不再被执行。
      const ipcCall = mockIpcOn.mock.calls.find((c: any[]) => c[0] === 'engine:pipeline-progress');
      expect(ipcCall).toBeDefined();
      const rawHandler = ipcCall![1] as Function;
      rawHandler({}, 'payload1'); // 触发分发器
      expect(handler).not.toHaveBeenCalled(); // handler 已移除，不应被调用
    });
  });

  describe('removeAllForChannel', () => {
    it('removes all listeners for a channel', () => {
      bridge.init();
      bridge.removeAllForChannel('engine:pipeline-progress');
      expect(mockRemoveAllListeners).toHaveBeenCalledWith('engine:pipeline-progress');
    });
  });

  describe('destroy', () => {
    it('clears all IPC listeners', () => {
      bridge.init();
      bridge.destroy();
      expect(mockRemoveAllListeners).toHaveBeenCalled();
    });

    it('allows reinit after destroy', () => {
      bridge.init();
      bridge.destroy();
      bridge.init();
      expect(mockIpcOn).toHaveBeenCalledTimes(16); // 8 + 8 (去重后的唯一 channel 数量)
    });
  });
});
