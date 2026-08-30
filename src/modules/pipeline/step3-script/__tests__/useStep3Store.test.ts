// 📁 路径: src/modules/pipeline/step3-script/__tests__/useStep3Store.test.ts
// useStep3Store.setPipelineParams SSOT 兼容迁移回归测试
// 覆盖根因：legacy 老工程无 audioStrategy 字段、narrationRatio 残留旧值（如 0.85），
// 导致档位按钮（按 audioStrategy 默认档推导 70%）与右上角徽标（直接读 narrationRatio 85%）显示分叉。
// 修复后 audioStrategy 为唯一数据源：缺失即回填默认档 smart_keep 并强制同步 narrationRatio 镜像值。

import { describe, it, expect, beforeEach } from 'vitest';
import { useStep3Store } from '../../stores/useStep3Store';

describe('useStep3Store - setPipelineParams SSOT 兼容迁移', () => {
  beforeEach(() => {
    // zustand store 为模块级单例，跨用例必须 reset 清理，避免状态污染
    useStep3Store.getState().reset();
  });

  it('legacy 数据（无 audioStrategy，narrationRatio 残留 0.85）应归一化为 smart_keep/0.70', () => {
    useStep3Store.getState().setPipelineParams({
      narrativePerspective: 'third',
      narrationRatio: 0.85, // 旧值残留（根因：无 audioStrategy 时的历史值）
      rhythmMode: 'mixed',
      emotionTone: 'neutral',
      hookIntensity: 0.7,
    });
    const pp = useStep3Store.getState().pipelineParams;
    expect(pp.audioStrategy).toBe('smart_keep');
    expect(pp.narrationRatio).toBe(0.7);
  });

  it('切到纯解说档（pure_narration）应同步 narrationRatio=0.85（覆盖传入的旧值）', () => {
    useStep3Store.getState().setPipelineParams({
      narrativePerspective: 'third',
      audioStrategy: 'pure_narration',
      narrationRatio: 0.7, // 即便传入不匹配旧值，也应被映射表锁定为 0.85
      rhythmMode: 'mixed',
      emotionTone: 'neutral',
      hookIntensity: 0.7,
    });
    const pp = useStep3Store.getState().pipelineParams;
    expect(pp.audioStrategy).toBe('pure_narration');
    expect(pp.narrationRatio).toBe(0.85);
  });

  it('切到原声主打档（original_focus）应同步 narrationRatio=0.35', () => {
    useStep3Store.getState().setPipelineParams({
      narrativePerspective: 'third',
      audioStrategy: 'original_focus',
      narrationRatio: 1,
      rhythmMode: 'mixed',
      emotionTone: 'neutral',
      hookIntensity: 0.7,
    });
    const pp = useStep3Store.getState().pipelineParams;
    expect(pp.audioStrategy).toBe('original_focus');
    expect(pp.narrationRatio).toBe(0.35);
  });

  it('合法带 audioStrategy 的数据应保持原档并锁定镜像值', () => {
    useStep3Store.getState().setPipelineParams({
      narrativePerspective: 'third',
      audioStrategy: 'smart_keep',
      narrationRatio: 0.7,
      rhythmMode: 'mixed',
      emotionTone: 'neutral',
      hookIntensity: 0.7,
    });
    const pp = useStep3Store.getState().pipelineParams;
    expect(pp.audioStrategy).toBe('smart_keep');
    expect(pp.narrationRatio).toBe(0.7);
  });
});
