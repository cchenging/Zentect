// Module: pipeline/step2-vision - Container
// 读局部 Store，将纯 Props 传给 View
// @migrated 阶段三：从 useStore → useStep2Store + useEditorNavStore + useProjectStore

import React from "react";
import { useStep2Store } from "../../stores/useStep2Store";
import { useEditorNavStore } from "@modules/editor/stores/useEditorNavStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { StepVisionDescriptionView } from "./View";

export const StepVisionDescription: React.FC = () => {
  const vlmFrames = useStep2Store((s) => s.vlmFrames);
  const updateVlmDescription = useStep2Store((s) => s.updateVlmDescription);
  const setVlmEditing = useStep2Store((s) => s.setVlmEditing);
  const setCurrentStep = useEditorNavStore((s) => s.setCurrentStep);

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
    />
  );
};
