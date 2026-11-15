// Module: pipeline/step3-script - Container
// @migrated 阶段三：从 useStore → useStep3Store + usePipelineStore + useProjectStore
// 阶段四：移除 mapPipelineResultToState 的 useStore fallback

import React, { useCallback, useEffect, useRef } from "react";
import type { PipelineParams } from "../../../../shared/types/entities/editor";
import type { StylePack } from "../../../../shared/types/entities/stylePack";
import { useStep3Store } from "../../stores/useStep3Store";
import { useStep2Store } from "../../stores/useStep2Store";
import { usePipelineStore } from "@renderer/store/usePipelineStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import { API } from "@renderer/api";
import { runStep } from "@modules/editor/shell/utils/pipelineStepRunner";
import { touchArtifact } from "@modules/editor/shell/utils/pipelineArtifactState";
import { StepScriptGenerationView } from "./View";

export const StepScriptGeneration: React.FC = () => {
  const scriptParagraphs = useStep3Store((s) => s.scriptParagraphs);
  // 段落卡「匹配画面帧」的候选帧来源（步骤2 VLM 产物）
  const vlmFrames = useStep2Store((s) => s.vlmFrames);
  const scriptStyle = useStep3Store((s) => s.scriptStyle);
  const speechRate = useStep3Store((s) => s.speechRate);
  const pipelineParams = useStep3Store((s) => s.pipelineParams);
  const stylePack = useStep3Store((s) => s.stylePack);
  const streamMeta = useStep3Store((s) => s.streamMeta);
  const setSpeechRate = useStep3Store((s) => s.setSpeechRate);
  const setScriptStyle = useStep3Store((s) => s.setScriptStyle);
  const setPipelineParams = useStep3Store((s) => s.setPipelineParams);
  const setStylePack = useStep3Store((s) => s.setStylePack);
  const updateScriptParagraph = useStep3Store((s) => s.updateScriptParagraph);
  const setScriptParagraphs = useStep3Store((s) => s.setScriptParagraphs);

  // P2：运行态只看步骤3 自己，避免步骤2/4/5 运行时本步按钮也误显示「生成中」
  const step3Running = usePipelineStore((s) => s.stepStatuses[2] === 'running');

  /** 🎫 阶段4：段落文案/情绪手工编辑 = 产物3 被人工修订；防抖后 touchArtifact('3')，
   *  rev3+1 并让步骤4/5 自动过期（语音与匹配必须重跑）。 */
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTouchRef = useRef(false);
  const flushParagraphTouch = useCallback(() => {
    if (!pendingTouchRef.current) return;
    pendingTouchRef.current = false;
    void touchArtifact('3');
  }, []);
  const scheduleParagraphTouch = useCallback(() => {
    pendingTouchRef.current = true;
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    touchTimerRef.current = setTimeout(() => {
      touchTimerRef.current = null;
      flushParagraphTouch();
    }, 800);
  }, [flushParagraphTouch]);

  const handleUpdateParagraph = useCallback(
    (...args: Parameters<typeof updateScriptParagraph>) => {
      updateScriptParagraph(...args);
      scheduleParagraphTouch();
    },
    [updateScriptParagraph, scheduleParagraphTouch],
  );

  const updateParagraphEmotion = useCallback((paragraphId: string, emotion: string) => {
    const step3State = useStep3Store.getState();
    setScriptParagraphs(step3State.scriptParagraphs.map((p) => (p.id === paragraphId ? { ...p, emotion } : p)));
    scheduleParagraphTouch();
  }, [setScriptParagraphs, scheduleParagraphTouch]);

  const handleRegenerate = useCallback(async () => {
    // 统一执行入口：清空/快照/失效/执行/后处理/版本提交全部由 runner 负责
    await runStep(3, { force: true });
  }, []);

  // ── 步骤3 参数即时持久化 ──
  // 根因：pipelineParams / scriptStyle / speechRate 此前只在管线执行/重新生成时落盘，
  //       用户仅修改参数（填时长、切调性预设、换风格）不点生成就切走/关窗 → DB 从未写入新值 → 重进项目回退默认。
  // 修复：三类参数任一变更即防抖落盘；自定义秒数输入框 onChange 连续触发，故 500ms 合并后一次性写入。
  // 🔧 speechRate 必须同批落盘：调性预设切档会同步改写语速（View.handleVibePresetChange），
  //    若只写 pipelineParams，重进项目会得到「预设=epic/0.8 但语速仍是旧的 4.5」的分裂态。
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushStep3Params = useCallback(() => {
    const projectId = useProjectStore.getState().projectId;
    if (!projectId) return;
    const s3 = useStep3Store.getState();
    API.project.saveData(projectId, {
      pipelineParams: s3.pipelineParams,
      speechRate: s3.speechRate,
      scriptStyle: s3.scriptStyle,
      stylePack: s3.stylePack,
    }).catch((err) => {
      console.error("[步骤3] 参数落盘失败:", err);
    });
  }, []);
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    // 落盘 store 归一化后的最终态：setPipelineParams 内做 SSOT 兼容迁移
    // （audioStrategy 缺失回填默认档并同步 narrationRatio 镜像），确保 DB 持久化值
    // 与 UI 展示、后端 DR 折减三处口径一致，legacy 残留值（如 narrationRatio=0.85）随
    // 任一次参数变更即被修复，不会在重开项目后再次回退成旧值。
    saveTimerRef.current = setTimeout(flushStep3Params, 500);
  }, [flushStep3Params]);
  const handleSetPipelineParams = useCallback((params: PipelineParams) => {
    setPipelineParams(params);
    scheduleSave();
  }, [setPipelineParams, scheduleSave]);
  const handleSetSpeechRate = useCallback((rate: number) => {
    setSpeechRate(rate);
    scheduleSave();
  }, [setSpeechRate, scheduleSave]);
  const handleSetScriptStyle = useCallback((style: string) => {
    setScriptStyle(style);
    scheduleSave();
  }, [setScriptStyle, scheduleSave]);
  const handleSetStylePack = useCallback((pack: StylePack) => {
    setStylePack(pack);
    scheduleSave();
  }, [setStylePack, scheduleSave]);
  // 组件卸载时清理未触发的防抖定时器，避免泄漏；段落编辑的版本提交需在卸载前冲刷
  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (touchTimerRef.current) {
      clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
    flushParagraphTouch();
  }, [flushParagraphTouch]);

  return (
    <StepScriptGenerationView
      scriptParagraphs={scriptParagraphs}
      vlmFrames={vlmFrames}
      scriptStyle={scriptStyle}
      speechRate={speechRate}
      pipelineParams={pipelineParams}
      stylePack={stylePack}
      isGenerating={step3Running}
      streamMeta={streamMeta}
      onSetSpeechRate={handleSetSpeechRate}
      onSetScriptStyle={handleSetScriptStyle}
      onSetStylePack={handleSetStylePack}
      onSetPipelineParams={handleSetPipelineParams}
      onUpdateParagraph={handleUpdateParagraph}
      onUpdateParagraphEmotion={updateParagraphEmotion}
      onSetScriptParagraphs={setScriptParagraphs}
      onRegenerate={handleRegenerate}
    />
  );
};
