// Module: pipeline/step3-script - Container
// @migrated 阶段三：从 useStore → useStep3Store + useStep2Store + usePipelineStore + useProjectStore
// 阶段四：移除 mapPipelineResultToState 的 useStore fallback

import React, { useCallback } from "react";
import { useStep3Store } from "../../stores/useStep3Store";
import { useStep2Store } from "../../stores/useStep2Store";
import { useStep1Store } from "../../stores/useStep1Store";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { API } from "@renderer/api";
import { mapPipelineResultToState } from "@modules/editor/shell/frontend/hooks/usePipelineResultMapper";
import { buildMappers } from "@modules/editor/shell/frontend/hooks/usePipelineOrchestrator";
import { STEP_SEQUENCES } from "@modules/editor/shell/utils/pipelineConstants";
import { diffParagraphs, applyDiffUpdate } from "@modules/editor/shell/utils/scriptDiffTree";
import { StepScriptGenerationView } from "./View";
import { breakLongParagraphs } from "./breakLongParagraphs";

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
            // 🎭 P0 修复：透传 vlmFrames 完整数据（含 downstream 结构化字段），与 executeStep 保持一致的参数注入
            frames: step2State.vlmFrames || [],
          },
          // 🎭 P0 修复：注入 audioResult（ASR 台词）与 roles（统一人物名），与 executeStep 保持一致
          audioResult: {
            lines: useStep1Store.getState().asrLines || [],
          },
          roles: projectState.roles || [],
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
              /** 🎭 P1 角色组合匹配：透传步骤3 生成的角色名单，供爆破切分器子句继承 */
              characters: Array.isArray(p.characters) ? p.characters
                : (Array.isArray(p.anchoredCharacters) ? p.anchoredCharacters : undefined),
              /** 🎯 P3 画面意图：透传步骤3 生成的画面意图描述，供爆破切分器子句继承 */
              visualIntent: p.visualIntent || "",
              /** 🎯 P3 时间轴锚定：透传对应 chunk 的时间起点/时长（ms），供步骤5 锚定切片 */
              startMs: p.startMs,
              durationMs: p.durationMs,
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

      // 🔧 修复：重新生成后持久化步骤3状态与文案，避免只改内存、重开项目后丢失
      // 旧版 bug：handleRegenerate 只更新了内存中的 scriptParagraphs 与 stepStatuses，
      //           未调用 saveData，导致 DB 中 scriptParagraphs 仍是旧文案，重启/重开即丢失。
      const finalStep3State = useStep3Store.getState();
      const finalProjectState = useProjectStore.getState();
      if (finalProjectState.projectId) {
        try {
          await API.project.saveData(finalProjectState.projectId, {
            scriptParagraphs: finalStep3State.scriptParagraphs,
            scriptStyle: finalStep3State.scriptStyle,
            speechRate: finalStep3State.speechRate,
            pipelineParams: finalStep3State.pipelineParams,
            stepStatuses: pipelineState.stepStatuses,
            stepCompleted: pipelineState.stepCompleted,
          });
        } catch (saveErr) {
          console.error("[步骤3] 重新生成后落盘失败:", saveErr);
        }
      }
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
