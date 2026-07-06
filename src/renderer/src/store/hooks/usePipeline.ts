/**
 * usePipeline — 统一管线执行 Hook
 * 合并 usePipelineOrchestrator + useStepRunner 的职责
 * 组件只需调用 usePipeline() 即可获得所有管线能力
 */
import { useCallback } from 'react';
import { useStore } from '../../../store/useStore';
import { usePipelineStore } from '../../../store/usePipelineStore';
import { API } from '../../../api';
import { AppNotifier } from '../../../core/AppNotifier';
import { editorLogger } from '../../../core/logger/EditorLogger';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { STEP_SEQUENCES } from '../utils/pipelineConstants';
import { mapPipelineResultToState } from './usePipelineResultMapper';

const DENSITY_MAP: Record<string, { fps: number }> = {
  sparse: { fps: 1 }, standard: { fps: 2 }, dense: { fps: 5 },
};

export function usePipeline(projectId?: string) {
  const store = useStore();
  const pipelineStore = usePipelineStore();

  const abortPipeline = useCallback(async () => {
    try { await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_ABORT_PIPELINE); } catch {}
    try { await API.engine.abortPipeline(); } catch {}
    pipelineStore.setPipelineRunning(false);
  }, [pipelineStore]);

  const resetAll = useCallback(() => {
    pipelineStore.resetPipeline();
    pipelineStore.resetAllStepStatuses();
    AppNotifier.success('管线状态已重置');
  }, [pipelineStore]);

  const executeStep = useCallback(async (step: number) => {
    const state = useStore.getState();
    const pState = usePipelineStore.getState();
    if (!state.projectId) return;

    pState.setStepStatus(step, 'running');
    pState.setPipelineRunning(true);
    pState.resetPipeline();
    editorLogger.trackStep(step, 'start', { projectId: state.projectId });

    try {
      const activeMedia = state.mediaItems?.[0];

      // 步骤2 前置检查：需要关键帧
      if (step === 2) {
        const existingFrames = state.extractedData?.framePaths || [];
        if (existingFrames.length === 0) {
          pState.setStepStatus(step, 'idle');
          pState.setPipelineRunning(false);
          AppNotifier.warning('请先完成步骤1（素材分析），提取关键帧后再执行画面描述');
          return;
        }
      }

      const sequence = STEP_SEQUENCES[step];
      if (!sequence) { AppNotifier.error(`步骤 ${step} 未配置管线节点`); return; }
      const enrichedSequence = sequence.map(node => ({
        ...node,
        params: {
          ...(node.params || {}),
          mediaPath: activeMedia?.filePath || '',
          mediaId: activeMedia?.id || '',
          ...(step === 2 ? {
            framePaths: state.extractedData?.framePaths || [],
            projectId: state.projectId,
          } : {}),
          ...(step === 3 ? {
            scriptStyle: state.scriptStyle || '叙事', speechRate: state.speechRate || 4.5,
            pipelineParams: pState.pipelineParams,
            visionResult: { sceneDescriptions: state.vlmFrames?.map((f: any) => f.description || '').filter(Boolean).join('\n') || '' },
          } : {}),
          ...(step === 4 ? { ttsEngine: state.ttsEngine || 'edge', voiceId: state.ttsVoiceId || '', scriptShots: state.scriptParagraphs || [] } : {}),
          ...(step === 5 ? {
            scriptShots: state.scriptParagraphs || [],
            visionResult: { sceneDescriptions: state.vlmFrames?.map((f: any) => f.description || '').filter(Boolean).join('\n') || '', frames: state.vlmFrames || [] },
            ttsDurations: state.ttsResults || [], bgmInfo: state.activeBgm ? { id: state.activeBgm.id, filePath: state.activeBgm.filePath } : null,
          } : {}),
        },
      }));
      const result = await API.engine.runPipeline({ projectId: state.projectId, sequence: enrichedSequence, sourceMedia: activeMedia?.filePath || '' });
      if (result) mapPipelineResultToState(result?.data || result, useStore.getState());

      pState.setStepCompleted(step, true);
      pState.setStepStatus(step, 'completed');
      editorLogger.trackStep(step, 'complete');

      // 持久化
      const curState = useStore.getState();
      if (curState.projectId) {
        try { await API.project.saveData(curState.projectId, {
          shots: curState.shots, aiShots: curState.aiShots, roles: curState.roles,
          mediaItems: curState.mediaItems, asrLines: curState.asrLines, frameCount: curState.frameCount,
          framePaths: curState.extractedData?.framePaths || [], audioSeparated: curState.audioSeparated,
          stepStatuses: pState.stepStatuses, stepCompleted: pState.stepCompleted,
          scriptParagraphs: curState.scriptParagraphs, scriptStyle: curState.scriptStyle,
          speechRate: curState.speechRate, pipelineParams: pState.pipelineParams,
          ttsResults: curState.ttsResults, ttsEngine: curState.ttsEngine, ttsVoiceId: curState.ttsVoiceId,
        }); } catch (e) { console.error('[usePipeline] save failed', e); }
      }

      // 自动模式递归
      if (useStore.getState().isAutoMode && step < 5) {
        useStore.getState().setCurrentStep(step + 1);
        await executeStep(step + 1);
        return;
      }
      pState.setPipelineRunning(false);
    } catch (err: any) {
      pState.setStepStatus(step, 'failed');
      editorLogger.trackStep(step, 'fail', { error: err?.message });
      pState.setPipelineError(err?.message || '管线执行失败');
      pState.setPipelineRunning(false);
    }
  }, []);

  const startCurrentStep = useCallback(async () => {
    const state = useStore.getState();
    const pState = usePipelineStore.getState();
    const currentStep = state.currentStep;
    if (!state.projectId) return AppNotifier.error('项目未加载');
    const activeMedia = state.mediaItems?.[0];
    if (!activeMedia?.filePath && currentStep === 1) return AppNotifier.error('请先导入视频素材');

    if (currentStep === 1) {
      const config = state.extractionConfig;
      pState.setStepStatus(1, 'running');
      pState.setPipelineRunning(true);
      pState.setPipelineProgress(0, '准备中');
      try {
        await API.media.process(state.projectId, activeMedia, {
          targetLanguage: config?.targetLanguage || 'zh-CN',
          frames: config?.frames?.enabled ? { enabled: true, mode: config.frames.mode, sceneThreshold: config.frames.value || 0.28, minFrameInterval: config.frames.minFrameInterval ?? 4, fps: DENSITY_MAP[config?.frames?.density || 'standard']?.fps || 2, scale: config?.frames?.scale ?? 1024, quality: config?.frames?.quality ?? 3 } : { enabled: false },
          audio: config?.audio || { enabled: false }, whisper: config?.whisper || { enabled: false }, faces: config?.faces || { enabled: false },
        });
        AppNotifier.info('素材分析任务已提交');
      } catch (err: any) {
        pState.setStepStatus(1, 'failed');
        pState.setPipelineError(err?.message || '素材分析失败');
        pState.setPipelineRunning(false);
      }
      return;
    }
    await executeStep(currentStep);
  }, [executeStep]);

  const handleVideoImport = useCallback(async () => {
    if (!projectId) return;
    try {
      const filePaths: string[] = await API.system.openMediaDialog();
      if (filePaths?.length > 0) {
        const newItems = await API.media.import(projectId, filePaths);
        if (Array.isArray(newItems) && newItems.length > 0) {
          useStore.getState().addMediaItems(newItems);
          useStore.getState().setActivePlaySource(newItems[0]);
        }
      }
    } catch (err) { console.error('[usePipeline] import failed', err); }
  }, [projectId]);

  return {
    executeStep, startCurrentStep, abortPipeline, resetAll, handleVideoImport,
    isRunning: pipelineStore.pipelineRunning,
    progress: pipelineStore.pipelineProgress,
    progressText: pipelineStore.pipelineNode,
    error: pipelineStore.pipelineError,
  };
}