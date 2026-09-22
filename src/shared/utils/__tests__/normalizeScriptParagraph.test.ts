// 📁 路径：src/shared/utils/__tests__/normalizeScriptParagraph.test.ts
// 🎯 锁定解说段落归一化工厂的三项核心契约：
//   1. 主键 id 缺失必须抛错（拒绝入库），不静默降级伪造
//   2. 带 type='original_audio' / keepOriginalAudio 标记的段判为原声段，保留 audioSource 语义字段
//   3. 普通解说段补齐 type='narration' + 毫秒时间轴，并发时间轴字段（startMs/durationMs 同源坐标）

import { describe, it, expect } from 'vitest';
import { normalizeScriptParagraph } from '../normalizeScriptParagraph';

describe('normalizeScriptParagraph — 身份键与判别联合契约', () => {
  it('[BUG 回归] 缺失 id 主键时抛错拒绝入库，不静默降级', () => {
    expect(() => normalizeScriptParagraph({ text: '没有主键的段落' })).toThrow(/缺少有效 id 主键/);
    expect(() => normalizeScriptParagraph(null)).toThrow(/不是合法段落对象/);
  });

  it('[原声段契约] 带 type=original_audio 的段判为原声段，透传 audioSource 语义字段', () => {
    const out = normalizeScriptParagraph({
      id: 'seg_3',
      type: 'original_audio',
      text: '特想要一个你这样的妈',
      audioSource: {
        sourceStartMs: 12000,
        sourceEndMs: 15300,
        transcript: '特想要一个你这样的妈',
        duckingBgm: true,
      },
      startMs: 11000,
      durationMs: 5000,
    });
    expect(out.type).toBe('original_audio');
    if (out.type === 'original_audio') {
      // 判别联合：原声段以 audioSource.transcript 承载语义，而非解说段 text
      expect(out.audioSource.transcript).toBe('特想要一个你这样的妈');
      expect(out.audioSource.sourceStartMs).toBe(12000);
      expect(out.id).toBe('seg_3');
    }
  });

  it('[legacy 兼容] keepOriginalAudio=true 布尔标记折算为原声段', () => {
    const out = normalizeScriptParagraph({
      id: 'seg_7',
      keepOriginalAudio: true,
      text: '原片台词原文',
      startMs: 30000,
      durationMs: 4000,
    });
    expect(out.type).toBe('original_audio');
  });

  it('[解说段契约] 缺 type 的段按多数派判为 narration，补齐毫秒时间轴', () => {
    const out = normalizeScriptParagraph({
      id: 'seg_0',
      text: '他冷笑一声，只回了一句',
      duration: 3,
    });
    expect(out.type).toBe('narration');
    if (out.type === 'narration') {
      // duration(秒) ×1000 反推毫秒轴，不伪造
      expect(out.durationMs).toBe(3000);
      expect(out.startMs).toBe(0);
      // 原声判别字段在解说段不应出现
      expect('audioSource' in out).toBe(false);
    }
  });

  // 🧪 2026-09-16 修正：布尔字段原样保留（含 false），使"全部 false"与"字段缺失"可区分
  it('[布尔落盘契约] isAbstractNarration=false 必须保留，缺失才不落字段', () => {
    const withFalse = normalizeScriptParagraph({
      id: 'seg_1',
      text: '常规解说段',
      isAbstractNarration: false,
      isFlashback: false,
    });
    const without = normalizeScriptParagraph({ id: 'seg_2', text: '未产出该字段的段' });
    // 判别联合需先收窄到解说段分支
    expect(withFalse.type).toBe('narration');
    if (withFalse.type === 'narration') {
      // false 是**明确判定**（下游一律用 === true 判定，故落 false 无副作用）
      expect(withFalse.isAbstractNarration).toBe(false);
      expect('isAbstractNarration' in withFalse).toBe(true);
      expect(withFalse.isFlashback).toBe(false);
    }
    // 从未产出的段保持"无该字段"，不得伪造 false
    expect('isAbstractNarration' in without).toBe(false);
  });

  it('[布尔落盘契约] isAbstractNarration=true 原样保留', () => {
    const out = normalizeScriptParagraph({ id: 'seg_3', text: '岁月流转，转眼十年', isAbstractNarration: true });
    expect(out.type).toBe('narration');
    if (out.type === 'narration') expect(out.isAbstractNarration).toBe(true);
  });
});