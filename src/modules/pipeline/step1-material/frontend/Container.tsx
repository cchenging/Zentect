// Module: pipeline/step1-material - Container
// @migrated 阶段三：从 useStore → useStep1Store + useProjectStore + usePlayerStore

import React, { useCallback, useMemo } from "react";
import { useStep1Store } from "../../stores/useStep1Store";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { usePlayerStore } from "@modules/editor/stores/usePlayerStore";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { IPC_CHANNELS } from "@modules/infra/ipc/IpcConstants";
import type { MediaItem, Role } from "../../../../shared/types";
import type { AsrLine, StepStatus } from "../../../../shared/types/entities/editor";
import type { Step1Config } from "../types";
import { StepMaterialAnalysisView } from "./View";

export const StepMaterialAnalysis: React.FC = () => {
  const asrLines = useStep1Store((s) => s.asrLines);
  const frameCount = useStep1Store((s) => s.frameCount);
  const audioSeparated = useStep1Store((s) => s.audioSeparated);
  const step1SubStepProgresses = useStep1Store((s) => s.subStepProgresses);
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  /** subStepStatuses 已收敛为 PipelineStore 单一数据源 */
  const subStepStatuses = usePipelineStore((s) => s.subStepStatuses);
  const pipelineSubStepProgresses = usePipelineStore((s) => s.subStepProgresses);

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
  const setSubStepStatus = usePipelineStore((s) => s.setSubStepStatus);
  const setSubStepProgress = useStep1Store((s) => s.setSubStepProgress);
  const setFrameCount = useStep1Store((s) => s.setFrameCount);
  const setAudioSeparated = useStep1Store((s) => s.setAudioSeparated);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const mediaItems = useProjectStore((s) => s.mediaItems);
  const roles = useProjectStore((s) => s.roles);
  const extractedData = useProjectStore((s) => s.extractedData);
  const updateRole = useProjectStore((s) => s.updateRole);

  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setActivePlaySource = usePlayerStore((s) => s.setActivePlaySource);

  const handleRetrySubStep = useCallback(
    async (stepKey: string) => {
      setSubStepStatus(stepKey, "running");
      setSubStepProgress(stepKey, 0);

      const projectState = useProjectStore.getState();
      const pipelineState = usePipelineStore.getState();
      const step1State = useStep1Store.getState();
      if (!projectState.projectId) return;

      const mediaItem = projectState.mediaItems[0];
      if (!mediaItem?.filePath) return;

      const currentConfig = step1State.extractionConfig;
      const retryConfig = {
        ...currentConfig,
        frames: stepKey === 'frames' ? { ...currentConfig.frames, enabled: true } : { ...currentConfig.frames, enabled: false },
        audio: stepKey === 'audio' ? { ...currentConfig.audio, enabled: true } : { ...currentConfig.audio, enabled: false },
        whisper: stepKey === 'whisper' ? { ...currentConfig.whisper, enabled: true } : { ...currentConfig.whisper, enabled: false },
        faces: stepKey === 'faces' ? { ...currentConfig.faces, enabled: true } : { ...currentConfig.faces, enabled: false },
      };

      pipelineState.setPipelineRunning?.(true);

      try {
        await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_RUN_PIPELINE, {
          projectId: projectState.projectId,
          sequence: [{
            nodeId: `step1-retry-${stepKey}-${Date.now()}`,
            actionType: 'step1-material',
            label: `重试: ${stepKey}`,
            dependsOn: [],
            params: {
              mediaPath: mediaItem.filePath,
              mediaId: mediaItem.id,
              config: retryConfig,
            },
          }],
        });
      } catch (err: any) {
        setSubStepStatus(stepKey, "failed");
        pipelineState.setPipelineRunning?.(false);
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
