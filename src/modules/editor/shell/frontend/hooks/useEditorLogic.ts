// Module: editor/shell/hooks/useEditorLogic
// 原 editor/hooks/useEditorLogic.ts — 已迁移

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore, useEditorStore } from '../../../../../renderer/src/store/useStore';
import { useStep1Store } from '../../../../pipeline/stores/useStep1Store';
import { usePipelineStore } from '../../../../../renderer/src/store/usePipelineStore';
import { DraftService } from '../../../../../renderer/src/services/DraftService';
import { resetAllLocalStores, syncHydratedStateToStores } from '../../../../../renderer/src/pages/editor/hooks/syncHydrate';
import { IPC_CHANNELS } from '../../../../infra/ipc/IpcConstants';
import { AppNotifier } from '../../../../../renderer/src/core/AppNotifier';
import { AppError, ErrorCode } from '../../../../infra/error/AppError';

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
    resetAllLocalStores();

    const initWorkspace = async () => {
      useStore.getState().setHydrationStatus?.('LOADING');
      try {
        const projectRes = await window.api.ipc.invoke(IPC_CHANNELS.PROJECT_GET_BY_ID, id);
        const currentProject = projectRes?.data || projectRes;
        if (!currentProject) throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `在底座数据库中未识别到工程: ${id}`);

        if (isMounted) {
          store.setProjectMeta(currentProject.id, currentProject.name);
        }

        const loadRes = await window.api.ipc.invoke(IPC_CHANNELS.PROJECT_LOAD_DATA, id);
        const projectSnapshot = loadRes?.data || loadRes;

        console.log('====== [HYDRO项目进场大快照] ======', projectSnapshot);

        if (projectSnapshot && isMounted) {
          store.hydrateProjectData(projectSnapshot);
          syncHydratedStateToStores(projectSnapshot);

          const mediaItems = projectSnapshot.mediaItems || [];
          const videoMedia = mediaItems.find((m: any) => m.type === 'video' || m.filePath);
          if (videoMedia) {
            store.setActivePlaySource?.(videoMedia);
          } else {
            const restoredVideoPath = projectSnapshot.videoPath || projectSnapshot.video_path || '';
            if (restoredVideoPath) {
              store.setActivePlaySource?.({
                id: 'main-video-source',
                name: '原始导入多媒体文件',
                filePath: restoredVideoPath,
                path: restoredVideoPath,
                type: 'video'
              });
            }
          }

          if (projectSnapshot.metadata) {
            try {
              const meta = typeof projectSnapshot.metadata === 'string'
                ? JSON.parse(projectSnapshot.metadata)
                : projectSnapshot.metadata;
              if (meta.asrLines) useStep1Store.getState().setAsrLines(meta.asrLines);
            } catch {}
          }

          console.log(`[工作台自愈水合大胜利] 🛠️ 全量本地资产已完美水合归位！mediaItems=${mediaItems.length}`);
        }

        if (isMounted) useStore.getState().setHydrationStatus?.('READY');
      } catch (error: any) {
        console.error('[左右工作区水合异常]:', error);
        if (isMounted) {
          AppNotifier.error(`项目数据恢复失败: ${error.message || '未知'}`);
          useStore.getState().setHydrationStatus?.('ERROR');
        }
      }
    };

    initWorkspace();

    return () => {
      isMounted = false;
    };
  }, [id, navigate]);
};

export const useEditorAutoSave = (id: string | undefined) => {
  useEffect(() => {
    if (!id) return;

    const handleBeforeUnload = () => {
      const storeState = useEditorStore.getState();
      const step1State = useStep1Store.getState();
      const pipelineState = usePipelineStore.getState();
      const snapshot = {
        shots: storeState.shots,
        aiShots: storeState.aiShots,
        roles: storeState.roles,
        mediaItems: storeState.mediaItems,
        asrLines: step1State.asrLines,
        frameCount: step1State.frameCount,
        audioSeparated: step1State.audioSeparated,
        subStepStatuses: storeState.subStepStatuses,
        subStepProgresses: storeState.subStepProgresses,
        stepStatuses: pipelineState.stepStatuses,
        stepCompleted: pipelineState.stepCompleted,
        storyboardMode: storeState.storyboardMode
      };
      DraftService.saveDraft(id, JSON.stringify(snapshot)).catch(() => {});
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
