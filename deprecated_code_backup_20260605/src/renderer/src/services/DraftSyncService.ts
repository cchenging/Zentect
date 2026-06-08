// 📁 路径：src/renderer/src/services/DraftSyncService.ts
// 画布节点系统已移除，移除 nodes/edges 订阅，仅保留 L2→L3 定期同步守护
import { DraftService } from './DraftService';

/**
 * 草稿同步服务
 * 画布节点系统已移除，仅保留 L2→L3 定期同步守护
 */
export class DraftSyncService {
  private static instance: DraftSyncService;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs = 500;
  private unsubscribe: (() => void) | null = null;
  /** L2→L3 定期同步定时器 */
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  /** 同步间隔：30 秒 */
  private readonly syncIntervalMs = 30000;

  private constructor() {}

  /** 获取单例实例 */
  static getInstance(): DraftSyncService {
    if (!DraftSyncService.instance) {
      DraftSyncService.instance = new DraftSyncService();
    }
    return DraftSyncService.instance;
  }

  /**
   * 启动同步服务
   * 画布节点系统已移除，仅保留 L2→L3 定期同步守护
   */
  start(): void {
    if (this.unsubscribe) return;

    // 画布节点系统已移除，不再订阅 nodes/edges 变更
    // 标记为已启动，防止重复调用
    this.unsubscribe = () => {};

    // 启动 L2→L3 定期同步守护
    this.startPeriodicSync();
  }

  /** 停止同步服务 */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.unsubscribe !== null;
  }

  /**
   * 启动 L2(IndexedDB) → L3(SQLite) 定期同步守护
   * 每 30 秒将 PENDING 状态的草稿推送到主进程持久化
   */
  private startPeriodicSync(): void {
    if (this.syncInterval) return;
    this.syncInterval = setInterval(() => {
      this.syncPendingDraftsToMain().catch((err) => {
        console.warn('[DraftSyncService] L2→L3 同步失败:', err);
      });
    }, this.syncIntervalMs);
  }

  /**
   * 将 IndexedDB 中 PENDING 状态的草稿同步到主进程 SQLite
   */
  public async syncPendingDraftsToMain(): Promise<void> {
    const pending = await DraftService.getPendingDrafts();
    if (pending.length === 0) return;

    for (const draft of pending) {
      try {
        await window.api.ipc.invoke('draft:sync-to-main', {
          projectId: draft.projectId,
          draftJson: draft.canvasSnapshot,
        });
        await DraftService.markAsSynced(draft.projectId);
      } catch (error) {
        // 同步失败不阻塞，下次继续尝试
        console.warn(`[DraftSyncService] 草稿同步失败: ${draft.projectId}`, error);
      }
    }
  }
}
