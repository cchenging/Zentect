// Module: pipeline/step5-match - Container
// @migrated 阶段三：从 useStore → useStep5Store + useProjectStore + usePipelineStore + useStep2Store + useStep3Store + useStep4Store
// 阶段四：移除 mapPipelineResultToState 的 useStore fallback

import React, { useCallback } from "react";
import { useStep5Store } from "../../stores/useStep5Store";
import { useStep2Store } from "../../stores/useStep2Store";
import { useStep3Store } from "../../stores/useStep3Store";
import { useStep4Store } from "../../stores/useStep4Store";
import { usePipelineStore } from "../../../../renderer/src/store/usePipelineStore";
import { useProjectStore } from "../../../editor/stores/useProjectStore";
import { API } from "../../../../renderer/src/api";
import { mapPipelineResultToState } from "../../../../renderer/src/pages/editor/hooks/usePipelineResultMapper";
import { buildMappers } from "../../../../renderer/src/pages/editor/hooks/usePipelineOrchestrator";
import { STEP_SEQUENCES } from "../../../../renderer/src/pages/editor/utils/pipelineConstants";
import { StepShotMatchingView } from "./View";

export const StepShotMatching: React.FC = () => {
  const matchResults = useStep5Store((s) => s.matchResults);
  const activeBgm = useStep5Store((s) => s.activeBgm);
  const videoChunks = useStep5Store((s) => s.videoChunks);
  const confirmMatch = useStep5Store((s) => s.confirmMatch);
  const setMatchResults = useStep5Store((s) => s.setMatchResults);

  const mediaItems = useProjectStore((s) => s.mediaItems);
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);

  const handleReplace = useCallback((shotId: string, chunkItem: any) => {
    const coverPath = chunkItem.coverPath || chunkItem.filePath || chunkItem.thumbnail;
    const step5State = useStep5Store.getState();
    step5State.replaceMatch(shotId, chunkItem.id);
    const updated = step5State.matchResults.map((m: any) =>
      m.shotId === shotId
        ? { ...m, mediaId: chunkItem.id, thumbnail: coverPath, chunkData: chunkItem.chunkData || chunkItem, confirmed: false }
        : m
    );
    setMatchResults(updated);
  }, [setMatchResults]);

  const handleRematch = useCallback(async () => {
    const projectState = useProjectStore.getState();
    const pipelineState = usePipelineStore.getState();
    const step2State = useStep2Store.getState();
    const step3State = useStep3Store.getState();
    const step4State = useStep4Store.getState();
    const step5State = useStep5Store.getState();

    if (!projectState.projectId) return;
    pipelineState.setStepStatus(5, "running");
    pipelineState.setPipelineRunning(true);
    pipelineState.resetPipeline();
    try {
      const sequence = STEP_SEQUENCES[5];
      const enriched = sequence.map((node: any) => ({
        ...node,
        params: {
          ...(node.params || {}),
          mediaPath: projectState.mediaItems?.[0]?.filePath || "",
          scriptShots: step3State.scriptParagraphs || [],
          ttsDurations: step4State.ttsResults || [],
          visionResult: {
            sceneDescriptions: step2State.vlmFrames?.map((f: any) => f.description || "").filter(Boolean).join("\n") || "",
          },
          bgmInfo: step5State.activeBgm
            ? { id: step5State.activeBgm.id, filePath: step5State.activeBgm.filePath }
            : null,
        },
      }));
      const result = await API.engine.runPipeline({
        projectId: projectState.projectId,
        sequence: enriched,
        sourceMedia: projectState.mediaItems?.[0]?.filePath || "",
      });
      if (result) mapPipelineResultToState(result?.data || result, buildMappers());
      pipelineState.setStepCompleted(5, true);
      pipelineState.setStepStatus(5, "completed");
    } catch (err: any) {
      pipelineState.setStepStatus(5, "failed");
      pipelineState.setPipelineError(err?.message || "匹配失败");
    } finally {
      pipelineState.setPipelineRunning(false);
    }
  }, []);

  return (
    <StepShotMatchingView
      matchResults={matchResults}
      videoChunks={videoChunks}
      mediaItems={mediaItems}
      hasBgm={!!activeBgm}
      isProcessing={pipelineRunning}
      onConfirm={confirmMatch}
      onReplace={handleReplace}
      onRematch={handleRematch}
      onReorder={setMatchResults}
    />
  );
};
