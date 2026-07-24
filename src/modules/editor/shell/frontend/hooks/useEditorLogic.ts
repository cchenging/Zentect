// Module: editor/shell/hooks/useEditorLogic
// 原 editor/hooks/useEditorLogic.ts — 已迁移

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore, useEditorStore } from '@renderer/store/useStore';
import { usePlayerStore } from '@modules/editor/stores/usePlayerStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';
import { useEditorNavStore } from '@modules/editor/stores/useEditorNavStore';
import { DraftService } from '@renderer/services/DraftService';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';
import { AppNotifier } from '@renderer/core/AppNotifier';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';

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
    usePlayerStore.getState().resetState();
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
    useStep1Store.setState({ subStepProgresses: { frames: 0, audio: 0, whisper: 0, faces: 0 }, extractionConfig: {
      targetLanguage: 'zh-CN',
      frames: { enabled: true, mode: 'VLM_OPTIMIZED' as const, sceneThreshold: 0.28, quality: 3, fps: 2, scale: 1024, minFrameInterval: 4 },
      audio: { enabled: true, engine: 'mdx-net' as const },
      whisper: { enabled: true, engine: 'sensevoice' as const },
      faces: { enabled: true, engine: 'insightface' as const },
    } as any });
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
            usePlayerStore.getState().setActivePlaySource(videoMedia);
          } else {
            const restoredVideoPath = projectSnapshot.videoPath || projectSnapshot.video_path || '';
            if (restoredVideoPath) {
              usePlayerStore.getState().setActivePlaySource({
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

          // 💥 崩溃恢复：检查 IndexedDB 中是否有未同步的 PENDING 草稿
          // 正常关闭流程：SyncDaemon 已将草稿同步至 SQLite 并标记 SYNCED
          // 若仍为 PENDING 说明上次会话异常退出，IndexedDB 中有比 SQLite 更新的数据
          try {
            const crashDraft = await DraftService.getDraft(id);
            if (crashDraft && crashDraft.syncStatus === 'PENDING' && crashDraft.canvasSnapshot) {
              const draftData = JSON.parse(crashDraft.canvasSnapshot);
              console.log('[CrashRecovery] 发现未同步草稿，正在恢复...', Object.keys(draftData));

              // 恢复管线运行时状态 — 仅覆盖 SQLite 中可能过时的字段
              if (draftData.subStepStatuses && typeof draftData.subStepStatuses === 'object') {
                for (const [key, status] of Object.entries(draftData.subStepStatuses)) {
                  usePipelineStore.getState().setSubStepStatus?.(key, status as any);
                }
              }
              if (draftData.stepStatuses) {
                usePipelineStore.setState({ stepStatuses: draftData.stepStatuses });
              }
              if (draftData.stepCompleted) {
                usePipelineStore.setState({ stepCompleted: draftData.stepCompleted });
              }
              if (draftData.frameCount != null) {
                useStep1Store.getState().setFrameCount?.(draftData.frameCount);
              }
              if (draftData.audioSeparated != null) {
                useStep1Store.getState().setAudioSeparated?.(draftData.audioSeparated);
              }

              // 立刻将草稿同步到 SQLite，使其不再是 PENDING 状态
              window.api.ipc.invoke(
                IPC_CHANNELS.PROJECT_SAVE_CANVAS,
                id,
                crashDraft.canvasSnapshot
              ).then(() => DraftService.markAsSynced(id)).catch(() => {});
            }
          } catch (crashErr) {
            console.warn('[CrashRecovery] 草稿恢复失败:', crashErr);
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
  const dirtyRef = useRef(false);

  // 延迟订阅 Store 变更，避开 hydration 阶段的初始化写入
  useEffect(() => {
    if (!id) return;

    let unsubStep1: (() => void) | undefined;
    let unsubProject: (() => void) | undefined;

    const timer = setTimeout(() => {
      unsubStep1 = useStep1Store.subscribe(() => {
        dirtyRef.current = true;
      });
      unsubProject = useProjectStore.subscribe(() => {
        dirtyRef.current = true;
      });
    }, 2000);

    return () => {
      clearTimeout(timer);
      unsubStep1?.();
      unsubProject?.();
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;

    const handleBeforeUnload = () => {
      // 无变更，跳过保存
      if (!dirtyRef.current) return;

      const pipelineState = usePipelineStore.getState();
      // 管线运行中，不保存瞬态执行状态
      if (pipelineState.pipelineRunning) return;

      const projectState = useProjectStore.getState();
      const step1State = useStep1Store.getState();
      const snapshot = {
        shots: projectState.shots,
        aiShots: projectState.aiShots,
        roles: projectState.roles,
        mediaItems: projectState.mediaItems,
        asrLines: step1State.asrLines,
        frameCount: step1State.frameCount,
        audioSeparated: step1State.audioSeparated,
        subStepStatuses: pipelineState.subStepStatuses,
        stepStatuses: pipelineState.stepStatuses,
        stepCompleted: pipelineState.stepCompleted,
        storyboardMode: projectState.storyboardMode,
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
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const DEBOUNCE_MS = 1000;  // 1s 防抖，避免高频写入导致重复 IPC

    const syncDraftsNow = async () => {
      if (isSyncing) {
        // 正在同步中，延迟重试一次
        if (!debounceTimer) {
          debounceTimer = setTimeout(syncDraftsNow, DEBOUNCE_MS);
        }
        return;
      }
      isSyncing = true;
      try {
        const pending = await DraftService.getPendingDrafts();
        if (!pending || pending.length === 0) { isSyncing = false; return; }
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
    };

    // 事件驱动：DraftService 写入后 debounce 触发同步
    const unsubDraft = DraftService.onDraftWritten(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(syncDraftsNow, DEBOUNCE_MS);
    });

    // 兜底：30s 低频轮询（处理事件丢失等异常情况）
    const fallbackInterval = setInterval(syncDraftsNow, 30000);

    // 窗口聚焦时立即同步一次（处理从其他应用切回的场景）
    const onFocus = () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      syncDraftsNow();
    };
    window.addEventListener('focus', onFocus);

    // mount 后立即同步一次
    syncDraftsNow();

    return () => {
      unsubDraft();
      clearInterval(fallbackInterval);
      window.removeEventListener('focus', onFocus);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);
};
