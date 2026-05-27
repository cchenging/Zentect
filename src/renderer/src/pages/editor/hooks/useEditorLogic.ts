// 📁 src/renderer/src/pages/editor/hooks/useEditorLogic.ts
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore, useEditorStore } from '../../../store/useStore';
import { DraftService } from '../../../services/DraftService';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { AppNotifier } from '../../../core/AppNotifier';
import { API } from '../../../api';

export const useEditorHydration = (id: string | undefined) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) {
      navigate('/');
      return;
    }

    let isMounted = true;
    const store = useEditorStore.getState();
    store.resetProjectState();

    const init = async () => {
      useStore.getState().setHydrationStatus('LOADING');
      try {
        const projectRes = await window.api.ipc.invoke(IPC_CHANNELS.PROJECT_GET_BY_ID, id);
        const currentProject = projectRes?.data || projectRes;
        if (!currentProject) throw new Error(`在数据库中未找到 ID 为 [${id}] 的项目`);

        if (isMounted) {
          store.setProjectMeta(currentProject.id, currentProject.name);
          useEditorStore.setState({ projectPath: currentProject.path });
        }

        // 加载媒体资产列表
        if (isMounted) {
          try {
            const loadedMedia = await API.media.getByProject(id);
            if (Array.isArray(loadedMedia) && loadedMedia.length > 0) {
              useEditorStore.getState().setMediaItems(loadedMedia);
              const firstVideo = loadedMedia.find((m: any) => m.type === 'video');
              if (firstVideo) {
                useEditorStore.getState().setActivePlaySource(firstVideo);
              }
            }
          } catch (e) {
            console.warn('[Hydration] 加载媒体资产失败，不影响画布启动:', e);
          }
        }

        if (isMounted) useStore.getState().setHydrationStatus('READY');
      } catch (error) {
        console.error('[Editor Hydration Error]:', error);
        if (isMounted) {
          AppNotifier.error('项目数据加载异常，已安全重置');
          useStore.getState().setHydrationStatus('ERROR');
        }
      }
    };

    init();

    return () => {
      isMounted = false;
    };
  }, [id, navigate]);
};

export const useEditorAutoSave = (id: string | undefined) => {
  useEffect(() => {
    if (!id) return;

    const handleBeforeUnload = () => {
      DraftService.saveDraft(id, JSON.stringify({})).catch(() => {});
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [id]);
};

export const useSyncDaemon = () => {
  useEffect(() => {
    if (!window.api?.ipc?.invoke) return;
    let isSyncing = false;

    const daemon = setInterval(async () => {
      if (isSyncing) return;
      isSyncing = true;
      try {
        const pending = await DraftService.getPendingDrafts();
        for (const draft of pending) {
          await window.api.ipc.invoke(
            IPC_CHANNELS.PROJECT_SAVE_CANVAS,
            draft.projectId,
            draft.canvasSnapshot
          );
          await DraftService.markAsSynced(draft.projectId);
        }
      } catch (err) {
        console.warn('[SyncDaemon] 同步异常:', err);
      } finally {
        isSyncing = false;
      }
    }, 5000);

    return () => clearInterval(daemon);
  }, []);
};
