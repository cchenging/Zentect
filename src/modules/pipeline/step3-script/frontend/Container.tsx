// Module: pipeline/step3-script - Container
// @migrated 阶段三：从 useStore → useStep3Store + useStep2Store + usePipelineStore + useProjectStore
// 阶段四：移除 mapPipelineResultToState 的 useStore fallback

import React, { useCallback } from "react";
import { useStep3Store } from "../../stores/useStep3Store";
import { useStep2Store } from "../../stores/useStep2Store";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { API } from "@renderer/api";
import { mapPipelineResultToState } from "@modules/editor/shell/frontend/hooks/usePipelineResultMapper";
import { buildMappers } from "@modules/editor/shell/frontend/hooks/usePipelineOrchestrator";
import { STEP_SEQUENCES } from "@modules/editor/shell/utils/pipelineConstants";
import { diffParagraphs, applyDiffUpdate } from "@modules/editor/shell/utils/scriptDiffTree";
import { StepScriptGenerationView } from "./View";

/**
 * 爆破切分器：将超过 18 字的长段落按标点符号自动拆分为爆款微短句
 * 防止 LLM 偶发输出长段落导致 TTS 朗读超时与画面张冠李戴
 * @param rawShots LLM 原始返回的分镜数组
 * @returns 拆分后的短句分镜数组（每个子句至少 1.2 秒）
 */
function breakLongParagraphs(
  rawShots: Array<{ id?: string; shotId?: string; text?: string; duration?: number; emotion?: string }>
): Array<{ id: string; shotId?: string; text: string; duration: number; emotion?: string }> {
  const result: Array<{ id: string; shotId?: string; text: string; duration: number; emotion?: string }> = [];

  rawShots.forEach((p, idx) => {
    const rawText = (p.text || "").trim();
    const baseDuration = p.duration || 3;

    // 字数 <= 18 已是短句，直接保留
    if (rawText.length <= 18) {
      result.push({
        id: p.id || p.shotId || `para_${idx}`,
        shotId: p.shotId,
        text: rawText,
        duration: baseDuration,
        emotion: p.emotion || "",
      });
      return;
    }

    // 字数 > 18，按标点（逗号/句号/感叹号/问号/分号）微拆分
    const sentences = rawText
      .split(/([，,！!？?；;。])/)
      .reduce((acc: string[], val, i, arr) => {
        if (i % 2 === 0) {
          const nextPunct = arr[i + 1] || "";
          if (val.trim()) acc.push(val.trim() + nextPunct);
        }
        return acc;
      }, [])
      .filter((s) => s.length > 0);

    // 按字数比例分配时长，每个子句至少 1.2 秒
    const totalChars = rawText.length || 1;
    const subParagraphs = sentences.map((sent, sIdx) => {
      const subDuration = parseFloat(((sent.length / totalChars) * baseDuration).toFixed(1));
      return {
        id: `${p.id || p.shotId || `para_${idx}`}_sub_${sIdx + 1}`,
        shotId: p.shotId,
        text: sent,
        duration: Math.max(1.2, subDuration),
        emotion: p.emotion || "",
      };
    });
    // 归一化缩放：若 1.2s 保底导致子句总时长 > 父时长，按比例缩放回父时长
    const rawTotalDuration = subParagraphs.reduce((sum, s) => sum + s.duration, 0);
    if (rawTotalDuration > baseDuration) {
      subParagraphs.forEach((sub) => {
        sub.duration = parseFloat(((sub.duration / rawTotalDuration) * baseDuration).toFixed(1));
      });
    }
    result.push(...subParagraphs);
  });

  return result;
}

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
    // 🔧 修复：resetPipeline 必须在 setPipelineRunning(true) 之前调用
    // 旧版 bug：resetPipeline 内部 set({ pipelineRunning: false }) 把刚设的 true 覆盖回 false
    pipelineState.resetPipeline();
    pipelineState.setStepStatus(3, "running");
    pipelineState.setPipelineRunning(true);
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
          const rawParagraphs = (nodeResult.paragraphs || nodeResult.shots || []).map((p: any, idx: number) => {
            const baseId = p.id || p.shotId || `para_${idx}`;
            const count = (idCountMap[baseId] || 0) + 1;
            idCountMap[baseId] = count;
            return {
              id: count > 1 ? `${baseId}_${idx}` : baseId,
              text: p.text || p.content || p.narration || "",
              shotId: p.shotId,
              duration: p.duration,
              emotion: p.emotion || "",
            };
          });
          // 爆破切分器：将超长段落按标点拆分为卡点短句，再补充 editing 状态
          const newParagraphs = breakLongParagraphs(rawParagraphs).map((p) => ({
            ...p,
            editing: false,
          }));
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
