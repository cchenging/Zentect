// Module: editor/shell/hooks/usePipelineOrchestrator
// 原 editor/hooks/usePipelineOrchestrator.ts — 已迁移
// S2: useEditorStore → 各本地 Store

import { useCallback } from 'react';
import { AppNotifier } from '../../../../../renderer/src/core/AppNotifier';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { API } from '../../../../../renderer/src/api';
import { STEP_SEQUENCES } from '../../utils/pipelineConstants';
import { mapPipelineResultToState, type PipelineResultMappers } from '../../../../../renderer/src/pages/editor/hooks/usePipelineResultMapper';
import { editorLogger } from '../../../../../renderer/src/core/logger/EditorLogger';
import { AppError, ErrorCode } from '../../../../infra/error/AppError';
import { useStep1Store } from '../../../../pipeline/stores/useStep1Store';
import { useStep2Store } from '../../../../pipeline/stores/useStep2Store';
import { useStep3Store } from '../../../../pipeline/stores/useStep3Store';
import { useStep4Store } from '../../../../pipeline/stores/useStep4Store';
import { useStep5Store } from '../../../../pipeline/stores/useStep5Store';
import { useProjectStore } from '../../../../editor/stores/useProjectStore';
import { usePipelineStore } from '../../../../../renderer/src/store/usePipelineStore';
import { useEditorNavStore } from '../../../../editor/stores/useEditorNavStore';

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

/** 构建 mapPipelineResultToState 所需的 Setter 桥接对象 */
export const buildMappers = (): PipelineResultMappers => ({
  setAudioSeparated: useStep1Store.getState().setAudioSeparated,
  setAsrLines: useStep1Store.getState().setAsrLines,
  setFrameCount: useStep1Store.getState().setFrameCount,
  setExtractedData: useProjectStore.getState().setExtractedData,
  setVlmFrames: useStep2Store.getState().setVlmFrames,
  setScriptParagraphs: useStep3Store.getState().setScriptParagraphs,
  setTtsResults: useStep4Store.getState().setTtsResults,
  setTtsProgress: useStep4Store.getState().setTtsProgress,
  setMatchResults: useStep5Store.getState().setMatchResults,
  setVideoChunks: useStep5Store.getState().setVideoChunks,
  setBeatTimestamps: useStep5Store.getState().setBeatTimestamps,
});

