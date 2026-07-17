// Module: pipeline/step1-material - Container
// @migrated 阶段三：从 useStore → useStep1Store + useProjectStore + usePlayerStore

import React, { useCallback, useMemo } from "react";
import { useStep1Store } from "../../stores/useStep1Store";
import { useProjectStore } from "../../../editor/stores/useProjectStore";
import { usePlayerStore } from "../../../editor/stores/usePlayerStore";
import { usePipelineStore } from "../../../../renderer/src/store/usePipelineStore";
import type { MediaItem, Role } from "../../../../shared/types";
import type { AsrLine, StepStatus } from "../../../../shared/types/entities/editor";
import type { Step1Config } from "../types";
import { StepMaterialAnalysisView } from "./View";

export const StepMaterialAnalysis: React.FC = () => {
  const asrLines = useStep1Store((s) => s.asrLines);
  const frameCount = useStep1Store((s) => s.frameCount);
  const audioSeparated = useStep1Store((s) => s.audioSeparated);
  const step1SubStepStatuses = useStep1Store((s) => s.subStepStatuses);
  const step1SubStepProgresses = useStep1Store((s) => s.subStepProgresses);
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const pipelineSubStepStatuses = usePipelineStore((s) => s.subStepStatuses);
  const pipelineSubStepProgresses = usePipelineStore((s) => s.subStepProgresses);

  // 双 Store 合并：管线执行期间 pipelineStore 有最新状态，优先使用；
  // 管线空闲时回退到 step1Store（用于持久化/重试后的状态）
  const subStepStatuses = useMemo(() => {
    const merged = { ...step1SubStepStatuses };
    for (const key of Object.keys(pipelineSubStepStatuses)) {
      if (pipelineSubStepStatuses[key] !== 'idle') {
        merged[key] = pipelineSubStepStatuses[key];
      }
    }
    return merged;
  }, [step1SubStepStatuses, pipelineSubStepStatuses]);

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
  const setSubStepStatus = useStep1Store((s) => s.setSubStepStatus);
  const setSubStepProgress = useStep1Store((s) => s.setSubStepProgress);
  const setFrameCount = useStep1Store((s) => s.setFrameCount);
  const setAudioSeparated = useStep1Store((s) => s.setAudioSeparated);
  const setAllSubStepsCompleted = useStep1Store((s) => s.setAllSubStepsCompleted);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const mediaItems = useProjectStore((s) => s.mediaItems);
  const roles = useProjectStore((s) => s.roles);
  const extractedData = useProjectStore((s) => s.extractedData);
  const updateRole = useProjectStore((s) => s.updateRole);

  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setActivePlaySource = usePlayerStore((s) => s.setActivePlaySource);

  const handleRetrySubStep = useCallback(
    (stepKey: string) => {
      if (stepKey === "frames") {
        setSubStepStatus("frames", "running");
        setSubStepProgress("frames", 0);
      } else if (stepKey === "audio") {
        setSubStepStatus("audio", "running");
        setSubStepProgress("audio", 0);
      } else if (stepKey === "whisper") {
        setSubStepStatus("whisper", "running");
        setSubStepProgress("whisper", 0);
      } else if (stepKey === "faces") {
        setSubStepStatus("faces", "running");
        setSubStepProgress("faces", 0);
      }
    },
    [setSubStepStatus, setSubStepProgress]
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
      mediaItems={mediaItems}
      roles={roles}
      subStepStatuses={subStepStatuses}
      subStepProgresses={subStepProgresses}
      extractionConfig={extractionConfig as Step1Config | null}
      extractedData={extractedData}
      onUpdateAsrLine={updateAsrLine}
      onSetAsrLines={setAsrLines}
      onSetCurrentTime={setCurrentTime}
      onSetActivePlaySource={setActivePlaySource}
      onUpdateRole={updateRole}
      onSetSubStepStatus={setSubStepStatus}
      onRetrySubStep={handleRetrySubStep}
      onUpdateExtractionConfig={handleUpdateExtractionConfig}
    />
  );
};
