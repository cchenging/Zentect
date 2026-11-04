// Module: editor/shell/utils/invalidateDownstreamSteps - 单元测试
// P0 回归：重跑上游步骤必须级联清空下游结果并把下游状态回退为 idle，
// 否则自动流水线会因下游「completed」直接跳过，产出「新文案 + 旧配音 + 旧匹配」的错片。

import { describe, it, expect, beforeEach } from 'vitest';
import { invalidateDownstreamSteps, invalidateStep1SubSteps } from '../invalidateDownstreamSteps';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';

const seedUpstreamAndDownstream = () => {
  // 上游产物保留（这里只验证下游，不关心上游内容）
  useStep2Store.getState().setVlmFrames([{ description: '画面' } as never]);
  useStep3Store.getState().setScriptParagraphs([{ id: 'p1' } as never]);
  // 下游：配音 / 匹配 / 切片 / 诊断 / BGM 均已有结果
  useStep4Store.getState().setTtsResults([{ paragraphId: 'p1' } as never]);
  const step5 = useStep5Store.getState();
  step5.setMatchResults([{ id: 'p1' } as never]);
  step5.setVideoChunks([{ id: 'c1' } as never]);
  step5.setMatchDiagnostics({ warnings: ['切片池为空'] });
  step5.setActiveBgm({ name: 'bgm' } as never);
  step5.setBeatTimestamps([0, 2]);

  // 全链路标记为已完成（复现「自动流水线跳过下游」的前置条件）
  const pipeline = usePipelineStore.getState();
  for (let s = 1; s <= 5; s++) {
    pipeline.setStepStatus(s, 'completed');
    pipeline.setStepCompleted(s, true);
  }
};

describe('invalidateDownstreamSteps', () => {
  beforeEach(() => {
    usePipelineStore.getState().reset();
    useStep2Store.getState().reset();
    useStep3Store.getState().reset();
    useStep4Store.getState().reset();
    useStep5Store.getState().reset();
    seedUpstreamAndDownstream();
  });

  it('step=1 清空步骤2 的 vlmFrames，且 2..5 回退为 idle', () => {
    invalidateDownstreamSteps(1);

    expect(useStep2Store.getState().vlmFrames).toHaveLength(0);
    expect(useStep3Store.getState().scriptParagraphs).toHaveLength(0);
    expect(useStep4Store.getState().ttsResults).toHaveLength(0);
    expect(useStep5Store.getState().matchResults).toHaveLength(0);

    const { stepStatuses, stepCompleted } = usePipelineStore.getState();
    for (let i = 1; i <= 4; i++) {
      expect(stepStatuses[i]).toBe('idle');
      expect(stepCompleted[i]).toBe(false);
    }
    // 步骤1 自身不受影响
    expect(stepStatuses[0]).toBe('completed');
    expect(stepCompleted[0]).toBe(true);
  });

  it('步骤1 音频配置变更：只重置 audio/whisper，保留 vlmFrames 与步骤2', () => {
    const pipeline = usePipelineStore.getState();
    pipeline.setSubStepStatus('frames', 'completed');
    pipeline.setSubStepStatus('audio', 'completed');
    pipeline.setSubStepStatus('whisper', 'completed');
    pipeline.setSubStepStatus('faces', 'completed');

    invalidateStep1SubSteps(['audio', 'whisper'], 2);

    const ps = usePipelineStore.getState();
    expect(ps.subStepStatuses.frames).toBe('completed');
    expect(ps.subStepStatuses.faces).toBe('completed');
    expect(ps.subStepStatuses.audio).toBe('idle');
    expect(ps.subStepStatuses.whisper).toBe('idle');
    // 步骤2 只看画面，保留 vlmFrames；步骤3 及以后作废
    expect(useStep2Store.getState().vlmFrames).toHaveLength(1);
    expect(useStep3Store.getState().scriptParagraphs).toHaveLength(0);
    expect(useStep4Store.getState().ttsResults).toHaveLength(0);
    expect(ps.stepStatuses[1]).toBe('completed');
    expect(ps.stepStatuses[2]).toBe('idle');
  });

  it('步骤1 抽帧配置变更：重置 frames 且清空 vlmFrames 及其下游', () => {
    invalidateStep1SubSteps(['frames'], 1);

    const ps = usePipelineStore.getState();
    expect(ps.subStepStatuses.frames).toBe('idle');
    expect(ps.subStepProgresses.frames).toBe(0);
    expect(useStep2Store.getState().vlmFrames).toHaveLength(0);
    expect(useStep3Store.getState().scriptParagraphs).toHaveLength(0);
    expect(ps.stepStatuses[0]).toBe('idle');
    expect(ps.stepCompleted[0]).toBe(false);
  });

  it('step=3 清空 ttsResults / matchResults / videoChunks / 诊断，且 4、5 回退为 idle', () => {
    invalidateDownstreamSteps(3);

    expect(useStep3Store.getState().scriptParagraphs).toHaveLength(1);
    expect(useStep4Store.getState().ttsResults).toHaveLength(0);
    expect(useStep5Store.getState().matchResults).toHaveLength(0);
    expect(useStep5Store.getState().videoChunks).toHaveLength(0);
    expect(useStep5Store.getState().matchDiagnostics).toBeNull();

    const { stepStatuses, stepCompleted } = usePipelineStore.getState();
    expect(stepStatuses[2]).toBe('completed');
    expect(stepCompleted[2]).toBe(true);
    expect(stepStatuses[3]).toBe('idle');
    expect(stepStatuses[4]).toBe('idle');
    expect(stepCompleted[3]).toBe(false);
    expect(stepCompleted[4]).toBe(false);
  });

  it('step=4 只失效步骤5，保留 ttsResults', () => {
    invalidateDownstreamSteps(4);

    expect(useStep4Store.getState().ttsResults).toHaveLength(1);
    expect(useStep5Store.getState().matchResults).toHaveLength(0);
    expect(useStep5Store.getState().videoChunks).toHaveLength(0);
    expect(useStep5Store.getState().matchDiagnostics).toBeNull();

    const { stepStatuses, stepCompleted } = usePipelineStore.getState();
    expect(stepStatuses[3]).toBe('completed');
    expect(stepStatuses[4]).toBe('idle');
    expect(stepCompleted[4]).toBe(false);
  });

  it('step=2 一并清空步骤3 的 scriptParagraphs', () => {
    invalidateDownstreamSteps(2);

    expect(useStep3Store.getState().scriptParagraphs).toHaveLength(0);
    expect(useStep4Store.getState().ttsResults).toHaveLength(0);
    expect(useStep5Store.getState().matchResults).toHaveLength(0);
  });

  it('step=5 无下游，不做任何失效', () => {
    invalidateDownstreamSteps(5);

    expect(useStep4Store.getState().ttsResults).toHaveLength(1);
    expect(useStep5Store.getState().matchResults).toHaveLength(1);
    expect(useStep5Store.getState().videoChunks).toHaveLength(1);
    expect(usePipelineStore.getState().stepCompleted[4]).toBe(true);
  });
});
