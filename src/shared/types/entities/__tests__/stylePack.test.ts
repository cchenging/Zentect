import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STYLE_PACK,
  DEFAULT_TTS_PAUSE_MS,
  TTS_PAUSE_MAX_MS,
  TTS_PAUSE_MIN_MS,
  clampPauseMs,
  isIdentitySubtitleTuning,
  STYLE_PERSONA_BGM_PROFILE,
  resolveStylePackBgmProfile,
  resolveStylePackPauseMs,
  resolveStylePackSubtitleTuning,
} from '../stylePack';

describe('句尾停顿默认值策略（人格基准 + 浓度偏移）', () => {
  it('默认包（东北大姐·正常）与全局兜底同值，旧工程不产生指纹漂移', () => {
    expect(resolveStylePackPauseMs(DEFAULT_STYLE_PACK)).toBe(DEFAULT_TTS_PAUSE_MS);
  });

  it('九种组合的解析值符合契约表', () => {
    expect(resolveStylePackPauseMs({ persona: 'dongbei', level: 0 })).toBe(220);
    expect(resolveStylePackPauseMs({ persona: 'dongbei', level: 1 })).toBe(180);
    expect(resolveStylePackPauseMs({ persona: 'dongbei', level: 2 })).toBe(140);
    expect(resolveStylePackPauseMs({ persona: 'jietou', level: 0 })).toBe(180);
    expect(resolveStylePackPauseMs({ persona: 'jietou', level: 1 })).toBe(140);
    expect(resolveStylePackPauseMs({ persona: 'jietou', level: 2 })).toBe(100);
    expect(resolveStylePackPauseMs({ persona: 'animal', level: 0 })).toBe(320);
    expect(resolveStylePackPauseMs({ persona: 'animal', level: 1 })).toBe(280);
    expect(resolveStylePackPauseMs({ persona: 'animal', level: 2 })).toBe(240);
  });

  it('非法/缺失风格包归一为默认包', () => {
    expect(resolveStylePackPauseMs(null)).toBe(DEFAULT_TTS_PAUSE_MS);
    expect(resolveStylePackPauseMs({ persona: 'unknown', level: 9 } as any)).toBe(DEFAULT_TTS_PAUSE_MS);
  });

  it('clampPauseMs 收敛到 0~400 且非有限值回退默认', () => {
    expect(clampPauseMs(-100)).toBe(TTS_PAUSE_MIN_MS);
    expect(clampPauseMs(9999)).toBe(TTS_PAUSE_MAX_MS);
    expect(clampPauseMs('240')).toBe(240);
    expect(clampPauseMs(Number.NaN)).toBe(DEFAULT_TTS_PAUSE_MS);
  });
});

describe('字幕排版随浓度派生', () => {
  it('三档浓度对应收着走 / 单位变换 / 顶着走', () => {
    expect(resolveStylePackSubtitleTuning({ persona: 'dongbei', level: 0 })).toEqual({
      fontSizeScale: 0.94,
      strokeWidthScale: 0.9,
      lineWidthDelta: 3,
    });
    expect(resolveStylePackSubtitleTuning(DEFAULT_STYLE_PACK)).toEqual({
      fontSizeScale: 1,
      strokeWidthScale: 1,
      lineWidthDelta: 0,
    });
    expect(resolveStylePackSubtitleTuning({ persona: 'animal', level: 2 })).toEqual({
      fontSizeScale: 1.08,
      strokeWidthScale: 1.25,
      lineWidthDelta: -3,
    });
  });

  it('只有正常浓度是单位变换，其余档必须写入派生值', () => {
    expect(isIdentitySubtitleTuning(resolveStylePackSubtitleTuning(DEFAULT_STYLE_PACK))).toBe(true);
    expect(isIdentitySubtitleTuning(resolveStylePackSubtitleTuning({ persona: 'jietou', level: 0 }))).toBe(false);
    expect(isIdentitySubtitleTuning(resolveStylePackSubtitleTuning({ persona: 'jietou', level: 2 }))).toBe(false);
  });

  it('缺失/非法风格包按默认包（单位变换）处理', () => {
    expect(isIdentitySubtitleTuning(resolveStylePackSubtitleTuning(undefined))).toBe(true);
    expect(isIdentitySubtitleTuning(resolveStylePackSubtitleTuning({ persona: 'x', level: 7 } as any))).toBe(true);
  });
});

describe('BGM 情绪倾向随人格', () => {
  it('三个人格各自给出情绪标签与 BPM 区间', () => {
    expect(resolveStylePackBgmProfile({ persona: 'dongbei', level: 1 })).toEqual({
      moodHint: expect.any(String),
      moodTags: ['市井', '轻快', '民间', '接地气'],
      bpmRange: [90, 120],
    });
    expect(resolveStylePackBgmProfile({ persona: 'jietou', level: 0 })).toEqual({
      moodHint: expect.any(String),
      moodTags: ['燃', '强节奏', '鼓点', '紧张'],
      bpmRange: [120, 150],
    });
    expect(resolveStylePackBgmProfile({ persona: 'animal', level: 2 })).toEqual({
      moodHint: expect.any(String),
      moodTags: ['纪录片', '弦乐', '庄重', '悬念'],
      bpmRange: [70, 100],
    });
  });

  it('只跟人格、不随浓度变化；缺失包回落东北大姐', () => {
    const atLevel0 = resolveStylePackBgmProfile({ persona: 'animal', level: 0 });
    const atLevel2 = resolveStylePackBgmProfile({ persona: 'animal', level: 2 });
    expect(atLevel0).toBe(atLevel2);
    expect(resolveStylePackBgmProfile(undefined)).toBe(STYLE_PERSONA_BGM_PROFILE.dongbei);
  });
});
