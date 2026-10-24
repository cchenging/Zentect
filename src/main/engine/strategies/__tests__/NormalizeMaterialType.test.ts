// 📁 路径: src/main/engine/strategies/__tests__/NormalizeMaterialType.test.ts
// 🎯 P4 空镜判定：VLM materialType 归一化 + 描述派生兜底（步骤2 入库 / 步骤5 读取两侧共用）
//
// 实测背景（760 帧）：v9 全量重跑后 33 帧缺失 materialType，
// 31 帧描述写着「主体:空镜头」却被模型标成 real ⇒ 单靠 prompt 无法稳定判对，需确定性校正。

import { describe, it, expect } from 'vitest';
import { normalizeMaterialType } from '../VisionExtractStrategy';

describe('P4: normalizeMaterialType 空镜判定归一化', () => {
  it('显式 empty / effect 原样保留（模型给出明确结论就尊重）', () => {
    expect(normalizeMaterialType('empty', '城市夜景', '霓虹灯')).toBe('empty');
    expect(normalizeMaterialType('effect', '画面描述', '人物')).toBe('effect');
    // 显式值优先于描述关键字，避免描述反压模型结论
    expect(normalizeMaterialType('empty', '黑场转场', '')).toBe('empty');
  });

  it('主体写「空镜头」但被误标 real → 校正为 empty', () => {
    expect(normalizeMaterialType('real', '城市夜景静止展示', '空镜头')).toBe('empty');
  });

  it('描述含「无人物/空无一人/仅环境」且无人物词 → empty', () => {
    expect(normalizeMaterialType(undefined, '空荡荡的地铁站，画面中无人物', '')).toBe('empty');
    expect(normalizeMaterialType('real', '雨中的街道，空无一人', '街道')).toBe('empty');
  });

  it('唯一「无人机」不算无人 → 仍为 real', () => {
    expect(normalizeMaterialType('real', '航拍镜头，无人机飞过山谷', '无人机')).toBe('real');
  });

  it('空镜词与人同时出现 → 不判空镜（人为主体）', () => {
    expect(normalizeMaterialType('real', '空旷的广场上，一个男子走过', '男子')).toBe('real');
  });

  it('黑场/字幕/闪白等特效描述 → effect', () => {
    expect(normalizeMaterialType(undefined, '黑场转场后的片头字幕', '')).toBe('effect');
  });

  it('缺失或非法值且无任何信号 → real（绝不产出 undefined）', () => {
    expect(normalizeMaterialType(undefined, '', '')).toBe('real');
    expect(normalizeMaterialType('unknown', '两人在饭桌前争吵', '')).toBe('real');
  });
});
