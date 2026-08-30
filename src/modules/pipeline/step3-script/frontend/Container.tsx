// Module: pipeline/step3-script - Container
// @migrated 阶段三：从 useStore → useStep3Store + useStep2Store + usePipelineStore + useProjectStore
// 阶段四：移除 mapPipelineResultToState 的 useStore fallback

import React, { useCallback, useEffect, useRef } from "react";
import type { PipelineParams } from "../../../../shared/types/entities/editor";
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
// 判别联合契约唯一净化入口：renderer「重新生成」路径的段落同样必须过 Normalizer
import { normalizeScriptParagraph } from "../../../../shared/utils/normalizeScriptParagraph";

export const StepScriptGeneration: React.FC = () => {
  const scriptParagraphs = useStep3Store((s) => s.scriptParagraphs);
  const speechRate = useStep3Store((s) => s.speechRate);
  const pipelineParams = useStep3Store((s) => s.pipelineParams);
  const streamMeta = useStep3Store((s) => s.streamMeta);
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
    // 🔧 重新生成前先清空旧文案：避免旧文案残留显示；若本次生成失败，UI 显示空（符合"错就错"原则，
    //   不让失败被旧文案 + completed 状态掩盖）。旧文案已持久化在 DB，可随时再生成恢复。
    setScriptParagraphs([]);
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
          /** ✅ 身份键统一：段落主键 id 出生处(ScriptGenStrategy)已强制全局唯一，此层仅透传、
           *  不再做任何去重/追加后缀（删除了旧 idCountMap 兜底）。 */
          const rawParagraphs = (nodeResult.paragraphs || nodeResult.shots || []).map((p: any) => {
            return {
              id: p.id,
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
          // 爆破切分器拆分超长段落后，统一过 Normalizer 净化为判别联合契约
          // （补齐 type / 毫秒时间轴，editing 布尔由 Normalizer narration 分支透传保留）
          const newParagraphs = breakLongParagraphs(rawParagraphs).map(
            (p) => normalizeScriptParagraph({ ...p, editing: false })
          );
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

  // ── 步骤3 参数即时持久化 ──
  // 根因：pipelineParams（含目标时长 targetDurationSec）此前只在管线执行/重新生成时落盘，
  //       用户仅修改参数（如填时长）不点生成就切走/关窗 → DB 从未写入新值 → 重进项目回退默认。
  // 修复：修改参数即防抖落盘；自定义秒数输入框 onChange 连续触发，故 500ms 合并后一次性写入。
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPipelineParams = useCallback((params: PipelineParams) => {
    const projectId = useProjectStore.getState().projectId;
    if (!projectId) return;
    API.project.saveData(projectId, { pipelineParams: params }).catch((err) => {
      console.error("[步骤3] 参数落盘失败:", err);
    });
  }, []);
  const handleSetPipelineParams = useCallback((params: PipelineParams) => {
    setPipelineParams(params);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    // 落盘 store 归一化后的最终态：setPipelineParams 内做 SSOT 兼容迁移
    // （audioStrategy 缺失回填默认档并同步 narrationRatio 镜像），确保 DB 持久化值
    // 与 UI 展示、后端 DR 折减三处口径一致，legacy 残留值（如 narrationRatio=0.85）随
    // 任一次参数变更即被修复，不会在重开项目后再次回退成旧值。
    saveTimerRef.current = setTimeout(() => flushPipelineParams(useStep3Store.getState().pipelineParams), 500);
  }, [setPipelineParams, flushPipelineParams]);
  // 组件卸载时清理未触发的防抖定时器，避免泄漏
  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  return (
    <StepScriptGenerationView
      scriptParagraphs={scriptParagraphs}
      speechRate={speechRate}
      pipelineParams={pipelineParams}
      vlmFrames={vlmFrames}
      isGenerating={pipelineRunning}
      streamMeta={streamMeta}
      onSetSpeechRate={setSpeechRate}
      onSetPipelineParams={handleSetPipelineParams}
      onUpdateParagraph={updateScriptParagraph}
      onUpdateParagraphEmotion={updateParagraphEmotion}
      onSetScriptParagraphs={setScriptParagraphs}
      onRegenerate={handleRegenerate}
      onMatchVision={handleMatchVision}
    />
  );
};
