// Module: editor/shell/hooks/usePipelineOrchestrator
// 原 editor/hooks/usePipelineOrchestrator.ts — 已迁移
// S2: useEditorStore → 各本地 Store
//
// 阶段3：步骤2~5 的执行流程已收敛到 pipelineStepRunner.runStep，
// 本文件只保留「自动前进 / 中止 / 步骤1 子任务链 / 快捷执行」等编排职责。

import { useCallback } from 'react';
import { AppNotifier } from '@renderer/core/AppNotifier';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';
import { API } from '@renderer/api';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useEditorNavStore } from '@modules/editor/stores/useEditorNavStore';
import { beginStepRun, failStepRun, isStepArtifactValid } from '../../utils/pipelineArtifactState';
import { substepArtifactKey, type Step1SubStep } from '../../utils/pipelineArtifactMeta';
import {
  runStep,
  markActiveRunAborted,
  isActiveRunToken,
  releaseActiveRunToken,
  resetRunTokens,
} from '../../utils/pipelineStepRunner';

export enum PipelineMode {
  STEP = 'step',
  QUICK = 'quick',
  EXTRACTION = 'extraction',
}

interface PipelineOrchestratorResult {
  /**
   * 执行指定步骤的管线。
   * @param step 步骤号（1~5）
   * @param forceRun 是否强制重新执行。用户主动点击"启动"时为 true（即使该步骤已完成也重新生成）；
   *                 自动流水中由 executeStep 自动前进时省略（false），已完成步骤会被跳过。
   */
  executeStep: (step: number, forceRun?: boolean) => Promise<void>;
  startCurrentStep: () => Promise<void>;
  triggerQuickPipeline: () => Promise<void>;
  executeWithContext: () => Promise<void>;
  abortPipeline: () => Promise<void>;
  resetAll: () => void;
}

export const usePipelineOrchestrator = (): PipelineOrchestratorResult => {
  const pipelineStore = usePipelineStore;

  const abortPipeline = useCallback(async () => {
    // ⚠️ 中止针对「当前这次执行」：用 token 标记，而不是全局布尔，
    //   避免新一轮执行把旧任务的标记清掉后，旧请求继续写库。
    const targetRun = markActiveRunAborted();
    try { await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_ABORT_PIPELINE); } catch {}
    try { await API.engine.abortPipeline(); } catch {}
    // 等待期间用户可能已重新启动：当前 token 已变，不要清掉新一轮的状态
    if (!targetRun || !isActiveRunToken(targetRun)) return;
    const state = pipelineStore.getState();
    // 🛑 中止不是失败：把残留 running 态统一收尾为 idle，等用户重跑
    (['frames', 'audio', 'whisper', 'faces'] as const).forEach((key) => {
      if (state.subStepStatuses[key] === 'running') {
        state.setSubStepStatus(key, 'idle');
        state.setSubStepProgress(key, 0);
      }
    });
    state.stepStatuses.forEach((status, i) => {
      if (status === 'running') state.setStepStatus(i + 1, 'idle');
    });
    state.resetPipeline();
    releaseActiveRunToken();
  }, []);

  const resetAll = useCallback(() => {
    resetRunTokens();
    pipelineStore.getState().resetPipeline();
    pipelineStore.getState().resetAllStepStatuses?.();
    AppNotifier.success('前端状态已强制重置！');
  }, []);

  const executeStep = useCallback(async (step: number, forceRun = false) => {
    const result = await runStep(step, { force: forceRun });
    // 自动模式：本步成功后继续推进到下一步（跳过/失败/中止不递进）
    if (result.status === 'completed' && useEditorNavStore.getState().isAutoMode && step < 5) {
      useEditorNavStore.getState().setCurrentStep(step + 1);
      await executeStep(step + 1);
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
      if (!config) {
        AppNotifier.error('素材分析配置数据异常，请重新创建项目');
        ps.setPipelineRunning(false);
        return;
      }
      // 🔧 修复重复执行：只将「未完成或产物已过期」的启用子步骤设为 running
      // 阶段5：完成态不足以跳过——配置变更会让子步骤产物变为 stale，必须重跑该子步骤；
      //       禁用的子步骤不参与（不产出也不阻断步骤1完成）。
      const currentSubStatuses = ps.subStepStatuses;
      const enabledKeys: Step1SubStep[] = ['frames', 'audio', 'whisper', 'faces'];
      const keysToRun: Step1SubStep[] = [];
      enabledKeys.forEach(key => {
        if (config[key]?.enabled === false) return;
        const alreadyCompleted = currentSubStatuses[key] === 'completed'
          && isStepArtifactValid(substepArtifactKey(key));
        if (!alreadyCompleted) {
          ps.setSubStepStatus(key, 'running');
          ps.setSubStepStarted(key);
          keysToRun.push(key);
        }
      });
      // 如果所有启用子步骤都已完成且产物有效，直接标记 step1 完成，不发请求
      if (keysToRun.length === 0) {
        ps.setStepCompleted(1, true);
        ps.setStepStatus(1, 'completed');
        ps.setPipelineRunning(false);
        AppNotifier.success('所有子任务已完成，无需重新执行');
        // 跳转到下一步
        if (useEditorNavStore.getState().isAutoMode) {
          useEditorNavStore.getState().setCurrentStep(2);
        }
        return;
      }
      console.log('[Step1 增量执行] 需执行子步骤:', keysToRun, '已跳过(有效):',
        enabledKeys.filter(k => config[k]?.enabled && !keysToRun.includes(k)));
      ps.setStepStatus(1, 'running');
      ps.setPipelineRunning(true);
      ps.setPipelineProgress(0, '准备中');

      // 🎫 阶段5：每个即将执行的子步骤各自冻结输入指纹（并失效其下游链）。
      for (const key of keysToRun) {
        await beginStepRun(substepArtifactKey(key));
      }

      try {
        await API.media.process(projectId, activeMedia, {
          targetLanguage: config.targetLanguage || 'zh-CN',
          frames: config.frames.enabled ? {
            enabled: true,
            mode: config.frames.mode,
            // 🔧 修复 TS2339：frames 配置无 value/density 字段，直接用 sceneThreshold/fps
            sceneThreshold: config.frames.sceneThreshold ?? 0.25,
            minFrameInterval: config.frames.minFrameInterval ?? 3.5,
            fps: config.frames.fps ?? 2,
          } : { enabled: false },
          audio: config.audio,
          whisper: config.whisper,
          faces: config.faces,
        });
        AppNotifier.info('素材提取任务已加入队列');
      } catch (err: any) {
        // 🔧 修复状态覆盖：只重置本次要执行的子步骤（keysToRun），不能碰已 completed 的子步骤
        for (const key of keysToRun) {
          await failStepRun(substepArtifactKey(key));
          ps.setSubStepStatus(key, 'idle');
        }
        ps.setStepStatus(1, 'failed');
        ps.setPipelineError(err?.message || '素材提取启动失败');
        ps.setPipelineRunning(false);
      }
      return;
    }

    // 用户主动点击"启动"：forceRun=true，即使该步骤已完成也强制重新生成
    await executeStep(currentStep, true);
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
        context: { scriptStyle, pipelineParams, projectId },
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
