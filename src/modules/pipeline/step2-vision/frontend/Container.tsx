// Module: pipeline/step2-vision - Container
// 读局部 Store，将纯 Props 传给 View
// @migrated 阶段三：从 useStore → useStep2Store + useEditorNavStore + useProjectStore

import React from "react";
import { useStep2Store } from "../../stores/useStep2Store";
import { useStep1Store } from "../../stores/useStep1Store";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { useEditorNavStore } from "@modules/editor/stores/useEditorNavStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { invalidateDownstreamSteps } from "@modules/editor/shell/utils/invalidateDownstreamSteps";
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
    // 矩阵模式变化 ⇒ 画面描述需重算，步骤3 及以后一并作废
    invalidateDownstreamSteps(1);
  }, [updateExtractionConfig, step2Running, matrixMode]);

  const handleGoToStep1 = React.useCallback(() => {
    const projectState = useProjectStore.getState();
    if (projectState.projectId && projectState.mediaItems.length > 0) {
      setCurrentStep(1);
    }
  }, [setCurrentStep]);

  return (
    <StepVisionDescriptionView
      vlmFrames={vlmFrames}
      onUpdateDescription={updateVlmDescription}
      onSetEditing={setVlmEditing}
      onGoToStep1={handleGoToStep1}
      matrixMode={matrixMode}
      onSetMatrixMode={handleSetMatrixMode}
      isProcessing={step2Running}
    />
  );
};
