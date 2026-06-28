import React, { useCallback } from "react";
import { useStore } from "../../../../store/useStore";
import { StepShotMatchingView } from "./containers/StepShotMatchingView";
import { API } from "../../../../api";
import { mapPipelineResultToState } from "../../hooks/usePipelineResultMapper";
import { STEP_SEQUENCES } from "../../utils/pipelineConstants";
import type { MatchResult } from "../../../../../../shared/types/entities/editor";

export const StepShotMatching: React.FC = () => {
  const matchResults = useStore((s) => s.matchResults);
  const mediaItems = useStore((s) => s.mediaItems);
  const activeBgm = useStore((s) => s.activeBgm);
  const videoChunks = useStore((s) => s.videoChunks);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const confirmMatch = useStore((s) => s.confirmMatch);
  const setMatchResults = useStore((s) => s.setMatchResults);

  const handleReplace = useCallback((shotId: string, chunkItem: any) => {
    const coverPath = chunkItem.coverPath || chunkItem.filePath || chunkItem.thumbnail;
    useStore.getState().replaceMatch(shotId, chunkItem.id);
    const state = useStore.getState();
    const updated = state.matchResults.map((m: any) => m.shotId === shotId ? { ...m, mediaId: chunkItem.id, thumbnail: coverPath, chunkData: chunkItem.chunkData || chunkItem, confirmed: false } : m);
    setMatchResults(updated);
  }, [setMatchResults]);

  const handleRematch = useCallback(async () => {
    const state = useStore.getState();
    if (!state.projectId) return;
    state.setStepStatus(5, "running");
    state.setPipelineRunning(true);
    state.resetPipeline();
    try {
      const sequence = STEP_SEQUENCES[5];
      const enriched = sequence.map((node: any) => ({ ...node, params: { ...(node.params || {}), mediaPath: state.mediaItems?.[0]?.filePath || "", scriptShots: state.scriptParagraphs || [], ttsDurations: state.ttsResults || [], visionResult: { sceneDescriptions: state.vlmFrames?.map((f: any) => f.description || "").filter(Boolean).join("\n") || "" }, bgmInfo: state.activeBgm ? { id: state.activeBgm.id, filePath: state.activeBgm.filePath } : null } }));
      const result = await API.engine.runPipeline({ projectId: state.projectId, sequence: enriched, sourceMedia: state.mediaItems?.[0]?.filePath || "" });
      if (result) mapPipelineResultToState(result?.data || result, useStore.getState());
      state.setStepCompleted(5, true);
      state.setStepStatus(5, "completed");
    } catch (err: any) {
      state.setStepStatus(5, "failed");
      state.setPipelineError(err?.message || "匹配失败");
    } finally {
      state.setPipelineRunning(false);
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