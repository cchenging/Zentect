// Module: pipeline/step3-script - Container
// @migrated 阶段三：从 useStore → useStep3Store + useStep2Store + usePipelineStore + useProjectStore
// 阶段四：移除 mapPipelineResultToState 的 useStore fallback

import React, { useCallback } from "react";
import { useStep3Store } from "../../stores/useStep3Store";
import { useStep2Store } from "../../stores/useStep2Store";
import { usePipelineStore } from "../../../../renderer/src/store/usePipelineStore";
import { useProjectStore } from "../../../editor/stores/useProjectStore";
import { API } from "../../../../renderer/src/api";
import { mapPipelineResultToState } from "../../../../modules/editor/shell/frontend/hooks/usePipelineResultMapper";
import { buildMappers } from "../../../../modules/editor/shell/frontend/hooks/usePipelineOrchestrator";
import { STEP_SEQUENCES } from "../../../../modules/editor/shell/utils/pipelineConstants";
import { diffParagraphs, applyDiffUpdate } from "../../../../modules/editor/shell/utils/scriptDiffTree";
import { StepScriptGenerationView } from "./View";

export const StepScriptGeneration: React.FC = () => {
  const scriptParagraphs = useStep3Store((s) => s.scriptParagraphs);
  const scriptStyle = useStep3Store((s) => s.scriptStyle);
  const speechRate = useStep3Store((s) => s.speechRate);
  const pipelineParams = useStep3Store((s) => s.pipelineParams);
  const setScriptStyle = useStep3Store((s) => s.setScriptStyle);
  const setSpeechRate = useStep3Store((s) => s.setSpeechRate);
  const setPipelineParams = useStep3Store((s) => s.setPipelineParams);
  const updateScriptParagraph = useStep3Store((s) => s.updateScriptParagraph);
  const setScriptParagraphs = useStep3Store((s) => s.setScriptParagraphs);

  const vlmFrames = useStep2Store((s) => s.vlmFrames);
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);

  const updateParagraphEmotion = useCallback((paragraphId: string, emotion: string) => {
    const step3State = useStep3Store.getState();
    setScriptParagraphs(step3State.scriptParagraphs.map((p) => (p.id === paragraphId ? { ...p, emotion } : p)));
  }, [setScriptParagraphs]);

  const handleRegenerate = useCallback(async () => {
    const projectState = useProjectStore.getState();
    const step3State = useStep3Store.getState();
    const step2State = useStep2Store.getState();
    const pipelineState = usePipelineStore.getState();

    if (!projectState.projectId) return;
    pipelineState.setStepStatus(3, "running");
    pipelineState.setPipelineRunning(true);
    pipelineState.resetPipeline();
    try {
      const sequence = STEP_SEQUENCES[3].map((node: any) => ({
        ...node,
        params: {
          ...(node.params || {}),
          mediaPath: projectState.mediaItems?.[0]?.filePath || "",
          scriptStyle: step3State.scriptStyle || "叙事",
          speechRate: step3State.speechRate || 4.5,
          pipelineParams: step3State.pipelineParams,
          visionResult: {
            sceneDescriptions: step2State.vlmFrames?.map((f: any) => f.description || "").filter(Boolean).join("\n") || "",
          },
        },
      }));
      const result = await API.engine.runPipeline({
        projectId: projectState.projectId,
        sequence,
        sourceMedia: projectState.mediaItems?.[0]?.filePath || "",
      });
      if (result) {
        const rawData = result?.data || result;
        const nodeResult = rawData["script-1"] || rawData["script"] || rawData;
        if (nodeResult) {
          const idCountMap: Record<string, number> = {};
          const newParagraphs = (nodeResult.paragraphs || nodeResult.shots || []).map((p: any, idx: number) => {
            const baseId = p.id || p.shotId || `para_${idx}`;
            const count = (idCountMap[baseId] || 0) + 1;
            idCountMap[baseId] = count;
            return {
              id: count > 1 ? `${baseId}_${idx}` : baseId,
              text: p.text || p.content || p.narration || "",
              shotId: p.shotId,
              duration: p.duration,
              emotion: p.emotion || "",
              editing: false,
            };
          });
          const diffs = diffParagraphs(step3State.scriptParagraphs, newParagraphs);
          setScriptParagraphs(applyDiffUpdate(step3State.scriptParagraphs, diffs));
        } else {
          mapPipelineResultToState(rawData, buildMappers());
        }
      }
      pipelineState.setStepCompleted(3, true);
      pipelineState.setStepStatus(3, "completed");
    } catch (err: any) {
      pipelineState.setStepStatus(3, "failed");
      pipelineState.setPipelineError(err?.message || "文案生成失败");
    } finally {
      pipelineState.setPipelineRunning(false);
    }
  }, [setScriptParagraphs]);

  const handleMatchVision = useCallback((_paragraphId: string) => {
    // delegated to bidirectionalMatcher utility if available
  }, []);

  return (
    <StepScriptGenerationView
      scriptParagraphs={scriptParagraphs}
      scriptStyle={scriptStyle}
      speechRate={speechRate}
      pipelineParams={pipelineParams}
      vlmFrames={vlmFrames}
      isGenerating={pipelineRunning}
      onSetScriptStyle={setScriptStyle}
      onSetSpeechRate={setSpeechRate}
      onSetPipelineParams={setPipelineParams}
      onUpdateParagraph={updateScriptParagraph}
      onUpdateParagraphEmotion={updateParagraphEmotion}
      onSetScriptParagraphs={setScriptParagraphs}
      onRegenerate={handleRegenerate}
      onMatchVision={handleMatchVision}
    />
  );
};
