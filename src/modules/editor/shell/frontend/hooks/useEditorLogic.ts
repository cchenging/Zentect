// Module: editor/shell/hooks/useEditorLogic
// 原 editor/hooks/useEditorLogic.ts — 已迁移

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore, useEditorStore } from '../../../../../renderer/src/store/useStore';
import { useStep1Store } from '../../../../pipeline/stores/useStep1Store';
import { usePipelineStore } from '../../../../../renderer/src/store/usePipelineStore';
import { useProjectStore } from '../../../../editor/stores/useProjectStore';
import { useStep2Store } from '../../../../pipeline/stores/useStep2Store';
import { useStep3Store } from '../../../../pipeline/stores/useStep3Store';
import { useStep4Store } from '../../../../pipeline/stores/useStep4Store';
import { useStep5Store } from '../../../../pipeline/stores/useStep5Store';
import { useEditorNavStore } from '../../../../editor/stores/useEditorNavStore';
import { DraftService } from '../../../../../renderer/src/services/DraftService';
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
    const projectStore = useProjectStore.getState();

    projectStore.resetProjectState();
    // 逐个重置局部 Store
    useProjectStore.getState().resetProjectState?.();
    usePipelineStore.getState().resetAllStepStatuses?.();
    usePipelineStore.setState({ stepCompleted: [false, false, false, false, false] });
    usePipelineStore.getState().setPipelineRunning?.(false);
    usePipelineStore.getState().setPipelineProgress?.(0, '');
    usePipelineStore.getState().setPipelineError?.(null);
    usePipelineStore.getState().setExtractionConfig?.(null);
    useStep1Store.getState().setAsrLines?.([]);
    useStep1Store.getState().setFrameCount?.(0);
    useStep1Store.getState().setAudioSeparated?.(false);
    useStep1Store.getState().setSubStepStatus?.('frames', 'idle');
    useStep1Store.getState().setSubStepStatus?.('audio', 'idle');
    useStep1Store.getState().setSubStepStatus?.('whisper', 'idle');
    useStep1Store.getState().setSubStepStatus?.('faces', 'idle');
    useStep1Store.setState({ subStepProgresses: {} as Record<string, number>, extractionConfig: null as any });
    useStep2Store.getState().setVlmFrames?.([]);
    useStep3Store.getState().setScriptParagraphs?.([]);
    useStep3Store.getState().setScriptStyle?.('赛博现实主义');
    useStep3Store.getState().setSpeechRate?.(4.5);
    useStep3Store.getState().setPipelineParams?.({ R: 70, S: 50, T: 80, P: 60 });
    useStep4Store.getState().setTtsEngine?.('edge');
    useStep4Store.getState().setTtsVoiceId?.('');
    useStep4Store.getState().setTtsProgress?.(0);
    useStep4Store.getState().setTtsResults?.([]);
    useStep5Store.getState().setMatchResults?.([]);
    useStep5Store.getState().setActiveBgm?.(null);
    useStep5Store.getState().setBeatTimestamps?.([]);
    useStep5Store.getState().setVideoChunks?.([]);
    useEditorNavStore.getState().setCurrentStep?.(1);
    useEditorNavStore.getState().setIsAutoMode?.(false);

    const initWorkspace = async () => {
      useStore.getState().setHydrationStatus?.('LOADING');
      try {
        const projectRes = await window.api.ipc.invoke(IPC_CHANNELS.PROJECT_GET_BY_ID, id);
        const currentProject = projectRes?.data || projectRes;
        if (!currentProject) throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `在底座数据库中未识别到工程: ${id}`);

        if (isMounted) {
          projectStore.setProjectMeta(currentProject.id, currentProject.name);
        }

        const loadRes = await window.api.ipc.invoke(IPC_CHANNELS.PROJECT_LOAD_DATA, id);
        const projectSnapshot = loadRes?.data || loadRes;

        console.log('====== [HYDRO项目进场大快照] ======', projectSnapshot);

        if (projectSnapshot && isMounted) {
          projectStore.hydrateProjectData(projectSnapshot);

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
      const projectState = useProjectStore.getState();
      const step1State = useStep1Store.getState();
      const pipelineState = usePipelineStore.getState();
      const snapshot = {
        shots: projectState.shots,
        aiShots: projectState.aiShots,
        roles: projectState.roles,
        mediaItems: projectState.mediaItems,
        asrLines: step1State.asrLines,
        frameCount: step1State.frameCount,
        audioSeparated: step1State.audioSeparated,
        subStepStatuses: pipelineState.subStepStatuses,
        subStepProgresses: pipelineState.subStepProgresses,
        stepStatuses: pipelineState.stepStatuses,
        stepCompleted: pipelineState.stepCompleted,
        storyboardMode: projectState.storyboardMode
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
