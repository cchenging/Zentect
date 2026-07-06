/**
 * @deprecated 已迁移至 src/modules/editor/shell/frontend/hooks/useEditorLogic.ts
 * 请使用 import { useEditorHydration, useEditorAutoSave, useSyncDaemon } from '@/modules/editor/shell'
 */

// 📁 路径: src/renderer/src/pages/editor/hooks/useEditorLogic.ts
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore, useEditorStore } from '../../../store/useStore';
import { DraftService } from '../../../services/DraftService';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { AppNotifier } from '../../../core/AppNotifier';

export const useEditorHydration = (id: string | undefined) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) {
      navigate('/');
      return;
    }

    let isMounted = true;
    const store = useEditorStore.getState();

    // 进场前，第一毫秒清空内存残留，防止串工程污染
    store.resetProjectState();

    const initWorkspace = async () => {
      useStore.getState().setHydrationStatus?.('LOADING');
      try {
        // 1. 获取工程核心物理基本元数据
        const projectRes = await window.api.ipc.invoke(IPC_CHANNELS.PROJECT_GET_BY_ID, id);
        const currentProject = projectRes?.data || projectRes;
        if (!currentProject) throw new Error(`在底座数据库中未识别到工程: ${id}`);

        if (isMounted) {
          store.setProjectMeta(currentProject.id, currentProject.name);
        }

        // 2. 强拉持久化数据库，调取基于主表 metadata 的最新真实工程快照
        const loadRes = await window.api.ipc.invoke(IPC_CHANNELS.PROJECT_LOAD_DATA, id);
        const projectSnapshot = loadRes?.data || loadRes;

        console.log('====== [HYDRO项目进场大快照] ======', projectSnapshot);

        if (projectSnapshot && isMounted) {
          // 自愈清洗大闸：强推反序列化拉流，拒绝被 undefined 幽灵冲刷前台
          store.hydrateProjectData(projectSnapshot);

          // 💥 激活播放器源：优先使用 mediaItems 中的视频，其次回退到 projects.video_path
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

          // 💥 同步反解元数据列中的 ASR 数组，让左下方资产面板（TextPool）瞬间复活！
          if (projectSnapshot.metadata) {
            try {
              const meta = typeof projectSnapshot.metadata === 'string'
                ? JSON.parse(projectSnapshot.metadata)
                : projectSnapshot.metadata;
              if (meta.asrLines) store.setAsrLines?.(meta.asrLines);
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

/** 页面卸载前自动保存项目快照到草稿服务 */
export const useEditorAutoSave = (id: string | undefined) => {
  useEffect(() => {
    if (!id) return;

    const handleBeforeUnload = () => {
      const storeState = useEditorStore.getState();
      const snapshot = {
        shots: storeState.shots,
        aiShots: storeState.aiShots,
        roles: storeState.roles,
        mediaItems: storeState.mediaItems,
        asrLines: storeState.asrLines,
        frameCount: storeState.frameCount,
        audioSeparated: storeState.audioSeparated,
        subStepStatuses: storeState.subStepStatuses,
        subStepProgresses: storeState.subStepProgresses,
        stepStatuses: storeState.stepStatuses,
        stepCompleted: storeState.stepCompleted,
        storyboardMode: storeState.storyboardMode
      };
      DraftService.saveDraft(id, JSON.stringify(snapshot)).catch(() => {});
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [id]);
};

/** 定时将本地草稿同步到主进程 */
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
