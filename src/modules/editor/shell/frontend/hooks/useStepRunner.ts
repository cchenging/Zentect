// Module: editor/shell/hooks/useStepRunner
// 原 editor/hooks/useStepRunner.ts — 已迁移

import { useCallback } from 'react';
import { useStore } from '@renderer/store/useStore';
import { usePlayerStore } from '@modules/editor/stores/usePlayerStore';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { useEditorNavStore } from '@modules/editor/stores/useEditorNavStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { API } from '@renderer/api';
import { usePipelineOrchestrator } from './usePipelineOrchestrator';

interface StepRunnerResult {
  handleRunStep: (step: number) => Promise<void>;
  handleStart: () => Promise<void>;
  handleNextStep: () => void;
  handleAbortPipeline: () => Promise<void>;
  handleVideoImport: () => Promise<void>;
  /** 替换视频：先删旧视频及其衍生数据，再导入新视频 */
  handleReplaceVideo: () => Promise<void>;
}

export const useStepRunner = (projectId: string | undefined): StepRunnerResult => {
  const currentStep = useEditorNavStore((s) => s.currentStep);
  const setCurrentStep = useEditorNavStore((s) => s.setCurrentStep);
  const addMediaItems = useProjectStore((s) => s.addMediaItems);
  const setActivePlaySource = usePlayerStore((s) => s.setActivePlaySource);

  const { executeStep, startCurrentStep, abortPipeline } = usePipelineOrchestrator();

  const handleRunStep = useCallback(async (step: number) => {
    await executeStep(step);
  }, [executeStep]);

  const handleStart = useCallback(async () => {
    await startCurrentStep();
  }, [startCurrentStep]);

  const handleNextStep = useCallback(() => {
    if (currentStep < 5) {
      setCurrentStep(currentStep + 1);
    }
  }, [currentStep, setCurrentStep]);

  const handleAbortPipeline = useCallback(async () => {
    await abortPipeline();
  }, [abortPipeline]);

  const handleVideoImport = useCallback(async () => {
    if (!projectId) return;
    try {
      const filePaths: string[] = await API.system.openMediaDialog();
      if (filePaths && filePaths.length > 0) {
        const newItems = await API.media.import(projectId, filePaths);
        if (Array.isArray(newItems) && newItems.length > 0) {
          usePlayerStore.setState({ currentTime: 0, isPlaying: false });
          addMediaItems(newItems);
          setActivePlaySource(newItems[0]);
          useStore.setState({ selectedItemId: newItems[0].id, selectedItemType: 'media' });
        }
      }
    } catch (err: any) {
      console.error('[Editor] 视频导入失败:', err);
    }
  }, [projectId, setActivePlaySource, addMediaItems]);

  /**
   * 替换视频：先删除旧视频及其所有衍生数据，再导入新视频
   * 清理范围：DB 记录、mediaItems、shots/roles、extractedData、step1 store、pipeline 状态
   * 用于"重新导入/替换媒体"入口
   */
  const handleReplaceVideo = useCallback(async () => {
    if (!projectId) return;
    try {
      const filePaths: string[] = await API.system.openMediaDialog();
      if (!filePaths || filePaths.length === 0) return;

      // 1. 删除旧视频及其衍生数据
      const projectState = useProjectStore.getState();
      const oldVideo = projectState.mediaItems.find((m: any) => m.type === 'video');

      if (oldVideo) {
        // 删 DB 记录（含衍生文件由后端清理）
        try { await API.media.delete(projectId, oldVideo.id); }
        catch (e) { console.error('[replace] 删除旧视频 DB 失败:', e); }

        // 清 useProjectStore：过滤掉旧视频及关联的音频/镜头/角色/提取数据
        useProjectStore.setState((s) => ({
          mediaItems: s.mediaItems.filter((m) =>
            m.id !== oldVideo.id && m.mediaId !== oldVideo.id
          ),
          shots: s.shots.filter((shot) => shot.mediaId !== oldVideo.id),
          aiShots: s.aiShots.filter((shot) => shot.mediaId !== oldVideo.id),
          roles: s.roles.filter((role) => !role.id.startsWith(oldVideo.id)),
          extractedData: { framePaths: [], frameCount: 0 },
        }));

        // 清 useStep1Store：ASR/帧数/分离标记全部归零
        const s1 = useStep1Store.getState();
        s1.setAsrLines([]);
        s1.setFrameCount(0);
        s1.setAudioSeparated(false);
        s1.setVocalsIsFallback(false);

        // 清 usePipelineStore：重置步骤1状态
        const ps = usePipelineStore.getState();
        ps.resetAllStepStatuses();
        ps.setStepCompleted(1, false);

        // 重置播放器
        usePlayerStore.setState({ currentTime: 0, isPlaying: false, activePlaySource: null });
      }

      // 2. 导入新视频
      const newItems = await API.media.import(projectId, filePaths);
      if (Array.isArray(newItems) && newItems.length > 0) {
        usePlayerStore.setState({ currentTime: 0, isPlaying: false });
        addMediaItems(newItems);
        setActivePlaySource(newItems[0]);
        useStore.setState({ selectedItemId: newItems[0].id, selectedItemType: 'media' });
      }
    } catch (err: any) {
      console.error('[Editor] 替换视频失败:', err);
    }
  }, [projectId, setActivePlaySource, addMediaItems]);

  return { handleRunStep, handleStart, handleNextStep, handleAbortPipeline, handleVideoImport, handleReplaceVideo };
};
