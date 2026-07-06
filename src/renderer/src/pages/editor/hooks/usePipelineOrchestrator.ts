/**
 * @deprecated 已迁移至 src/modules/editor/shell/frontend/hooks/usePipelineOrchestrator.ts
 * 请使用 import { usePipelineOrchestrator, PipelineMode } from '@/modules/editor/shell'
 *
 * 阶段四迁移：useEditorStore → 各独立 Store（useStep1Store ~ useStep5Store + useProjectStore + usePipelineStore + useEditorNavStore）
 */

import { useCallback } from 'react';
import { AppNotifier } from '../../../core/AppNotifier';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { API } from '../../../api';
import { STEP_SEQUENCES } from '../utils/pipelineConstants';
import { mapPipelineResultToState, type PipelineResultMappers } from './usePipelineResultMapper';
import { editorLogger } from '../../../core/logger/EditorLogger';
import { useStep1Store } from '../../../../../modules/pipeline/stores/useStep1Store';
import { useStep2Store } from '../../../../../modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '../../../../../modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '../../../../../modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '../../../../../modules/pipeline/stores/useStep5Store';
import { useProjectStore } from '../../../../../modules/editor/stores/useProjectStore';
import { usePipelineStore } from '../../../store/usePipelineStore';
import { useEditorNavStore } from '../../../../../modules/editor/stores/useEditorNavStore';

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

/**
 * 统一管线编排器 Hook
 * 合并 handleRunStep / triggerLinearPipeline / handleExecutePipeline 为单一入口
 * 消除三处分散的管线执行逻辑，统一错误处理和状态管理
 *
 * 阶段四：从 useEditorStore 迁移到各独立 Store getState()
 */
export const usePipelineOrchestrator = (): PipelineOrchestratorResult => {
  const pipelineStore = usePipelineStore;

  /** 通用管线中止方法 */
  const abortPipeline = useCallback(async () => {
    try { await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_ABORT_PIPELINE); } catch {}
    try { await API.engine.abortPipeline(); } catch {}
    pipelineStore.getState().setPipelineRunning(false);
  }, []);

  /** 重置所有管线状态 */
  const resetAll = useCallback(() => {
    pipelineStore.getState().resetPipeline();
    pipelineStore.getState().resetAllStepStatuses();
    AppNotifier.success('前端状态已强制重置！');
  }, []);

  /** 通过 API.engine.runPipeline 执行指定步骤（步骤2-5） */
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

      // 步骤2 前置检查：需要步骤1的关键帧
      if (step === 2) {
        const existingFrames = projectState.extractedData?.framePaths || [];
        if (existingFrames.length === 0) {
          ps.setStepStatus(step, 'idle');
          ps.setPipelineRunning(false);
          AppNotifier.warning('请先完成步骤1「素材分析」提取关键帧，再执行画面描述');
          return;
        }
      }

      /** 所有步骤统一走 PipelineEngine */
      const sequence = STEP_SEQUENCES[step];
      if (!sequence) {
        AppNotifier.error(`步骤 ${step} 未配置管线节点`);
        return;
      }
      const enrichedSequence = sequence.map(node => {
        // 按需读取各步骤状态
        const step2State = step === 2 || step === 3 || step === 5 ? useStep2Store.getState() : null;
        const step3State = step === 3 || step === 4 || step === 5 ? useStep3Store.getState() : null;
        const step4State = step === 4 || step === 5 ? useStep4Store.getState() : null;
        const step5State = step === 5 ? useStep5Store.getState() : null;

        return {
        ...node,
        params: {
          ...(node.params || {}),
          mediaPath: activeMedia?.filePath || '',
          mediaId: activeMedia?.id || '',
          /** 步骤2：注入步骤1提取的关键帧路径 */
          ...(step === 2 ? {
            framePaths: projectState.extractedData?.framePaths || [],
            projectId: projectState.projectId,
          } : {}),
          /** 步骤3：注入用户选择的文案风格、语速控制、R/S/T/P 创作参数 和 VLM 画面描述 */
          ...(step === 3 ? {
            scriptStyle: step3State?.scriptStyle || '赛博现实主义',
            speechRate: step3State?.speechRate || 4.5,
            pipelineParams: step3State?.pipelineParams || { R: 50, S: 50, T: 50, P: 50 },
            /** 将步骤2的 VLM 画面描述注入，提供上下文给脚本生成 */
            visionResult: {
              sceneDescriptions: step2State?.vlmFrames
                ?.map((f: any) => f.description || '')
                .filter(Boolean)
                .join('\n') || '',
            },
          } : {}),
          /** 步骤4：注入用户选择的 TTS 引擎 + 音色 + 前置剧本文本 */
          ...(step === 4 ? {
            ttsEngine: step4State?.ttsEngine || 'edge',
            ttsVoiceId: step4State?.ttsVoiceId || '',
            voiceId: step4State?.ttsVoiceId || '',
            /** 将步骤3的解说文案注入，供 TTSStrategy 逐段合成 */
            scriptShots: step3State?.scriptParagraphs || [],
          } : {}),
          /** 步骤5：注入解说文案 + VLM 画面描述 + TTS刚性时长 + BGM信息，供三维一体匹配使用 */
          ...(step === 5 ? {
            scriptShots: step3State?.scriptParagraphs || [],
            visionResult: {
              sceneDescriptions: step2State?.vlmFrames
                ?.map((f: any) => f.description || '')
                .filter(Boolean)
                .join('\n') || '',
              frames: step2State?.vlmFrames || [],
            },
            /** 注入步骤4的 TTS 配音刚性时长，供时长约束匹配 */
            ttsDurations: step4State?.ttsResults || [],
            /** 注入背景音乐信息，供 BGM 卡点匹配 */
            bgmInfo: step5State?.activeBgm ? {
              id: step5State.activeBgm.id,
              filePath: step5State.activeBgm.filePath,
            } : null,
          } : {}),
        },
      }});
      const result = await API.engine.runPipeline({
        projectId: projectState.projectId,
        sequence: enrichedSequence,
        sourceMedia: activeMedia?.filePath || '',
      });
      if (result) {
        mapPipelineResultToState(result?.data || result, buildMappers());
      }

      ps.setStepCompleted(step, true);
      ps.setStepStatus(step, 'completed');
      editorLogger.trackStep(step, 'complete');

      /** 完工落盘：将步骤结果持久化到 SQLite，防止重进项目丢失 */
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
            /** 持久化步骤3解说文案和步骤4配音结果，确保重进项目不丢失 */
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

      /** 自动模式下推进到下一步，递归前重新检查 isAutoMode */
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

  /** 启动当前步骤（自动判断步骤类型） */
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

    // 步骤1：素材提取走 media.process
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

    // 步骤2-5：走引擎管线
    await executeStep(currentStep);
  }, [executeStep]);

  /** 触发快速线性管线（参考.html 版本的触发方式） */
  const triggerQuickPipeline = useCallback(async () => {
    const ps = pipelineStore.getState();
    const projectState = useProjectStore.getState();
    if (!projectState.projectId) return AppNotifier.error('项目上下文丢失，无法运行');

    try {
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

  /** 带上下文执行完整管线（TopBar 使用） */
  const executeWithContext = useCallback(async () => {
    const ps = pipelineStore.getState();
    const projectState = useProjectStore.getState();
    const step3State = useStep3Store.getState();
    const { projectId, scriptStyle, pipelineParams } = { ...projectState, ...step3State };

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
