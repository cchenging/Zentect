/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import type { ShotSpec } from '../../../../shared/contracts/shotSpec';
import { StoryboardAgent, type MotherClauseInput, type SegmentSummary } from '../StoryboardAgent';
import { evaluateFittingConcern } from '../storyboardValidate';

// ============================================================
// 中期方案 B：分镜师感知抽象旁白（isAbstractNarration）
// 规格：docs/designs/2026-10-21-步骤5-空镜抽象分流方案.md §3 方案 B
// 约定：标记唯一来源是 S3 文案，S2 只透传 + 据此开宽景别，不重算不猜测。
// ============================================================

function mother(matchUnitId: string, partial: Partial<MotherClauseInput> = {}): MotherClauseInput {
  return { matchUnitId, text: `文案-${matchUnitId}`, ...partial };
}

/** 段摘要：段内有主体，用于「无主体」存疑判定。 */
function segment(): SegmentSummary {
  return {
    segmentId: 1,
    startMs: 0,
    endMs: 10000,
    parentIds: [],
    parentCount: 0,
    chunkCount: 3,
    locClass: 'INDOOR',
    locPurity: 0.8,
    locRaw: [],
    topChars: ['英宰'],
    shotDist: { MEDIUM_SHOT: 3 },
    repDesc: '',
  };
}

describe('抽象旁白 · 母句透传', () => {
  it('query.isAbstractNarration===true 才透传，缺省为 false', () => {
    const mothers = StoryboardAgent.buildMotherClauses([
      { matchUnitId: 's1', text: '转眼已过三年', isAbstractNarration: true },
      { matchUnitId: 's2', text: '他推门进来' },
      { matchUnitId: 's3', text: '伪值不算', isAbstractNarration: 'true' as any },
    ]);
    expect(mothers[0].isAbstractNarration).toBe(true);
    expect(mothers[1].isAbstractNarration).toBe(false);
    expect(mothers[2].isAbstractNarration).toBe(false);
  });

  it('ZENTECT_KM_ABSTRACT_IDS 可人工注入（验证用开关）', () => {
    process.env.ZENTECT_KM_ABSTRACT_IDS = 's9';
    try {
      const mothers = StoryboardAgent.buildMotherClauses([
        { matchUnitId: 's9', text: '誓言经不起一张照片的考验' },
        { matchUnitId: 's10', text: '他推门进来' },
      ]);
      expect(mothers[0].isAbstractNarration).toBe(true);
      expect(mothers[1].isAbstractNarration).toBe(false);
    } finally {
      delete process.env.ZENTECT_KM_ABSTRACT_IDS;
    }
  });

  it('cacheKey 随抽象标记变化（否则旧工单会被复用）', () => {
    const segs = [segment()];
    const plain = StoryboardAgent.cacheKey([mother('s1')], segs);
    const abs = StoryboardAgent.cacheKey([mother('s1', { isAbstractNarration: true })], segs);
    expect(plain).not.toBe(abs);
  });
});

describe('抽象旁白 · 开单 prompt', () => {
  it('prompt 含抽象专项规则，且只给抽象句打标', () => {
    const { system, user } = StoryboardAgent.buildPrompt(
      [mother('s1', { isAbstractNarration: true }), mother('s2')], [segment()], null, '', '',
    );
    expect(system).toContain('抽象旁白专项');
    expect(system).toContain('EXTREME_LONG');
    expect(system).toContain('targetSubjects 可以为空数组');
    expect(user).toContain('matchUnitId=s1（抽象旁白）');
    expect(user).not.toContain('matchUnitId=s2（抽象旁白）');
  });
});

describe('抽象旁白 · 工单回填与校验', () => {
  const spec = (matchUnitId: string, partial: Partial<ShotSpec> = {}): ShotSpec => ({
    matchUnitId,
    mode: 'NEW_SHOT',
    segmentId: 1,
    spatialType: 'INDOOR_PUBLIC',
    targetSubjects: [],
    preferredShot: 'LONG_SHOT',
    cameraDynamic: 'STATIC',
    emotion: 'NEUTRAL',
    audioMode: 'narration',
    fallbackLevel: 0,
    ...partial,
  } as ShotSpec);

  it('attachMotherFields 把抽象标记写回工单', () => {
    const out = StoryboardAgent.attachMotherFields(
      [spec('s1'), spec('s2')],
      [mother('s1', { isAbstractNarration: true }), mother('s2')],
    );
    expect(out[0].isAbstractNarration).toBe(true);
    expect(out[1].isAbstractNarration).toBeUndefined();
  });

  it('抽象句无主体不算存疑；剧情句无主体仍存疑', () => {
    expect(evaluateFittingConcern(spec('s1', { isAbstractNarration: true }), segment()).suspicious).toBe(false);
    expect(evaluateFittingConcern(spec('s2'), segment()).suspicious).toBe(true);
  });

  it('误标告警：抽象句的画面意图写成近景即判存疑', () => {
    const suspects = StoryboardAgent.abstractMislabelSuspects([
      mother('s1', { isAbstractNarration: true, visualIntent: '男女主角合影特写，画面渐暗' }),
      mother('s2', { isAbstractNarration: true, visualIntent: '雨夜街道车流，空无一人' }),
      mother('s3', { visualIntent: '女子面部特写，眼神凌厉' }),
    ] as never);
    expect(suspects).toHaveLength(1);
    expect(suspects[0].startsWith('s1:')).toBe(true);
  });
});