export const usePipelineOrchestrator = (): PipelineOrchestratorResult => {
  const pipelineStore = usePipelineStore;

  const abortPipeline = useCallback(async () => {
    try { await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_ABORT_PIPELINE); } catch {}
    try { await API.engine.abortPipeline(); } catch {}
    pipelineStore.getState().setPipelineRunning(false);
  }, []);

  const resetAll = useCallback(() => {
    pipelineStore.getState().resetPipeline();
    pipelineStore.getState().resetAllStepStatuses?.();
    AppNotifier.success('前端状态已强制重置！');
  }, []);

  const executeStep = useCallback(async (step: number) => {
    const ps = pipelineStore.getState();
    const projectState = useProjectStore.getState();
    if (!projectState.projectId) return;

    ps.setStepStatus(step, 'running');
    ps.setPipelineRunning(true);
    ps.resetPipeline();
    editorLogger.trackStep(step, 'start', { projectId: projectState.projectId });

    try {
      const activeMedia = projectState.mediaItems?.[0];

      if (step === 2) {
        const existingFrames = projectState.extractedData?.framePaths || [];
        if (existingFrames.length === 0) {
          ps.setStepStatus(step, 'idle');
          ps.setPipelineRunning(false);
          AppNotifier.warning('请先完成步骤1「素材分析」提取关键帧，再执行画面描述');
          return;
        }
        if (!activeMedia?.filePath) {
          throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, '未找到媒体文件路径');
        }
        const result = await API.ai.visionExtract(
          projectState.projectId,
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
              useStep2Store.getState().setVlmFrames(vlmFrames);
            }
          } else if (Array.isArray(vlmData.frames) && vlmData.frames.length > 0) {
            const vlmFrames = vlmData.frames.map((f: any) => ({
              url: typeof f === 'string' ? f : (f.path || f.url || f.thumbnail || ''),
              description: f.description || f.text || '',
              editing: false,
              confirmed: !!(f.description || f.text),
            }));
            if (vlmFrames.length > 0) {
              useStep2Store.getState().setVlmFrames(vlmFrames);
            }
          }
        }
      } else {
        const sequence = STEP_SEQUENCES[step];
        if (!sequence) {
          AppNotifier.error(`步骤 ${step} 未配置管线节点`);
          return;
        }
        const step2State = useStep2Store.getState();
        const step3State = useStep3Store.getState();
        const step4State = useStep4Store.getState();
        const step5State = useStep5Store.getState();

        const enrichedSequence = sequence.map(node => ({
          ...node,
          params: {
            ...(node.params || {}),
            mediaPath: activeMedia?.filePath || '',
            mediaId: activeMedia?.id || '',
            ...(step === 3 ? {
              scriptStyle: step3State.scriptStyle || '赛博现实主义',
              speechRate: step3State.speechRate || 4.5,
              pipelineParams: step3State.pipelineParams || { R: 50, S: 50, T: 50, P: 50 },
              visionResult: {
                sceneDescriptions: step2State.vlmFrames
                  ?.map((f: any) => f.description || '')
                  .filter(Boolean)
                  .join('\n') || '',
              },
            } : {}),
            ...(step === 4 ? {
              ttsEngine: step4State.ttsEngine || 'edge',
              ttsVoiceId: step4State.ttsVoiceId || '',
              voiceId: step4State.ttsVoiceId || '',
              scriptShots: step3State.scriptParagraphs || [],
            } : {}),
            ...(step === 5 ? {
              scriptShots: step3State.scriptParagraphs || [],
              visionResult: {
                sceneDescriptions: step2State.vlmFrames
                  ?.map((f: any) => f.description || '')
                  .filter(Boolean)
                  .join('\n') || '',
                frames: step2State.vlmFrames || [],
              },
              ttsDurations: step4State.ttsResults || [],
              bgmInfo: step5State.activeBgm ? {
                id: step5State.activeBgm.id,
                filePath: step5State.activeBgm.filePath,
              } : null,
            } : {}),
          },
        }));
        const result = await API.engine.runPipeline({
          projectId: projectState.projectId,
          sequence: enrichedSequence,
          sourceMedia: activeMedia?.filePath || '',
        });
        if (result) {
          mapPipelineResultToState(result?.data || result, buildMappers());
        }
      }

      ps.setStepCompleted(step, true);
      ps.setStepStatus(step, 'completed');
      editorLogger.trackStep(step, 'complete');

      const currentProjectState = useProjectStore.getState();
      const step1State = useStep1Store.getState();
      const step2Final = useStep2Store.getState();
      const step3Final = useStep3Store.getState();
      const step4Final = useStep4Store.getState();
      const navState = useEditorNavStore.getState();
      if (currentProjectState.projectId) {
        try {
          await API.project.saveData(currentProjectState.projectId, {
            shots: currentProjectState.shots,
            aiShots: currentProjectState.aiShots,
            roles: currentProjectState.roles,
            mediaItems: currentProjectState.mediaItems,
            asrLines: step1State.asrLines,
            frameCount: step1State.frameCount,
            framePaths: currentProjectState.extractedData?.framePaths || [],
            audioSeparated: step1State.audioSeparated,
            subStepStatuses: ps.subStepStatuses,
            subStepProgresses: ps.subStepProgresses,
            stepStatuses: ps.stepStatuses,
            stepCompleted: ps.stepCompleted,
            currentStep: navState.currentStep,
            extractionConfig: step1State.extractionConfig,
            vlmFrames: step2Final.vlmFrames,
            scriptParagraphs: step3Final.scriptParagraphs,
            scriptStyle: step3Final.scriptStyle,
            speechRate: step3Final.speechRate,
            pipelineParams: step3Final.pipelineParams,
            ttsResults: step4Final.ttsResults,
            ttsEngine: step4Final.ttsEngine,
            ttsVoiceId: step4Final.ttsVoiceId,
          });
        } catch (saveErr) {
          console.error('[管线编排器] 步骤完工落盘失败:', saveErr);
        }
      }

      if (useEditorNavStore.getState().isAutoMode && step < 5) {
        useEditorNavStore.getState().setCurrentStep(step + 1);
        await executeStep(step + 1);
        return;
      }
      ps.setPipelineRunning(false);
    } catch (err: any) {
      ps.setStepStatus(step, 'failed');
      ps.setPipelineError(err?.message || '步骤执行失败');
      ps.setPipelineRunning(false);
    }
  }, []);

  const startCurrentStep = useCallback(async () => {
    const ps = pipelineStore.getState();
    const navState = useEditorNavStore.getState();
    const projectState = useProjectStore.getState();
    const step1State = useStep1Store.getState();
    const currentStep = navState.currentStep;
    const projectId = projectState.projectId;
    const activeMedia = projectState.mediaItems?.[0];

    if (!projectId) return AppNotifier.error('项目未加载');
    if (!activeMedia?.filePath && currentStep === 1) return AppNotifier.error('请先导入视频素材');

    if (currentStep === 1) {
      const config = step1State.extractionConfig;
      const enabledKeys = ['frames', 'audio', 'whisper', 'faces'] as const;
      enabledKeys.forEach(key => {
        if (config[key]?.enabled) ps.setSubStepStatus(key, 'running');
      });
      ps.setStepStatus(1, 'running');
      ps.setPipelineRunning(true);
      ps.setPipelineProgress(0, '准备中');

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
          if (config[key]?.enabled) ps.setSubStepStatus(key, 'idle');
        });
        ps.setStepStatus(1, 'failed');
        ps.setPipelineError(err?.message || '素材提取启动失败');
        ps.setPipelineRunning(false);
      }
      return;
    }

    await executeStep(currentStep);
  }, [executeStep]);

  const triggerQuickPipeline = useCallback(async () => {
    const projectState = useProjectStore.getState();
    if (!projectState.projectId) return AppNotifier.error('项目上下文丢失，无法运行');

    try {
      const ps = pipelineStore.getState();
      ps.setPipelineRunning(true);
      ps.setPipelineProgress(2, '唤醒本地大模型与音轨提取微服务中...');

      await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_RUN_PIPELINE, {
        projectId: projectState.projectId,
        isQuickMode: true,
      });
    } catch (err) {
      AppNotifier.error('IPC 网络网关异常，请重启后端微服务守护进程');
    }
  }, []);

  const executeWithContext = useCallback(async () => {
    const ps = pipelineStore.getState();
    const projectState = useProjectStore.getState();
    const step3State = useStep3Store.getState();
    const { scriptStyle, pipelineParams } = step3State;
    const projectId = projectState.projectId;

    if (ps.pipelineRunning) return AppNotifier.warn('任务正在运行，请先中止！');
    if (!projectId) return AppNotifier.error('项目未加载，请先打开项目');

    try {
      AppNotifier.info('流水线任务已发送，引擎预热中...');
      ps.setPipelineRunning(true);
      ps.setPipelineProgress(1, '核心智能引擎初始化...');

      const response = await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_RUN_PIPELINE, {
        projectId,
        sequence: [],
        context: { scriptStyle, hyperParams: pipelineParams, projectId },
      });

      if (!response?.success) {
        AppNotifier.error(`流水线意外中断: ${response?.error || '未知错误'}`);
        ps.setPipelineError(response?.error || '引擎执行失败');
      }
    } catch (err: any) {
      console.error('执行通信崩溃', err);
      AppNotifier.error('与主进程通信失败！');
      ps.setPipelineError('与主进程通信失败');
    }
  }, []);

  return { executeStep, startCurrentStep, triggerQuickPipeline, executeWithContext, abortPipeline, resetAll };
};
