import React, { useCallback } from "react";
import { useStore } from "../../../../store/useStore";
import { API } from "../../../../api";
import { AppNotifier } from "../../../../core/AppNotifier";
import { StepMaterialAnalysisView } from "./containers/StepMaterialAnalysisView";
import type { AsrLine, StepStatus } from "../../../../../../shared/types/entities/editor";

export const StepMaterialAnalysis: React.FC = () => {
  const asrLines = useStore((s) => s.asrLines);
  const frameCount = useStore((s) => s.frameCount);
  const audioSeparated = useStore((s) => s.audioSeparated);
  const mediaItems = useStore((s) => s.mediaItems);
  const roles = useStore((s) => s.roles);
  const updateAsrLine = useStore((s) => s.updateAsrLine);
  const setAsrLines = useStore((s) => s.setAsrLines);
  const setCurrentTime = useStore((s) => s.setCurrentTime);
  const setActivePlaySource = useStore((s) => s.setActivePlaySource);
  const updateRole = useStore((s) => s.updateRole);
  const subStepStatuses = useStore((s) => s.subStepStatuses);
  const subStepProgresses = useStore((s) => s.subStepProgresses);
  const setSubStepStatus = useStore((s) => s.setSubStepStatus);
  const projectId = useStore((s) => s.projectId);
  const extractionConfig = useStore((s) => s.extractionConfig);

  const handleRetrySubStep = useCallback(async (stepKey: string) => {
    const state = useStore.getState();
    const activeVideo = state.mediaItems.find((m: any) => m.type === "video");
    if (!projectId || !activeVideo) { AppNotifier.error("请先导入视频素材"); return; }
    try {
      setSubStepStatus(stepKey, "running");
      const framesConfig = state.extractionConfig?.frames || {};
      const config: any = {
        targetLanguage: state.extractionConfig?.targetLanguage || "zh-CN",
        frames: stepKey === "frames" ? { enabled: true, mode: framesConfig.mode || "VLM_OPTIMIZED", sceneThreshold: framesConfig.value || 0.28, minFrameInterval: framesConfig.minFrameInterval ?? 4, fps: framesConfig.fps || 2, scale: framesConfig.scale ?? 1024, quality: framesConfig.quality ?? 3 } : { enabled: false },
        audio: stepKey === "audio" ? { ...state.extractionConfig?.audio, enabled: true } : { enabled: false },
        whisper: stepKey === "whisper" ? { ...state.extractionConfig?.whisper, enabled: true } : { enabled: false },
        faces: stepKey === "faces" ? { ...state.extractionConfig?.faces, enabled: true } : { enabled: false },
      };
      await API.media.process(projectId, activeVideo, config);
      AppNotifier.info("任务已提交");
    } catch (error: any) {
      setSubStepStatus(stepKey, "failed");
      AppNotifier.error(error.message || "操作失败");
    }
  }, [projectId, setSubStepStatus]);

  return (
    <StepMaterialAnalysisView
      asrLines={asrLines} frameCount={frameCount} audioSeparated={audioSeparated}
      mediaItems={mediaItems} roles={roles}
      subStepStatuses={subStepStatuses} subStepProgresses={subStepProgresses}
      extractionConfig={extractionConfig} extractedData={useStore((s) => s.extractedData)}
      onUpdateAsrLine={updateAsrLine} onSetAsrLines={setAsrLines}
      onSetCurrentTime={setCurrentTime} onSetActivePlaySource={setActivePlaySource}
      onUpdateRole={updateRole} onSetSubStepStatus={setSubStepStatus}
      onRetrySubStep={handleRetrySubStep} onUpdateExtractionConfig={useStore((s) => s.updateExtractionConfig)}
    />
  );
};