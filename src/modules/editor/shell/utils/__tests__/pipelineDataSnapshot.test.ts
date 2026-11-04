// Module: editor/shell/utils/pipelineDataSnapshot - 单元测试
// 🛡️ P2 回归：步骤执行失败时不能抹掉上一次可用的下游结果；
// 但只恢复数据，不恢复完成标记（失败步骤及其下游仍需重跑）。

import { describe, it, expect, beforeEach } from 'vitest';
import { capturePipelineDataSnapshot, restorePipelineDataSnapshot } from '../pipelineDataSnapshot';
import { invalidateDownstreamSteps } from '../invalidateDownstreamSteps';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';

const seedResults = () => {
  useStep2Store.getState().setVlmFrames([{ description: '画面' } as never]);
  useStep3Store.getState().setScriptParagraphs([{ id: 'p1' } as never]);
  useStep4Store.getState().setTtsResults([{ paragraphId: 'p1' } as never]);
  const step5 = useStep5Store.getState();
  step5.setMatchResults([{ id: 'p1' } as never]);
  step5.setVideoChunks([{ id: 'c1' } as never]);
  step5.setMatchDiagnostics({ warnings: ['切片池为空'] });

  const pipeline = usePipelineStore.getState();
  for (let s = 1; s <= 5; s++) {
    pipeline.setStepStatus(s, 'completed');
    pipeline.setStepCompleted(s, true);
  }
};

describe('pipelineDataSnapshot', () => {
  beforeEach(() => {
    usePipelineStore.getState().reset();
    useStep2Store.getState().reset();
    useStep3Store.getState().reset();
    useStep4Store.getState().reset();
    useStep5Store.getState().reset();
    seedResults();
  });

  it('失败恢复：下游结果回到执行前，但完成标记保持失效', () => {
    const snap = capturePipelineDataSnapshot();

    // 模拟重跑步骤3：级联清空下游数据 + 回退完成标记
    invalidateDownstreamSteps(3);
    expect(useStep4Store.getState().ttsResults).toHaveLength(0);
    expect(useStep5Store.getState().matchResults).toHaveLength(0);
    expect(usePipelineStore.getState().stepCompleted[3]).toBe(false);

    // 模拟执行失败：恢复数据
    restorePipelineDataSnapshot(snap);

    expect(useStep4Store.getState().ttsResults).toHaveLength(1);
    expect(useStep5Store.getState().matchResults).toHaveLength(1);
    expect(useStep5Store.getState().videoChunks).toHaveLength(1);
    expect(useStep5Store.getState().matchDiagnostics).toEqual({ warnings: ['切片池为空'] });
    // 数据回来了，但完成标记不能回：步骤4/5 仍需重跑
    expect(usePipelineStore.getState().stepCompleted[3]).toBe(false);
    expect(usePipelineStore.getState().stepCompleted[4]).toBe(false);
  });

  it('执行前本就没有结果：恢复后仍为空，不产生脏数据', () => {
    useStep4Store.getState().setTtsResults([]);
    const step5 = useStep5Store.getState();
    step5.setMatchResults([]);
    step5.setVideoChunks([]);
    step5.setMatchDiagnostics(null);

    const snap = capturePipelineDataSnapshot();
    // 执行过程中写入了半成品
    useStep4Store.getState().setTtsResults([{ paragraphId: 'p1' } as never]);
    step5.setMatchResults([{ id: 'p1' } as never]);

    restorePipelineDataSnapshot(snap);

    expect(useStep4Store.getState().ttsResults).toHaveLength(0);
    expect(useStep5Store.getState().matchResults).toHaveLength(0);
    expect(useStep5Store.getState().matchDiagnostics).toBeNull();
  });
});
