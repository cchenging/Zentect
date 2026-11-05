// Module: editor/shell/utils/invalidateDownstreamSteps
// P0 修复（2026-11-04）：重跑上游步骤时级联失效下游结果与状态。
//
// 背景：旧实现只在步骤3 清空 scriptParagraphs，ttsResults/matchResults 原样保留；
// 自动流水线又因下游「completed」直接跳过，最终静默产出「新文案 + 旧配音 + 旧匹配」的错片
//（字幕与配音不一致、画面时间窗按旧配音时长计算导致节奏错位）。
//
// 约定：只改内存 store，不直接落盘。成功完工时由 persistProjectSnapshot 统一写入
//（空数组同样会被持久化，见 ProjectRepository.saveFullProjectData 的 `if (data.xxx)` 判断）；
// 失败则 DB 保持旧快照，避免误删用户已有结果。

import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';

/**
 * 让 `step` 之后所有步骤的结果与完成标记失效。
 *
 * @param step 正在重跑/即将执行的步骤号（1~5）
 *   - step1 → 失效 2/3/4/5（抽帧/裁剪变化后 vlmFrames 也作废）
 *   - step2 → 失效 3/4/5（vlmFrames 是步骤3 的输入）
 *   - step3 → 失效 4/5
 *   - step4 → 失效 5
 *   - step5 → 无下游，直接返回
 */
export function invalidateDownstreamSteps(step: number): void {
  if (step >= 5) return;

  if (step <= 1) useStep2Store.getState().setVlmFrames([]);
  if (step <= 2) useStep3Store.getState().setScriptParagraphs([]);
  if (step <= 3) useStep4Store.getState().setTtsResults([]);
  if (step <= 4) {
    const step5 = useStep5Store.getState();
    step5.setMatchResults([]);
    step5.setVideoChunks([]);
    step5.setMatchDiagnostics(null);
  }

  const pipeline = usePipelineStore.getState();
  for (let s = step + 1; s <= 5; s++) {
    pipeline.setStepStatus(s, 'idle');
    pipeline.setStepCompleted(s, false);
  }
}
