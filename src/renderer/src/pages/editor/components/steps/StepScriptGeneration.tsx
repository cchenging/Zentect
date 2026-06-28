import React, { useCallback } from "react";
import { useStore } from "../../../../store/useStore";
import { API } from "../../../../api";
import { mapPipelineResultToState } from "../../hooks/usePipelineResultMapper";
import { STEP_SEQUENCES } from "../../utils/pipelineConstants";
import { diffParagraphs, applyDiffUpdate } from "../../utils/scriptDiffTree";
import { StepScriptGenerationView } from "./containers/StepScriptGenerationView";

export const StepScriptGeneration: React.FC = () => {
  const scriptParagraphs = useStore((s) => s.scriptParagraphs);
  const scriptStyle = useStore((s) => s.scriptStyle);
  const speechRate = useStore((s) => s.speechRate);
  const pipelineParams = useStore((s) => s.pipelineParams);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const vlmFrames = useStore((s) => s.vlmFrames);
  const setScriptStyle = useStore((s) => s.setScriptStyle);
  const setSpeechRate = useStore((s) => s.setSpeechRate);
  const setPipelineParams = useStore((s) => s.setPipelineParams);
  const updateScriptParagraph = useStore((s) => s.updateScriptParagraph);
  const setScriptParagraphs = useStore((s) => s.setScriptParagraphs);

  const updateParagraphEmotion = useCallback((paragraphId: string, emotion: string) => {
    const state = useStore.getState();
    setScriptParagraphs(state.scriptParagraphs.map((p) => (p.id === paragraphId ? { ...p, emotion } : p)));
  }, [setScriptParagraphs]);

  const handleRegenerate = useCallback(async () => {
    const state = useStore.getState();
    if (!state.projectId) return;
    state.setStepStatus(3, "running");
    state.setPipelineRunning(true);
    state.resetPipeline();
    try {
      const sequence = STEP_SEQUENCES[3].map((node: any) => ({ ...node, params: { ...(node.params || {}), mediaPath: state.mediaItems?.[0]?.filePath || "", scriptStyle: state.scriptStyle || "叙事", speechRate: state.speechRate || 4.5, pipelineParams: state.pipelineParams, visionResult: { sceneDescriptions: state.vlmFrames?.map((f: any) => f.description || "").filter(Boolean).join("\n") || "" } } }));
      const result = await API.engine.runPipeline({ projectId: state.projectId, sequence, sourceMedia: state.mediaItems?.[0]?.filePath || "" });
      if (result) {
        const rawData = result?.data || result;
        const nodeResult = rawData["script-1"] || rawData["script"] || rawData;
        if (nodeResult) {
          const idCountMap: Record<string, number> = {};
          const newParagraphs = (nodeResult.paragraphs || nodeResult.shots || []).map((p: any, idx: number) => {
            const baseId = p.id || p.shotId || `para_${idx}`;
            const count = (idCountMap[baseId] || 0) + 1;
            idCountMap[baseId] = count;
            return { id: count > 1 ? `${baseId}_${idx}` : baseId, text: p.text || p.content || p.narration || "", shotId: p.shotId, duration: p.duration, emotion: p.emotion || "", editing: false };
          });
          const diffs = diffParagraphs(state.scriptParagraphs, newParagraphs);
          setScriptParagraphs(applyDiffUpdate(state.scriptParagraphs, diffs));
        } else { mapPipelineResultToState(rawData, useStore.getState()); }
      }
      state.setStepCompleted(3, true);
      state.setStepStatus(3, "completed");
    } catch (err: any) {
      state.setStepStatus(3, "failed");
      state.setPipelineError(err?.message || "文案生成失败");
    } finally {
      state.setPipelineRunning(false);
    }
  }, []);

  const handleMatchVision = useCallback((_paragraphId: string) => {
    // delegated to bidirectionalMatcher utility if available
  }, []);

  return (
    <StepScriptGenerationView
      scriptParagraphs={scriptParagraphs} scriptStyle={scriptStyle} speechRate={speechRate}
      pipelineParams={pipelineParams} vlmFrames={vlmFrames} isGenerating={pipelineRunning}
      onSetScriptStyle={setScriptStyle} onSetSpeechRate={setSpeechRate}
      onSetPipelineParams={setPipelineParams} onUpdateParagraph={updateScriptParagraph}
      onUpdateParagraphEmotion={updateParagraphEmotion} onSetScriptParagraphs={setScriptParagraphs}
      onRegenerate={handleRegenerate} onMatchVision={handleMatchVision}
    />
  );
};