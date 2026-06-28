import { useCallback } from 'react';
import { useEditorStore } from '../../../store/useStore';
import { AppNotifier } from '../../../core/AppNotifier';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { API } from '../../../api';
import { STEP_SEQUENCES } from '../utils/pipelineConstants';
import { mapPipelineResultToState } from './usePipelineResultMapper';
import { editorLogger } from '../../../core/logger/EditorLogger';

/** 抽帧密度到 fps 的映射 */
const DENSITY_MAP: Record<string, { fps: number }> = {
  sparse: { fps: 1 },
  standard: { fps: 2 },
  dense: { fps: 5 },
};

/** 管线执行模式枚举 */
export enum PipelineMode {
  /** 步骤模式：按步骤编号执行特定节点序列 */
  STEP = 'step',
  /** 快速模式：一次性执行完整线性管线 */
  QUICK = 'quick',
  /** 素材提取模式：步骤1的媒体处理 */
  EXTRACTION = 'extraction',
}

/** 统一管线编排器 Hook 的返回值 */
interface PipelineOrchestratorResult {
  /** 执行指定步骤的管线（步骤2-5） */
  executeStep: (step: number) => Promise<void>;
  /** 启动当前步骤（自动判断是步骤1还是后续步骤） */
  startCurrentStep: () => Promise<void>;
  /** 触发快速线性管线 */
  triggerQuickPipeline: () => Promise<void>;
  /** 触发带上下文的完整管线（TopBar 使用） */
  executeWithContext: () => Promise<void>;
  /** 中止管线 */
  abortPipeline: () => Promise<void>;
  /** 重置所有管线状态 */
  resetAll: () => void;
}

/**
 * 统一管线编排器 Hook
 * 合并 handleRunStep / triggerLinearPipeline / handleExecutePipeline 为单一入口
 * 消除三处分散的管线执行逻辑，统一错误处理和状态管理
 */
export const usePipelineOrchestrator = (): PipelineOrchestratorResult => {
  const store = useEditorStore();

  /** 通用管线中止方法 */
  const abortPipeline = useCallback(async () => {
    try { await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_ABORT_PIPELINE); } catch {}
    try { await API.engine.abortPipeline(); } catch {}
    store.setPipelineRunning(false);
  }, []);

  /** 重置所有管线状态 */
  const resetAll = useCallback(() => {
    store.resetPipeline();
    store.resetAllStepStatuses?.();
    AppNotifier.success('前端状态已强制重置！');
  }, []);

  /** 通过 API.engine.runPipeline 执行指定步骤（步骤2-5） */
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
        /** 步骤2：画面描述 — 复用步骤1已提取的帧，直接 VLM 分析 */
        const existingFrames = state.extractedData?.framePaths || [];
        if (existingFrames.length === 0) {
          state.setStepStatus(step, 'idle');
          state.setPipelineRunning(false);
          AppNotifier.warning('请先完成步骤1「素材分析」提取关键帧，再执行画面描述');
          return;
        }
        if (!activeMedia?.filePath) {
          throw new Error('未找到媒体文件路径');
        }
        const result = await API.ai.visionExtract(
          state.projectId,
          activeMedia.filePath,
          activeMedia.id || '',
          existingFrames,
        );
        /** 将 VLM 结果映射到 store */
        if (result) {
          const vlmData = result as any;
          /** 兼容两种返回格式：sceneDescriptions 字符串 或 frames 对象数组 */
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
        /** 步骤3-5：走 PipelineEngine */
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
            /** 步骤3：注入用户选择的文案风格、语速控制、R/S/T/P 创作参数 和 VLM 画面描述 */
            ...(step === 3 ? {
              scriptStyle: state.scriptStyle || '赛博现实主义',
              speechRate: state.speechRate || 4.5,
              pipelineParams: state.pipelineParams || { R: 50, S: 50, T: 50, P: 50 },
              /** 将步骤2的 VLM 画面描述注入，提供上下文给脚本生成 */
              visionResult: {
                sceneDescriptions: state.vlmFrames
                  ?.map((f: any) => f.description || '')
                  .filter(Boolean)
                  .join('\n') || '',
              },
            } : {}),
            /** 步骤4：注入用户选择的 TTS 引擎 + 音色 + 前置剧本文本 */
            ...(step === 4 ? {
              ttsEngine: state.ttsEngine || 'edge',
            ttsVoiceId: state.ttsVoiceId || '',
              voiceId: state.ttsVoiceId || '',
              /** 将步骤3的解说文案注入，供 TTSStrategy 逐段合成 */
              scriptShots: state.scriptParagraphs || [],
            } : {}),
            /** 步骤5：注入解说文案 + VLM 画面描述 + TTS刚性时长 + BGM信息，供三维一体匹配使用 */
            ...(step === 5 ? {
              scriptShots: state.scriptParagraphs || [],
              visionResult: {
                sceneDescriptions: state.vlmFrames
                  ?.map((f: any) => f.description || '')
                  .filter(Boolean)
                  .join('\n') || '',
                frames: state.vlmFrames || [],
              },
              /** 注入步骤4的 TTS 配音刚性时长，供时长约束匹配 */
              ttsDurations: state.ttsResults || [],
              /** 注入背景音乐信息，供 BGM 卡点匹配 */
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

      /** 完工落盘：将步骤结果持久化到 SQLite，防止重进项目丢失 */
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
            /** 持久化步骤3解说文案和步骤4配音结果，确保重进项目不丢失 */
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

      /** 自动模式下推进到下一步，递归前重新检查 isAutoMode */
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

  /** 启动当前步骤（自动判断步骤类型） */
  const startCurrentStep = useCallback(async () => {
    const state = useEditorStore.getState();
    const currentStep = state.currentStep;
    const projectId = state.projectId;
    const activeMedia = state.mediaItems?.[0];

    if (!projectId) return AppNotifier.error('项目未加载');
    if (!activeMedia?.filePath && currentStep === 1) return AppNotifier.error('请先导入视频素材');

    // 步骤1：素材提取走 media.process
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

    // 步骤2-5：走引擎管线
    await executeStep(currentStep);
  }, [executeStep]);

  /** 触发快速线性管线（参考.html 版本的触发方式） */
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

  /** 带上下文执行完整管线（TopBar 使用） */
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
