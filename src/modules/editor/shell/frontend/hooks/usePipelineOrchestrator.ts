// Module: editor/shell/hooks/usePipelineOrchestrator
// 原 editor/hooks/usePipelineOrchestrator.ts — 已迁移

import { useCallback } from 'react';
import { useEditorStore } from '../../../../../renderer/src/store/useStore';
import { AppNotifier } from '../../../../../renderer/src/core/AppNotifier';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { API } from '../../../../../renderer/src/api';
import { STEP_SEQUENCES } from '../../utils/pipelineConstants';
import { mapPipelineResultToState } from '../../../../../renderer/src/pages/editor/hooks/usePipelineResultMapper';
import { editorLogger } from '../../../../../renderer/src/core/logger/EditorLogger';
import { AppError, ErrorCode } from '../../../../../infra/error/AppError';

const DENSITY_MAP: Record<string, { fps: number }> = {
  sparse: { fps: 1 },
  standard: { fps: 2 },
  dense: { fps: 5 },
};

export enum PipelineMode {
  STEP = 'step',
  QUICK = 'quick',
  EXTRACTION = 'extraction',
}

interface PipelineOrchestratorResult {
  executeStep: (step: number) => Promise<void>;
  startCurrentStep: () => Promise<void>;
  triggerQuickPipeline: () => Promise<void>;
  executeWithContext: () => Promise<void>;
  abortPipeline: () => Promise<void>;
  resetAll: () => void;
}

