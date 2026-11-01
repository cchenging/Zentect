// Module: editor/shell/utils/persistSnapshot
// 项目管线状态快照持久化 — 统一落盘入口
//
// 💥 根因修复：步骤4（handleSynthesize）与步骤5（handleRematch）是独立执行流程，
//   完成后只更新内存 store，从不调用 saveData 落盘 → SQLite 里步骤状态永远是旧值，
//   重开项目步骤状态回退（如步骤4从 completed 变回 idle，导致无法进入步骤5）。
//
//   这里把 executeStep 的落盘逻辑抽取为单一入口 persistProjectSnapshot，
//   三个执行路径（executeStep / handleSynthesize / handleRematch）统一调用，
//   保证"内存完成 → SQLite 落盘"一条龙，杜绝状态丢失。

import { API } from '@renderer/api';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { useEditorNavStore } from '@modules/editor/stores/useEditorNavStore';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';

/**
 * 将当前内存中的项目管线状态全量落盘到 SQLite。
 * 字段与 executeStep 完工落盘保持一致，saveData 后端按"空值不覆盖"合并。
 * @param projectId 项目 ID
 */
export async function persistProjectSnapshot(projectId: string): Promise<void> {
  const ps = usePipelineStore.getState();
  const currentProjectState = useProjectStore.getState();
  const step1State = useStep1Store.getState();
  const step2Final = useStep2Store.getState();
  const step3Final = useStep3Store.getState();
  const step4Final = useStep4Store.getState();
  const step5Final = useStep5Store.getState();
  const navState = useEditorNavStore.getState();

  /** 🔍 步骤5 落库链路取证：调用点已收敛到 4 处（步骤4/5 独立流程、管线编排器、步骤5 手动改动）。
   *  这里成对打「开始 / 完成(或失败)」，用于区分三种故障形态：
   *  a) 根本没有「开始」→ 上游根本没调用落盘（映射抛异常 / 流程未走到）；
   *  b) 有「开始」无后续 → IPC 卡死或渲染进程被关；
   *  c) 有「完成」但 DB 仍旧值 → 写入的是 store 里的旧值。
   *  仅在携带步骤5结果时打印，避免普通步骤落盘刷屏。 */
  const mrCount = Array.isArray(step5Final.matchResults) ? step5Final.matchResults.length : 0;
  const shouldTrace = mrCount > 0;
  if (shouldTrace) {
    console.info(`[落盘] 开始 项目=${projectId} matchResults=${mrCount} 首条=${step5Final.matchResults[0]?.id ?? ''}`);
  }

  try {
    await API.project.saveData(projectId, {
      shots: currentProjectState.shots,
      aiShots: currentProjectState.aiShots,
      roles: currentProjectState.roles,
      mediaItems: currentProjectState.mediaItems,
      asrLines: step1State.asrLines,
      // 统一数据源：frameCount 从 framePaths 派生，保证存库一致
      frameCount: currentProjectState.extractedData?.framePaths?.length || 0,
      framePaths: currentProjectState.extractedData?.framePaths || [],
      audioSeparated: step1State.audioSeparated,
      subStepStatuses: ps.subStepStatuses,
      subStepProgresses: ps.subStepProgresses,
      subStepTimings: ps.subStepTimings,
      stepStatuses: ps.stepStatuses,
      stepCompleted: ps.stepCompleted,
      currentStep: navState.currentStep,
      extractionConfig: step1State.extractionConfig,
      vlmFrames: step2Final.vlmFrames,
      scriptParagraphs: step3Final.scriptParagraphs,
      scriptStyle: step3Final.scriptStyle,
      speechRate: step3Final.speechRate,
      pipelineParams: step3Final.pipelineParams,
      ttsResults: step4Final.ttsResults,
      ttsEngine: step4Final.ttsEngine,
      ttsVoiceId: step4Final.ttsVoiceId,
      /** 步骤5 数据持久化：匹配结果/切片池/BGM 节拍，重启后从 metadata 恢复 */
      matchResults: step5Final.matchResults,
      videoChunks: step5Final.videoChunks,
      activeBgm: step5Final.activeBgm,
      beatTimestamps: step5Final.beatTimestamps,
      deepRecommendation: step5Final.deepRecommendation,
    });
  } catch (e) {
    /** 兜底取证：调用点各自的 catch 只打自己一句话，若某处漏 log 则落盘失败会完全静默 */
    console.error(`[落盘] 失败 项目=${projectId} matchResults=${mrCount}`, e);
    throw e;
  }

  if (shouldTrace) {
    console.info(`[落盘] 完成 项目=${projectId} matchResults=${mrCount}`);
  }
}