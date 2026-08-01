// Module: pipeline/step2-vision - Container
// 读局部 Store，将纯 Props 传给 View
// @migrated 阶段三：从 useStore → useStep2Store + useEditorNavStore + useProjectStore

import React from "react";
import { useStep2Store } from "../../stores/useStep2Store";
import { useStep1Store } from "../../stores/useStep1Store";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { useEditorNavStore } from "@modules/editor/stores/useEditorNavStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
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
  // 运行中禁用切换
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);

  const handleSetMatrixMode = React.useCallback((mode: 'auto' | '2x2' | '3x3' | '1x1') => {
    const currentFrames = useStep1Store.getState().extractionConfig?.frames || {};
    updateExtractionConfig({
      frames: { ...currentFrames, matrixMode: mode },
    });
  }, [updateExtractionConfig]);

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
      isProcessing={pipelineRunning}
    />
  );
};
