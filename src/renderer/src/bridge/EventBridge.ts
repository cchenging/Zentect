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

  /**
   * 注册 channel 级统一分发器。
   * 仅当 channel 首次被访问时调用一次 window.api.ipc.on，
   * 后续所有 subscribe 都复用这一条底层 IPC 监听，避免重复绑定导致事件被处理 N 次。
   */
  private channel(channel: string): void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    } else {
      // 💥 关键去重：同一 channel 只要 Set 存在，说明之前已调用过 ipc.on，绝不再重复绑定
      return;
    }

    /**
     * 统一分发器：
     * 底层 IPC 回调签名为 (_event, ...payload) → 剥离 _event，将纯 payload 转发给所有订阅者 handler
     * 与 EventBridge.subscribe 约定的 handler(...args) 保持一致（已剥掉 electron event 对象）
     */
    const rawHandler = (_event: any, ...args: any[]) => {
      const entries = this.subscriptions.get(channel);
      if (!entries) return;
      entries.forEach(entry => {
        try { entry.handler(...args); } catch { /* 吞掉订阅者异常，避免某个 handler 异常导致后续订阅者收不到消息 */ }
      });
    };

    window.api.ipc.on(channel, rawHandler);
  }

  subscribe(channel: string, handler: IpcHandler): () => void {
    if (typeof window !== 'undefined' && window.api) {
      // 💥 核心修复：确保 channel 级统一分发器已绑定
      //    旧实现 channel() 和 subscribe() 各自独立调用 window.api.ipc.on，
      //    导致每个 IPC 事件被处理两次 → 所有 Toast/回调 重复触发两次。
      //    现在 subscribe 只负责登记 entry，统一由 channel() 的 rawHandler 分发。
      if (!this.subscriptions.has(channel)) {
        this.channel(channel);
      }
    } else if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }

    // channel() 分发器内部会自动剥离首个 _event 参数，此处 rawHandler 保持一致签名
    const rawHandler = (_event: any, ...args: any[]) => handler(...args);

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
        // 💥 修复同步：subscribe 不再自绑定独立的 ipc.on，
        //    所以 entry.rawHandler 不是底层 IPC 注册的回调，不能再 removeListener。
        //    现在移除订阅者 = 只从分发 Set 中剔除；底层 IPC 监听器只在 destroy/removeAllForChannel 时移除。
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
