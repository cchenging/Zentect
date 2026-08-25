// Module: pipeline/step1-material - Container
// @migrated 阶段三：从 useStore → useStep1Store + useProjectStore + usePlayerStore

import React, { useCallback, useMemo } from "react";
import { useStep1Store } from "../../stores/useStep1Store";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { usePlayerStore } from "@modules/editor/stores/usePlayerStore";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { usePipelineOrchestrator } from "@modules/editor/shell/frontend/hooks/usePipelineOrchestrator";
import { API } from "@renderer/api";
import { AppNotifier } from "@renderer/core/AppNotifier";
import type { Step1Config } from "../types";
import { StepMaterialAnalysisView } from "./View";

export const StepMaterialAnalysis: React.FC = () => {
  const asrLines = useStep1Store((s) => s.asrLines);
  const audioSeparated = useStep1Store((s) => s.audioSeparated);
  const vocalsIsFallback = useStep1Store((s) => s.vocalsIsFallback);
  const step1SubStepProgresses = useStep1Store((s) => s.subStepProgresses);
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  /** subStepStatuses 已收敛为 PipelineStore 单一数据源 */
  const subStepStatuses = usePipelineStore((s) => s.subStepStatuses);
  const pipelineSubStepProgresses = usePipelineStore((s) => s.subStepProgresses);
  const subStepTimings = usePipelineStore((s) => s.subStepTimings);

  const subStepProgresses = useMemo(() => {
    const merged = { ...step1SubStepProgresses };
    for (const key of Object.keys(pipelineSubStepProgresses)) {
      if (pipelineSubStepProgresses[key] > 0) {
        merged[key] = pipelineSubStepProgresses[key];
      }
    }
    return merged;
  }, [step1SubStepProgresses, pipelineSubStepProgresses]);
  const setAsrLines = useStep1Store((s) => s.setAsrLines);
  const updateAsrLine = useStep1Store((s) => s.updateAsrLine);
  const removeAsrLine = useStep1Store((s) => s.removeAsrLine);
  const setSubStepStatus = usePipelineStore((s) => s.setSubStepStatus);
  const setSubStepProgress = useStep1Store((s) => s.setSubStepProgress);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const mediaItems = useProjectStore((s) => s.mediaItems);
  const roles = useProjectStore((s) => s.roles);
  const extractedData = useProjectStore((s) => s.extractedData);
  /** 步骤1 关键帧数统一从 extractedData.framePaths 派生，与成果素材(关键帧Tab)同源，
   *  避免旧版 useStep1Store.frameCount 与 framePaths 写入时序不一致导致两边数字不同 */
  const frameCount = extractedData?.framePaths?.length ?? 0;
  const updateRole = useProjectStore((s) => s.updateRole);
  const mergeRoles = useProjectStore((s) => s.mergeRoles);
  const unmergeRole = useProjectStore((s) => s.unmergeRole);
  const deleteRole = useProjectStore((s) => s.deleteRole);

  const setActivePlaySource = usePlayerStore((s) => s.setActivePlaySource);

  /**
   * ASR 台词「跳转」动作：真正 seek 媒体到指定时间点。
   * 🔧 修复：旧版接 setCurrentTime 只更新进度条 state，不 seek 媒体，
   *   导致视频位置不动（"位置是假的"）。改为写 manualSeekTime，
   *   VideoCanvas 监听它并执行 media.currentTime = manualSeekTime。
   * 不依赖 store.duration 截断（媒体元素自身会按真实时长截断），
   * 避免 duration 未就绪时被 clamp 到 0。
   */
  const seekTo = useCallback((time: number) => {
    const clamped = Math.max(0, time);
    usePlayerStore.setState({ currentTime: clamped, manualSeekTime: clamped });
  }, []);

  const handleRetrySubStep = useCallback(
    async (stepKey: string) => {
      setSubStepStatus(stepKey, "running");
      setSubStepProgress(stepKey, 0);
      usePipelineStore.getState().setSubStepStarted(stepKey);

      const projectState = useProjectStore.getState();
      const pipelineState = usePipelineStore.getState();
      const step1State = useStep1Store.getState();
      if (!projectState.projectId) return;

      const mediaItem = projectState.mediaItems.find((m: any) => m.type === 'video') || projectState.mediaItems[0];
      if (!mediaItem?.filePath) return;

      // 🔧 修复重试无反应：currentConfig 可能为 null（首次加载未初始化），提供默认配置
      const currentConfig = step1State.extractionConfig || {
        frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.25, minFrameInterval: 3.5, fps: 2 },
        audio: { enabled: true, separationMode: 'quality', engine: 'mdx' },
        whisper: { enabled: true, engine: 'sensevoice', language: 'zh', modelSize: 'large-v3' },
        faces: { enabled: true, engine: 'insightface' },
        targetLanguage: 'zh-CN',
      };
      // 🔧 修复重试：只启用被点击的子步骤，禁用其他，同时传递 _forceRetry 让后端强制执行（不跳过）
      // 注意：enabled=false 的子步骤会被完全禁用，而 forceRetryStep 指定的子步骤即使文件存在也会重新生成
      const retryConfig = {
        targetLanguage: currentConfig.targetLanguage || 'zh-CN',
        frames: { ...(currentConfig.frames || {}), enabled: stepKey === 'frames' },
        audio: { ...(currentConfig.audio || {}), enabled: stepKey === 'audio' },
        whisper: { ...(currentConfig.whisper || {}), enabled: stepKey === 'whisper' },
        faces: { ...(currentConfig.faces || {}), enabled: stepKey === 'faces' },
        /** 💥 强制重试标志：告诉后端不要跳过该子步骤，即使文件已存在也要重新生成 */
        _forceRetry: stepKey,
      };

      pipelineState.setPipelineRunning?.(true);

      try {
        // 🔧 关键修复：使用 API.media.process 走 JobScheduler 路径（有DB回写+前端通知），
        // 而不是直接调用 ENGINE_RUN_PIPELINE（直接调用不会回写DB也不会通知前端更新状态）
        await API.media.process(projectState.projectId, mediaItem, retryConfig);
        AppNotifier.info(`正在重新${stepKey === 'frames' ? '提取关键帧' : stepKey === 'audio' ? '分离音频' : stepKey === 'whisper' ? '识别台词' : '识别人物'}...`);
      } catch (err: any) {
        console.error('[RetrySubStep] 失败:', err);
        setSubStepStatus(stepKey, "failed");
        pipelineState.setPipelineRunning?.(false);
        AppNotifier.error(`重试失败: ${err?.message || '未知错误'}`);
      }
    },
    [setSubStepStatus, setSubStepProgress]
  );

  /** 停止正在运行的子任务：调用后端 abortPipeline + 前端状态置为 idle
   *  注意：abortPipeline 会停止整个管线，但在重试场景下只启用了当前子任务，效果等同停止单个子任务 */
  const { abortPipeline } = usePipelineOrchestrator();
  const handleAbortSubStep = useCallback(
    async (stepKey: string) => {
      try {
        await abortPipeline();
      } catch {}
      setSubStepStatus(stepKey, "idle");
      setSubStepProgress(stepKey, 0);
    },
    [abortPipeline, setSubStepStatus, setSubStepProgress]
  );

  const handleUpdateExtractionConfig = useCallback(
    (config: Partial<Step1Config>) => {
      updateExtractionConfig(config);
    },
    [updateExtractionConfig]
  );

  return (
    <StepMaterialAnalysisView
      asrLines={asrLines}
      frameCount={frameCount}
      audioSeparated={audioSeparated}
      vocalsIsFallback={vocalsIsFallback}
      mediaItems={mediaItems}
      roles={roles}
      subStepStatuses={subStepStatuses}
      subStepProgresses={subStepProgresses}
      subStepTimings={subStepTimings}
      extractionConfig={extractionConfig as Step1Config | null}
      extractedData={extractedData}
      onUpdateAsrLine={updateAsrLine}
      onRemoveAsrLine={removeAsrLine}
      onSetAsrLines={setAsrLines}
      onSetCurrentTime={seekTo}
      onSetActivePlaySource={setActivePlaySource}
      onUpdateRole={updateRole}
      onMergeRoles={mergeRoles}
      onUnmergeRole={unmergeRole}
      onDeleteRole={deleteRole}
      onSetSubStepStatus={setSubStepStatus}
      onRetrySubStep={handleRetrySubStep}
      onAbortSubStep={handleAbortSubStep}
      onUpdateExtractionConfig={handleUpdateExtractionConfig}
    />
  );
};
