import { localDB, type ProjectDraft } from '../database/localDB';

/**
 * 画布草稿载荷接口
 */
export interface CanvasDraftPayload {
  nodes: any[];
  edges: any[];
  workflowState?: 'idle' | 'processing' | 'finetuning';
}

export class DraftService {
  /**
   * 1. 瞬时保存/更新草稿 (耗时 < 5ms)
   * 彻底取代原本缓慢的 IPC 调用，用于高频状态机备份
   */
  static async saveDraft(projectId: string, canvasSnapshot: string, name?: string, mediaItems?: any[]): Promise<void> {
    try {
      const safeName = typeof name === 'string' ? name : '未命名工作流';
      await localDB.projectDrafts.put({
        projectId,
        canvasSnapshot,
        name: safeName,
        mediaItems: JSON.stringify(mediaItems || []),
        updatedAt: Date.now(),
        syncStatus: 'PENDING'
      });
    } catch (error) {
      console.error('[L2 Cache] 写入瞬时草稿失败:', error);
    }
  }

  /**
   * 💥 新增：无防抖(0-Debounce) L2 状态同步方法
   * 将画布节点和连线数据直接异步击穿到 IndexedDB
   * 用于 Zustand subscribe 监听，实现画布数据的实时持久化
   *
   * @param projectId 项目 ID
   * @param payload 画布数据载荷（包含 nodes 和 edges）
   */
  static async saveCanvasDraft(projectId: string, payload: CanvasDraftPayload): Promise<void> {
    if (!projectId) return;
    try {
      const safePayload = JSON.parse(JSON.stringify(payload));

      const canvasSnapshot = JSON.stringify({
        nodes: safePayload.nodes,
        edges: safePayload.edges,
        workflowState: safePayload.workflowState || 'idle',
        savedAt: Date.now(),
      });

      const existing = await localDB.projectDrafts.get(projectId);

      await localDB.projectDrafts.put({
        projectId,
        canvasSnapshot,
        name: existing?.name || '未命名工作流',
        mediaItems: existing?.mediaItems || '[]',
        updatedAt: Date.now(),
        syncStatus: 'PENDING',
      });
    } catch (error) {
      console.warn('[DraftService] L2 缓存写入失败:', error);
    }
  }

  static async getCanvasDraft(projectId: string): Promise<{ nodes: any[], edges: any[], workflowState?: string } | null> {
    if (!projectId) return null;
    try {
      const draft = await localDB.projectDrafts.get(projectId);
      if (!draft || !draft.canvasSnapshot) return null;

      const parsed = JSON.parse(draft.canvasSnapshot);
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        console.warn(`[DraftService] 发现受损草稿数据，项目 [${projectId}]，跳过加载`);
        return null;
      }

      return { nodes: parsed.nodes, edges: parsed.edges, workflowState: parsed.workflowState };
    } catch (e) {
      console.error('[DraftService] 读取 L2 缓存异常，跳过加载', e);
      return null;
    }
  }

  /**
   * 2. 获取最新的本地草稿 (闪电回载专用)
   */
  static async getDraft(projectId: string): Promise<ProjectDraft | undefined> {
    return await localDB.projectDrafts.get(projectId);
  }

  /**
   * 清理指定项目的草稿
   */
  static async clearDraft(projectId: string): Promise<void> {
    try {
      await localDB.projectDrafts.delete(projectId);
    } catch (e) {
      console.warn('[DraftService] 清理草稿失败:', e);
    }
  }

  /**
   * 🌟 新增：专门用于更新草稿名称的方法
   */
  static async updateDraftName(projectId: string, newName: string): Promise<void> {
    try {
      await localDB.projectDrafts.update(projectId, {
        name: newName,
        updatedAt: Date.now(),
        syncStatus: 'PENDING' // 改名也需要同步给后端
      });
    } catch (e) {
      console.error('[L2 Cache] 更新名称失败', e);
    }
  }

  /**
   * 3. 标记草稿为已同步 (当闲时 IPC 成功写入 SQLite 后调用)
   */
  static async markAsSynced(projectId: string): Promise<void> {
    try {
      await localDB.projectDrafts.update(projectId, {
        syncStatus: 'SYNCED'
      });
    } catch (error) {
      console.warn('[L2 Cache] 状态更新失败:', error);
    }
  }

  /**
   * 4. 获取所有等待同步的草稿 (供闲时后台守护进程轮询使用)
   */
  static async getPendingDrafts(): Promise<ProjectDraft[]> {
    return await localDB.projectDrafts
      .where('syncStatus')
      .equals('PENDING')
      .toArray();
  }

  /**
   * 💥 5. 从草稿中解析媒体资产
   */
  static async getMediaItems(projectId: string): Promise<any[]> {
    const draft = await this.getDraft(projectId);
    if (draft && draft.mediaItems) {
      try {
        return JSON.parse(draft.mediaItems);
      } catch (error) {
        console.error('[L2 Cache] 解析媒体资产失败:', error);
        return [];
      }
    }
    return [];
  }
}
