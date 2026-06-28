import React from "react";
import { useStore } from "../../../../store/useStore";
import { StepVisionDescriptionView } from "./containers/StepVisionDescriptionView";

/** 步骤2 Container — 读 Store，传给 Presenter */
export const StepVisionDescription: React.FC = () => {
  const vlmFrames = useStore((s) => s.vlmFrames);
  const updateVlmDescription = useStore((s) => s.updateVlmDescription);
  const setVlmEditing = useStore((s) => s.setVlmEditing);
  const setCurrentStep = useStore((s) => s.setCurrentStep);

  const handleGoToStep1 = React.useCallback(() => {
    const state = useStore.getState();
    if (state.projectId && state.mediaItems.length > 0) {
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