export const usePipelineOrchestrator = (): PipelineOrchestratorResult => {
  const store = useEditorStore();

  const abortPipeline = useCallback(async () => {
    try { await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_ABORT_PIPELINE); } catch {}
    try { await API.engine.abortPipeline(); } catch {}
    store.setPipelineRunning(false);
  }, []);

  const resetAll = useCallback(() => {
    store.resetPipeline();
    store.resetAllStepStatuses?.();
    AppNotifier.success('前端状态已强制重置！');
  }, []);

  const executeStep = useCallback(async (step: number) => {
    const state = useEditorStore.getState();
    if (!state.projectId) return;

    state.setStepStatus(step, 'running');
    state.setPipelineRunning(true);
    state.resetPipeline();
    editorLogger.trackStep(step, 'start', { projectId: state.projectId });

    try {
      const activeMedia = state.mediaItems?.[0];

      if (step === 2) {
        const existingFrames = state.extractedData?.framePaths || [];
        if (existingFrames.length === 0) {
          state.setStepStatus(step, 'idle');
          state.setPipelineRunning(false);
          AppNotifier.warning('请先完成步骤1「素材分析」提取关键帧，再执行画面描述');
          return;
        }
        if (!activeMedia?.filePath) {
          throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, '未找到媒体文件路径');
        }
        const result = await API.ai.visionExtract(
          state.projectId,
          activeMedia.filePath,
          activeMedia.id || '',
          existingFrames,
        );
        if (result) {
          const vlmData = result as any;
          if (vlmData.sceneDescriptions || vlmData.framePaths) {
            const descriptions = vlmData.sceneDescriptions
              ? vlmData.sceneDescriptions.split('\n').filter((s: string) => s.trim())
              : [];
            const framePaths: string[] = vlmData.framePaths || [];
            const vlmFrames = framePaths.map((url: string, i: number) => ({
              url,
              description: descriptions[i] || '',
              editing: false,
              confirmed: !!(descriptions[i] && descriptions[i].trim()),
            }));
            if (vlmFrames.length > 0) {
              state.setVlmFrames(vlmFrames);
            }
          } else if (Array.isArray(vlmData.frames) && vlmData.frames.length > 0) {
            const vlmFrames = vlmData.frames.map((f: any) => ({
              url: typeof f === 'string' ? f : (f.path || f.url || f.thumbnail || ''),
              description: f.description || f.text || '',
              editing: false,
              confirmed: !!(f.description || f.text),
            }));
            if (vlmFrames.length > 0) {
              state.setVlmFrames(vlmFrames);
            }
          }
        }
      } else {
        const sequence = STEP_SEQUENCES[step];
        if (!sequence) {
          AppNotifier.error(`步骤 ${step} 未配置管线节点`);
          return;
        }
        const enrichedSequence = sequence.map(node => ({
          ...node,
          params: {
            ...(node.params || {}),
            mediaPath: activeMedia?.filePath || '',
            mediaId: activeMedia?.id || '',
            ...(step === 3 ? {
              scriptStyle: state.scriptStyle || '赛博现实主义',
              speechRate: state.speechRate || 4.5,
              pipelineParams: state.pipelineParams || { R: 50, S: 50, T: 50, P: 50 },
              visionResult: {
                sceneDescriptions: state.vlmFrames
                  ?.map((f: any) => f.description || '')
                  .filter(Boolean)
                  .join('\n') || '',
              },
            } : {}),
            ...(step === 4 ? {
              ttsEngine: state.ttsEngine || 'edge',
              ttsVoiceId: state.ttsVoiceId || '',
              voiceId: state.ttsVoiceId || '',
              scriptShots: state.scriptParagraphs || [],
            } : {}),
            ...(step === 5 ? {
              scriptShots: state.scriptParagraphs || [],
              visionResult: {
                sceneDescriptions: state.vlmFrames
                  ?.map((f: any) => f.description || '')
                  .filter(Boolean)
                  .join('\n') || '',
                frames: state.vlmFrames || [],
              },
              ttsDurations: state.ttsResults || [],
              bgmInfo: state.activeBgm ? {
                id: state.activeBgm.id,
                filePath: state.activeBgm.filePath,
              } : null,
            } : {}),
          },
        }));
        const result = await API.engine.runPipeline({
          projectId: state.projectId,
          sequence: enrichedSequence,
          sourceMedia: activeMedia?.filePath || '',
        });
        if (result) {
          mapPipelineResultToState(result?.data || result, useEditorStore.getState());
        }
      }

      state.setStepCompleted(step, true);
      state.setStepStatus(step, 'completed');
      editorLogger.trackStep(step, 'complete');

      const currentState = useEditorStore.getState();
      if (currentState.projectId) {
        try {
          await API.project.saveData(currentState.projectId, {
            shots: currentState.shots,
            aiShots: currentState.aiShots,
            roles: currentState.roles,
            mediaItems: currentState.mediaItems,
            asrLines: currentState.asrLines,
            frameCount: currentState.frameCount,
            framePaths: currentState.extractedData?.framePaths || [],
            audioSeparated: currentState.audioSeparated,
            subStepStatuses: currentState.subStepStatuses,
            subStepProgresses: currentState.subStepProgresses,
            stepStatuses: currentState.stepStatuses,
            stepCompleted: currentState.stepCompleted,
            currentStep: currentState.currentStep,
            extractionConfig: currentState.extractionConfig,
            vlmFrames: currentState.vlmFrames,
            scriptParagraphs: currentState.scriptParagraphs,
            scriptStyle: currentState.scriptStyle,
            speechRate: currentState.speechRate,
            pipelineParams: currentState.pipelineParams,
            ttsResults: currentState.ttsResults,
            ttsEngine: currentState.ttsEngine,
            ttsVoiceId: currentState.ttsVoiceId,
          });
        } catch (saveErr) {
          console.error('[管线编排器] 步骤完工落盘失败:', saveErr);
        }
      }

      if (useEditorStore.getState().isAutoMode && step < 5) {
        useEditorStore.getState().setCurrentStep(step + 1);
        await executeStep(step + 1);
        return;
      }
      state.setPipelineRunning(false);
    } catch (err: any) {
      state.setStepStatus(step, 'failed');
      state.setPipelineError(err?.message || '步骤执行失败');
      state.setPipelineRunning(false);
    }
  }, []);

  const startCurrentStep = useCallback(async () => {
    const state = useEditorStore.getState();
    const currentStep = state.currentStep;
    const projectId = state.projectId;
    const activeMedia = state.mediaItems?.[0];

    if (!projectId) return AppNotifier.error('项目未加载');
    if (!activeMedia?.filePath && currentStep === 1) return AppNotifier.error('请先导入视频素材');

    if (currentStep === 1) {
      const config = state.extractionConfig;
      const enabledKeys = ['frames', 'audio', 'whisper', 'faces'] as const;
      enabledKeys.forEach(key => {
        if (config[key]?.enabled) state.setSubStepStatus(key, 'running');
      });
      state.setStepStatus(1, 'running');
      state.setPipelineRunning(true);
      state.setPipelineProgress(0, '准备中');

      try {
        await API.media.process(projectId, activeMedia, {
          targetLanguage: config.targetLanguage || 'zh-CN',
          frames: config.frames.enabled ? {
            enabled: true,
            mode: config.frames.mode,
            sceneThreshold: config.frames.value || 0.28,
            minFrameInterval: config.frames.minFrameInterval ?? 4,
            fps: DENSITY_MAP[config.frames.density || 'standard']?.fps || 2,
            scale: config.frames.scale ?? 1024,
            quality: config.frames.quality ?? 3,
          } : { enabled: false },
          audio: config.audio,
          whisper: config.whisper,
          faces: config.faces,
        });
        AppNotifier.info('素材提取任务已加入队列');
      } catch (err: any) {
        enabledKeys.forEach(key => {
          if (config[key]?.enabled) state.setSubStepStatus(key, 'idle');
        });
        state.setStepStatus(1, 'failed');
        state.setPipelineError(err?.message || '素材提取启动失败');
        state.setPipelineRunning(false);
      }
      return;
    }

    await executeStep(currentStep);
  }, [executeStep]);

  const triggerQuickPipeline = useCallback(async () => {
    const state = useEditorStore.getState();
    if (!state.projectId) return AppNotifier.error('项目上下文丢失，无法运行');

    try {
      state.setPipelineRunning(true);
      state.setPipelineProgress(2, '唤醒本地大模型与音轨提取微服务中...');

      await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_RUN_PIPELINE, {
        projectId: state.projectId,
        isQuickMode: true,
      });
    } catch (err) {
      AppNotifier.error('IPC 网络网关异常，请重启后端微服务守护进程');
    }
  }, []);

  const executeWithContext = useCallback(async () => {
    const state = useEditorStore.getState();
    const { projectId, scriptStyle, pipelineParams } = state;

    if (state.pipelineRunning) return AppNotifier.warn('任务正在运行，请先中止！');
    if (!projectId) return AppNotifier.error('项目未加载，请先打开项目');

    try {
      AppNotifier.info('流水线任务已发送，引擎预热中...');
      state.setPipelineRunning(true);
      state.setPipelineProgress(1, '核心智能引擎初始化...');

      const response = await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_RUN_PIPELINE, {
        projectId,
        sequence: [],
        context: { scriptStyle, hyperParams: pipelineParams, projectId },
      });

      if (!response?.success) {
        AppNotifier.error(`流水线意外中断: ${response?.error || '未知错误'}`);
        state.setPipelineError(response?.error || '引擎执行失败');
      }
    } catch (err: any) {
      console.error('执行通信崩溃', err);
      AppNotifier.error('与主进程通信失败！');
      state.setPipelineError('与主进程通信失败');
    }
  }, []);

  return { executeStep, startCurrentStep, triggerQuickPipeline, executeWithContext, abortPipeline, resetAll };
};
