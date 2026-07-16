/**
 * useMediaUpdatedListener
 * 监听主进程推送的 media:updated IPC 事件，同步更新 editor store 中对应 mediaItem 的 metadata。
 *
 * 主进程 notifyFrontend 推送的数据结构：
 *   { projectId: string, mediaId: string, coverPath?: string, duration?: string, status?: string, filePath?: string }
 */
import { useEffect } from 'react';
import { usePlayerStore } from '../../../../editor/stores/usePlayerStore';
import { useProjectStore } from '../../../../editor/stores/useProjectStore';

interface MediaUpdatedPayload {
  projectId: string;
  mediaId: string;
  coverPath?: string;
  duration?: string;
  status?: string;
  filePath?: string;
}

export function useMediaUpdatedListener() {
  useEffect(() => {
    const handler = (_event: any, payload: MediaUpdatedPayload) => {
      if (!payload || !payload.mediaId) return;

      const { mediaId, projectId: _projectId, ...updates } = payload;
      const projectStore = useProjectStore.getState();

      // 只更新有实际值的字段，避免覆盖已有字段为 undefined
      const filtered: Record<string, any> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined && value !== null) {
          filtered[key] = value;
        }
      }

      if (Object.keys(filtered).length > 0) {
        projectStore.updateMediaItem(mediaId, filtered);

        // 如果更新的 mediaId 恰好等于 activePlaySource.id，同步更新 activePlaySource
        const currentSource = usePlayerStore.getState().activePlaySource;
        if (currentSource && (currentSource as any).id === mediaId) {
          usePlayerStore.getState().setActivePlaySource({ ...currentSource, ...filtered } as any);
        }
      }
    };

    if (window.api?.ipc?.on) {
      window.api.ipc.on('media:updated', handler);
    }

    return () => {
      // 清理监听器，避免内存泄漏
      if (window.api?.ipc?.removeListener) {
        window.api.ipc.removeListener('media:updated', handler);
      }
    };
  }, []);
}
