// 📁 路径：src/main/engine/__tests__/ttsEmotion.test.ts
// 情绪 → 韵律参数映射单测：7 桶 / 同分优先 / 未知词 / 强度插值 / 夹取边界

import { describe, it, expect } from 'vitest';
import { resolveEmotionProsody, EMOTION_STRENGTH_FACTOR } from '../ttsEmotion';

describe('resolveEmotionProsody', () => {
  it('空情绪 / undefined / 「无」/「中性」应归中性且不改语速', () => {
    for (const emotion of [undefined, null, '', '   ', '无', '中性', '普通']) {
      const p = resolveEmotionProsody(emotion, 1.0);
      expect(p.hit).toBe(false);
      expect(p.bucket).toBe('neutral');
      expect(p.rate).toBe(1.0);
      expect(p.pitchHz).toBe(0);
    }
  });

  it('中性时全局语速原样返回（不做 0.8~1.25 夹取）', () => {
    expect(resolveEmotionProsody('', 1.8).rate).toBe(1.8);
    expect(resolveEmotionProsody('', 0.6).rate).toBe(0.6);
  });

  it('七个桶的代表词应命中对应乘子与音高（normal 强度）', () => {
    const cases: Array<[string, number, number]> = [
      ['紧张', 1.04, 1],
      ['愤怒', 1.06, -1],
      ['悲伤', 0.94, -2],
      ['温情', 0.96, 0],
      ['惊讶', 1.08, 3],
      ['热血', 1.05, 2],
    ];
    for (const [emotion, rateMul, pitchHz] of cases) {
      const p = resolveEmotionProsody(emotion, 1.0, 'normal');
      expect(p.hit).toBe(true);
      expect(p.rate).toBeCloseTo(rateMul, 5);
      expect(p.pitchHz).toBe(pitchHz);
    }
  });

  it('命中数最高者胜；同分取表序靠前者', () => {
    // 「紧张」命中 1 次；「悬疑」1 次；同桶累加仍为紧张桶
    expect(resolveEmotionProsody('紧张悬疑', 1.0).bucket).toBe('tense');
    // 「悲伤」1 次 vs 「愤怒」2 次（「怒」+「愤怒」）→ 愤怒桶胜
    expect(resolveEmotionProsody('愤怒的悲伤', 1.0).bucket).toBe('angry');
    // 不同桶各 1 次：紧张（表序第 1）先于悲伤
    expect(resolveEmotionProsody('紧张又悲伤', 1.0).bucket).toBe('tense');
  });

  it('情绪词内的标点不影响命中', () => {
    expect(resolveEmotionProsody('（紧张）', 1.0).bucket).toBe('tense');
    expect(resolveEmotionProsody('压抑、沉重', 1.0).bucket).toBe('sad');
  });

  it('强度插值：weak 半幅、strong 1.5 倍', () => {
    const weak = resolveEmotionProsody('惊讶', 1.0, 'weak');
    const strong = resolveEmotionProsody('惊讶', 1.0, 'strong');
    // 惊讶：rateMul 1.08 → weak 1.04 / strong 1.12；pitch 3Hz → weak 2 / strong 5→夹 4
    expect(weak.rate).toBeCloseTo(1 + (1.08 - 1) * EMOTION_STRENGTH_FACTOR.weak, 5);
    expect(weak.pitchHz).toBe(2);
    expect(strong.rate).toBeCloseTo(1 + (1.08 - 1) * EMOTION_STRENGTH_FACTOR.strong, 5);
    expect(strong.pitchHz).toBe(4);
  });

  it('语速夹取到 [0.8, 1.25]', () => {
    // 悲伤 ×0.94，全局 0.7 → 0.658 → 夹到 0.8
    expect(resolveEmotionProsody('悲伤', 0.7).rate).toBe(0.8);
    // 惊讶 ×1.08，全局 1.4 → 1.512 → 夹到 1.25
    expect(resolveEmotionProsody('惊讶', 1.4).rate).toBe(1.25);
    // 悲伤 strong ×0.91，全局 0.85 → 0.7735 → 夹到 0.8
    expect(resolveEmotionProsody('悲伤', 0.85, 'strong').rate).toBe(0.8);
  });

  it('音高夹取到 ±4Hz', () => {
    // 惊讶 strong：3 × 1.5 = 4.5 → 4
    expect(resolveEmotionProsody('惊讶', 1.0, 'strong').pitchHz).toBe(4);
    // 悲伤 strong：-2 × 1.5 = -3
    expect(resolveEmotionProsody('悲伤', 1.0, 'strong').pitchHz).toBe(-3);
  });

  it('非法强度档按 normal 处理', () => {
    const p = resolveEmotionProsody('愤怒', 1.0, 'huge' as any);
    expect(p.pitchHz).toBe(-1);
    expect(p.rate).toBeCloseTo(1.06, 5);
  });
});
