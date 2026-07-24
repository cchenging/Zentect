import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';

type IpcHandler = (...args: any[]) => void;

interface SubscriptionEntry {
  channel: string;
  handler: IpcHandler;
  rawHandler: (...args: any[]) => void;
}

export class EventBridge {
  private static instance: EventBridge;
  private subscriptions = new Map<string, Set<SubscriptionEntry>>();
  private initialized = false;

  private constructor() {}

  static getInstance(): EventBridge {
    if (!EventBridge.instance) {
      EventBridge.instance = new EventBridge();
    }
    return EventBridge.instance;
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (typeof window === 'undefined' || !window.api) return;

    this.channel(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS);
    this.channel(IPC_CHANNELS.EVENT_TASK_PROGRESS);
    this.channel(IPC_CHANNELS.EVENT_TASK_COMPLETED);
    this.channel(IPC_CHANNELS.EVENT_APP_NOTIFY);
    this.channel(IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS);
    this.channel(IPC_CHANNELS.EVENT_MEDIA_UPDATED);
    this.channel(IPC_CHANNELS.EVENT_NODE_STATE_CHANGE);
    this.channel(IPC_CHANNELS.ENGINE_REQUIRE_USER_ACTION);
    this.channel(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS);
  }

  private channel(channel: string): void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }

    const rawHandler = (...args: any[]) => {
      const entries = this.subscriptions.get(channel);
      if (!entries) return;
      entries.forEach(entry => {
        try { entry.handler(...args); } catch { /* 吞掉订阅者异常 */ }
      });
    };

    window.api.ipc.on(channel, rawHandler);
  }

  subscribe(channel: string, handler: IpcHandler): () => void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }

    const rawHandler = (_event: any, ...args: any[]) => handler(...args);

    window.api.ipc.on(channel, rawHandler);

    const entry: SubscriptionEntry = { channel, handler, rawHandler };
    this.subscriptions.get(channel)!.add(entry);

    return () => this.unsubscribe(channel, handler);
  }

  unsubscribe(channel: string, handler: IpcHandler): void {
    const entries = this.subscriptions.get(channel);
    if (!entries) return;

    for (const entry of entries) {
      if (entry.handler === handler) {
        entries.delete(entry);
        if (typeof window.api.ipc.removeListener === 'function') {
          window.api.ipc.removeListener(channel, entry.rawHandler);
        }
        break;
      }
    }
  }

  removeAllForChannel(channel: string): void {
    window.api.ipc.removeAllListeners(channel);
    this.subscriptions.delete(channel);
  }

  destroy(): void {
    for (const channel of this.subscriptions.keys()) {
      window.api.ipc.removeAllListeners(channel);
    }
    this.subscriptions.clear();
    this.initialized = false;
  }
}
