// Module: editor/shell/utils/pipelineDataSnapshot
// 🛡️ P2：步骤执行失败时不要丢掉上一次可用的结果。
//
// 执行步骤前先快照下游数据；失败时把数据放回。
// 注意：只恢复数据、不恢复完成标记 —— 失败步骤及其下游仍是 failed/idle，
// 必须重跑，避免旧结果被当成新结果自动流转/导出。

import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';

export interface PipelineDataSnapshot {
  vlmFrames: ReturnType<typeof useStep2Store.getState>['vlmFrames'];
  scriptParagraphs: ReturnType<typeof useStep3Store.getState>['scriptParagraphs'];
  ttsResults: ReturnType<typeof useStep4Store.getState>['ttsResults'];
  matchResults: ReturnType<typeof useStep5Store.getState>['matchResults'];
  videoChunks: ReturnType<typeof useStep5Store.getState>['videoChunks'];
  matchDiagnostics: ReturnType<typeof useStep5Store.getState>['matchDiagnostics'];
}

/** 执行前快照当前内存中的全部下游结果 */
export function capturePipelineDataSnapshot(): PipelineDataSnapshot {
  const s2 = useStep2Store.getState();
  const s3 = useStep3Store.getState();
  const s4 = useStep4Store.getState();
  const s5 = useStep5Store.getState();
  return {
    vlmFrames: s2.vlmFrames,
    scriptParagraphs: s3.scriptParagraphs,
    ttsResults: s4.ttsResults,
    matchResults: s5.matchResults,
    videoChunks: s5.videoChunks,
    matchDiagnostics: s5.matchDiagnostics,
  };
}

/** 失败时恢复快照（只恢复数据，不改状态标记） */
export function restorePipelineDataSnapshot(snap: PipelineDataSnapshot): void {
  useStep2Store.getState().setVlmFrames(snap.vlmFrames);
  useStep3Store.getState().setScriptParagraphs(snap.scriptParagraphs);
  useStep4Store.getState().setTtsResults(snap.ttsResults);
  const s5 = useStep5Store.getState();
  s5.setMatchResults(snap.matchResults);
  s5.setVideoChunks(snap.videoChunks);
  s5.setMatchDiagnostics(snap.matchDiagnostics);
}
