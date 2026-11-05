// Module: pipeline/step2-vision - Container
// 读局部 Store，将纯 Props 传给 View
// @migrated 阶段三：从 useStore → useStep2Store + useEditorNavStore + useProjectStore

import React from "react";
import { useStep2Store } from "../../stores/useStep2Store";
import { useStep1Store } from "../../stores/useStep1Store";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { useEditorNavStore } from "@modules/editor/stores/useEditorNavStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { touchArtifact } from "@modules/editor/shell/utils/pipelineArtifactState";
import { StepVisionDescriptionView } from "./View";

export const StepVisionDescription: React.FC = () => {
  const vlmFrames = useStep2Store((s) => s.vlmFrames);
  const updateVlmDescription = useStep2Store((s) => s.updateVlmDescription);
  const setVlmEditing = useStep2Store((s) => s.setVlmEditing);
  const setCurrentStep = useEditorNavStore((s) => s.setCurrentStep);

  // P2: matrixMode 存储在 useStep1Store.extractionConfig.frames.matrixMode（步骤1、2 共享）
  // 选择器在步骤2 UI 展示，但数据源复用步骤1 store，避免迁移成本
  const matrixMode = useStep1Store((s) => s.extractionConfig?.frames?.matrixMode || 'auto');
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);
  // 运行中禁用切换：只看步骤2 自己的状态，别被其它步骤的运行态误伤
  const step2Running = usePipelineStore((s) => s.stepStatuses[1] === 'running');

  const handleSetMatrixMode = React.useCallback((mode: 'auto' | '2x2' | '3x3' | '1x1') => {
    if (step2Running || mode === matrixMode) return;
    const currentFrames = useStep1Store.getState().extractionConfig?.frames || {};
    updateExtractionConfig({
      frames: { ...currentFrames, matrixMode: mode },
    });
    // 🎫 阶段4：不再手写失效。matrixMode 已进入步骤2输入指纹，
    //   切换后步骤2版本自动变为「已过期」，自动流水线不会跳过、导出被阻断；
    //   步骤3-5 在步骤2重跑(rev2+1)后同步过期，无需在此清空下游数据。
  }, [updateExtractionConfig, step2Running, matrixMode]);

  const handleGoToStep1 = React.useCallback(() => {
    const projectState = useProjectStore.getState();
    if (projectState.projectId && projectState.mediaItems.length > 0) {
      setCurrentStep(1);
    }
  }, [setCurrentStep]);

  /**
   * 🎫 阶段4：画面描述手工编辑 = 产物2 被人工修订。
   * 防抖后 touchArtifact('2')：rev2+1、认证为当前输入下的有效产物，并让步骤3/4/5 自动过期。
   * 防抖避免逐字写库；卸载时立即冲刷，防止最后一笔编辑丢失版本信息。
   */
  const touchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTouch = React.useRef(false);
  const flushTouch = React.useCallback(() => {
    if (!pendingTouch.current) return;
    pendingTouch.current = false;
    void touchArtifact('2');
  }, []);
  React.useEffect(() => () => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
    flushTouch();
  }, [flushTouch]);

  const handleUpdateDescription = React.useCallback(
    (...args: Parameters<typeof updateVlmDescription>) => {
      updateVlmDescription(...args);
      pendingTouch.current = true;
      if (touchTimer.current) clearTimeout(touchTimer.current);
      touchTimer.current = setTimeout(() => {
        touchTimer.current = null;
        flushTouch();
      }, 800);
    },
    [updateVlmDescription, flushTouch],
  );

  return (
    <StepVisionDescriptionView
      vlmFrames={vlmFrames}
      onUpdateDescription={handleUpdateDescription}
      onSetEditing={setVlmEditing}
      onGoToStep1={handleGoToStep1}
      matrixMode={matrixMode}
      onSetMatrixMode={handleSetMatrixMode}
      isProcessing={step2Running}
    />
  );
};
