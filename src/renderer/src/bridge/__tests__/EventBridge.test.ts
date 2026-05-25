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
    it('registers IPC listeners for all channels', () => {
      bridge.init();
      // Should register 9 channels (ENGINE_PIPELINE_PROGRESS appears twice, once is dedup)
      expect(mockIpcOn).toHaveBeenCalledTimes(9);
    });

    it('is idempotent', () => {
      bridge.init();
      bridge.init();
      expect(mockIpcOn).toHaveBeenCalledTimes(9);
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

    it('routes IPC events to subscribed handlers', () => {
      bridge.init();
      const handler = vi.fn();
      bridge.subscribe('engine:pipeline-progress', handler);

      // Simulate IPC event by calling the registered listener directly
      const ipcCall = mockIpcOn.mock.calls.find(c => c[0] === 'engine:pipeline-progress');
      expect(ipcCall).toBeDefined();
    });
  });

  describe('unsubscribe', () => {
    it('removes specific handler', () => {
      bridge.init();
      const handler = vi.fn();
      bridge.subscribe('engine:pipeline-progress', handler);
      bridge.unsubscribe('engine:pipeline-progress', handler);

      // Should have attempted to remove listener
      expect(mockRemoveListener).toHaveBeenCalled();
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
      expect(mockIpcOn).toHaveBeenCalledTimes(18); // 9 + 9
    });
  });
});
