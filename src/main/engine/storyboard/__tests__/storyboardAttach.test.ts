/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import type { ShotSpec } from '../../../../shared/contracts/shotSpec';
import { StoryboardAgent, type MotherClauseInput } from '../StoryboardAgent';

// ============================================================
// attachMotherFields：母句 text/visualIntent 回填到工单（展示透传）
// 规格：docs/designs/2026-09-19-A系列实施规格.md §5.2 卡片展示
// ============================================================

/** 造一个最短合法工单。 */
function spec(matchUnitId: string, partial: Partial<ShotSpec> = {}): ShotSpec {
  return {
    matchUnitId,
    mode: 'NEW_SHOT',
    segmentId: 1,
    spatialType: 'INDOOR_PUBLIC',
    preferredShot: 'MEDIUM_SHOT',
    cameraDynamic: 'STATIC',
    emotion: 'NEUTRAL',
    audioMode: 'narration',
    fallbackLevel: 0,
    ...partial,
  } as ShotSpec;
}

/** 造一个母句。 */
function mother(matchUnitId: string, partial: Partial<MotherClauseInput> = {}): MotherClauseInput {
  return { matchUnitId, text: `文案-${matchUnitId}`, visualIntent: `意图-${matchUnitId}`, ...partial };
}

describe('StoryboardAgent.attachMotherFields', () => {
  it('按 matchUnitId 回填 text / visualIntent', () => {
    const orders = [spec('seg_0'), spec('seg_1_s1')];
    const mothers = [mother('seg_0'), mother('seg_1_s1')];
    const out = StoryboardAgent.attachMotherFields(orders, mothers);
    expect(out[0].text).toBe('文案-seg_0');
    expect(out[0].visualIntent).toBe('意图-seg_0');
    expect(out[1].text).toBe('文案-seg_1_s1');
    expect(out[1].visualIntent).toBe('意图-seg_1_s1');
  });

  it('不覆盖已存在的 text / visualIntent（LLM 或上游已写则保留）', () => {
    const orders = [spec('seg_0', { text: '已存在文案', visualIntent: '已存在意图' })];
    const mothers = [mother('seg_0')];
    const out = StoryboardAgent.attachMotherFields(orders, mothers);
    expect(out[0].text).toBe('已存在文案');
    expect(out[0].visualIntent).toBe('已存在意图');
  });

  it('母句缺失（脏数据）时保持 undefined 不清写', () => {
    const orders = [spec('seg_0')];
    const mothers: MotherClauseInput[] = [mother('other_unit')];
    const out = StoryboardAgent.attachMotherFields(orders, mothers);
    expect(out[0].text).toBeUndefined();
    expect(out[0].visualIntent).toBeUndefined();
  });

  it('母句 text 为空串时不写入（保持 undefined）', () => {
    const orders = [spec('seg_0')];
    const mothers = [mother('seg_0', { text: '' })];
    const out = StoryboardAgent.attachMotherFields(orders, mothers);
    expect(out[0].text).toBeUndefined();
  });

  it('空数组 / 缺 mothers 时原样返回', () => {
    const orders = [spec('seg_0')];
    // 缺 mothers：与原数组结构完全一致（浅拷贝后字段不变）
    const out = StoryboardAgent.attachMotherFields(orders as any, [] as any);
    expect(out).toEqual(orders);
    expect(StoryboardAgent.attachMotherFields([], [mother('x')])).toEqual([]);
  });
});

// ============================================================
// buildMotherClauses：剥离上游 query.text 的 " | {visualIntent}" 后缀（ADR-⑧ P1）
// 让开单/展示拿到干净文案，visualIntent 独立持有，不改上游 KM text
// ============================================================

describe('StoryboardAgent.buildMotherClauses 文案剥离', () => {
  it('text 尾部带 " | intent" 时精确剥离，保留纯文案', () => {
    const q = [{ matchUnitId: 'seg_0', shotId: 'seg_0', text: '完整句正文 | 机场出口，女孩茫然四顾', visualIntent: '机场出口，女孩茫然四顾' }];
    const moms = StoryboardAgent.buildMotherClauses(q);
    expect(moms[0].text).toBe('完整句正文');
    expect(moms[0].visualIntent).toBe('机场出口，女孩茫然四顾');
  });

  it('text 不带 intent 后缀时原样保留（不清写）', () => {
    const q = [{ matchUnitId: 'seg_1', shotId: 'seg_1', text: '纯文案句', visualIntent: '' }];
    const moms = StoryboardAgent.buildMotherClauses(q);
    expect(moms[0].text).toBe('纯文案句');
    expect(moms[0].visualIntent).toBeUndefined();
  });

  it('text 含 "|" 但非 intent 尾巴时不做误剥离', () => {
    // 正文自身含管道符，但结尾不是 " | intent" → 保持原样
    const q = [{ matchUnitId: 'seg_2', shotId: 'seg_2', text: 'A | B 说明', visualIntent: '说明' }];
    const moms = StoryboardAgent.buildMotherClauses(q);
    expect(moms[0].text).toBe('A | B 说明');
    expect(moms[0].visualIntent).toBe('说明');
  });

  it('按 matchUnitId 去重：同一完整句只保留一条决不开双单', () => {
    const q = [
      { matchUnitId: 'seg_0', shotId: 'seg_0', text: '句一 | 意图', visualIntent: '意图' },
      { matchUnitId: 'seg_0', shotId: 'seg_0', text: '句一重复 | 意图', visualIntent: '意图' },
    ];
    const moms = StoryboardAgent.buildMotherClauses(q);
    expect(moms).toHaveLength(1);
  });
});