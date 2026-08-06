// Module: pipeline/step5-match - Container
// @migrated 阶段三：从 useStore → useStep5Store + useProjectStore + usePipelineStore + useStep2Store + useStep3Store + useStep4Store
// 阶段四：移除 mapPipelineResultToState 的 useStore fallback

import React, { useCallback } from "react";
import { useStep5Store } from "../../stores/useStep5Store";
import { useStep1Store } from "../../stores/useStep1Store";
import { useStep2Store } from "../../stores/useStep2Store";
import { useStep3Store } from "../../stores/useStep3Store";
import { useStep4Store } from "../../stores/useStep4Store";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { API } from "@renderer/api";
import { mapPipelineResultToState } from "@modules/editor/shell/frontend/hooks/usePipelineResultMapper";
import { buildMappers } from "@modules/editor/shell/frontend/hooks/usePipelineOrchestrator";
import { STEP_SEQUENCES } from "@modules/editor/shell/utils/pipelineConstants";
import { StepShotMatchingView } from "./View";

export const StepShotMatching: React.FC = () => {
  const matchResults = useStep5Store((s) => s.matchResults);
  const activeBgm = useStep5Store((s) => s.activeBgm);
  const videoChunks = useStep5Store((s) => s.videoChunks);
  const confirmMatch = useStep5Store((s) => s.confirmMatch);
  const setMatchResults = useStep5Store((s) => s.setMatchResults);
  /** 步骤4 配音结果：预览弹窗按 shotId 取音频同步播放 */
  const ttsResults = useStep4Store((s) => s.ttsResults);

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
    const step1State = useStep1Store.getState();
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
          /** ASR 原声时间轴：原声段落（keepOriginalAudio）按原声文本定位原片时间段 */
          asrLines: step1State.asrLines || [],
          /** 步骤2 逐帧 VLM 描述（带时间戳）：按时间轴聚合到切片，做"文案↔切片描述"文本语义匹配（复用已花成本的画面理解，零额外 VLM 调用） */
          frameDescriptions: step2State.vlmFrames
            .map((f: any) => ({
              timeMs: Number(f.timeMs) || 0,
              description: (f.description || '').trim(),
              /** 🎭 P0 意境维度：帧情绪标签（如：紧张/平静/温馨），聚合为切片情绪标签参与 KM 情绪匹配 */
              emotion: (f.emotion || f.downstream?.emotion || '').trim(),
              /** 🎬 帧景别（如：特写/中景/全景），聚合到切片供意境/衔接匹配 */
              shotType: (f.downstream?.shotType || '').trim(),
            }))
            .filter((f) => f.description.length > 0),
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
      ttsResults={ttsResults}
      hasBgm={!!activeBgm}
      isProcessing={pipelineRunning}
      onConfirm={confirmMatch}
      onReplace={handleReplace}
      onRematch={handleRematch}
      onReorder={setMatchResults}
    />
  );
};
