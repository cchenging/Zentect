/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import type { ShotSpec } from '../../../../shared/contracts/shotSpec';
import type { PersonRegistry } from '../../utils/PersonRegistry';
import {
  normalizeTopChars,
  subjectInTopChars,
  validateSubjectsInTopChars,
  evaluateSatisfiability,
  evaluateFittingConcern,
  aggregateEvaluation,
  sanitizeTopChars,
  hasCloseLikeFootage,
} from '../storyboardValidate';
import type { SegmentSummary } from '../StoryboardAgent';

// ============================================================
// A2 两道校验：结构·主体白名单门 + 可满足性 + 配场存疑（纯函数，不重开）
// 规格：docs/designs/2026-09-19-A系列实施规格-A2.md §5.1
// ============================================================

/** 造一个最短合法工单（P3 契约字段最小集）。 */
function spec(partial: Partial<ShotSpec> & { targetSubjects?: string[]; segmentId: number }): ShotSpec {
  return {
    matchUnitId: 'm1',
    mode: 'NEW_SHOT',
    spatialType: 'INDOOR_PUBLIC',
    preferredShot: 'MEDIUM_SHOT',
    cameraDynamic: 'STATIC',
    emotion: 'NEUTRAL',
    audioMode: 'narration',
    fallbackLevel: 0,
    ...partial,
  } as ShotSpec;
}

/** 造一个场记段摘要（仅校验需要字段；无关字段给默认）。 */
function seg(partial: Partial<SegmentSummary> & { segmentId: number; topChars?: string[] }): SegmentSummary {
  return {
    segmentId: partial.segmentId,
    startMs: 0,
    endMs: 1000,
    parentIds: [],
    parentCount: 1,
    chunkCount: 1,
    locClass: partial.locClass ?? 'INDOOR',
    locPurity: 1,
    locRaw: [],
    topChars: partial.topChars ?? [],
    shotDist: partial.shotDist ?? { MEDIUM_SHOT: 1 },
    repDesc: partial.repDesc ?? '',
  };
}

// ==================== normalizeTopChars ====================

describe('normalizeTopChars：段主体白名单归一', () => {
  it('null / 非数组 → 空数组', () => {
    expect(normalizeTopChars(null)).toEqual([]);
    expect(normalizeTopChars(undefined)).toEqual([]);
    expect(normalizeTopChars('X' as any)).toEqual([]);
  });
  it('trim + 去空 + 去重', () => {
    expect(normalizeTopChars([' 英宰 ', '', '英宰', '刘敏赫'])).toEqual(['英宰', '刘敏赫']);
  });
});

// ==================== subjectInTopChars ====================

describe('subjectInTopChars：主体是否命中白名单', () => {
  it('精确命中 → true', () => {
    expect(subjectInTopChars('英宰', ['英宰', '刘敏赫'], null)).toBe(true);
  });
  it('未命中 → false', () => {
    expect(subjectInTopChars('路人', ['英宰'], null)).toBe(false);
  });
  it('别名归一命中（注册表 canonical/别名为桥梁）→ true', () => {
    const registry: any = {
      chars: [
        { charId: 'c1', canonical: '英宰', aliasesHigh: [{ literal: '少年' }], gatingAllowed: true },
      ],
    };
    // 工单写"少年"（别名），段 topChars 写"英宰"（canonical）
    expect(subjectInTopChars('少年', ['英宰'], registry)).toBe(true);
  });
  it('注册表为空时不做别名扩展 → 仍按精确字面判定', () => {
    expect(subjectInTopChars('少年', ['英宰'], null)).toBe(false);
  });
});

// ==================== validateSubjectsInTopChars（① 白名单硬门） ====================

describe('validateSubjectsInTopChars：结构校验①主体白名单门', () => {
  it('无主体（纯环境句）→ 通过（空错误）', () => {
    expect(validateSubjectsInTopChars(spec({ segmentId: 1, targetSubjects: [] }), ['英宰'], null)).toEqual([]);
  });
  it('全部主体命中 → 通过', () => {
    expect(validateSubjectsInTopChars(spec({ segmentId: 1, targetSubjects: ['英宰'] }), ['英宰', '刘敏赫'], null)).toEqual([]);
  });
  it('任一主体未命中 → 报错（触发重开）', () => {
    const errs = validateSubjectsInTopChars(spec({ segmentId: 1, targetSubjects: ['路人'] }), ['英宰'], null);
    expect(errs.some((e) => e.includes('主体「路人」不在段topChars内'))).toBe(true);
  });
  it('段 topChars 缺失且工单有主体 → 判"数据缺失"返回空（不进重开硬门，转给可满足性）', () => {
    expect(validateSubjectsInTopChars(spec({ segmentId: 1, targetSubjects: ['英宰'] }), [], null)).toEqual([]);
    expect(validateSubjectsInTopChars(spec({ segmentId: 1, targetSubjects: ['英宰'] }), null, null)).toEqual([]);
  });
});

// ==================== evaluateSatisfiability（② 可满足性，纯计算） ====================

describe('evaluateSatisfiability：可满足性校验（不重开）', () => {
  it('段存在且主体在场 → 可满足', () => {
    const r = evaluateSatisfiability(spec({ segmentId: 1, targetSubjects: ['英宰'] }), seg({ segmentId: 1, topChars: ['英宰'] }), null);
    expect(r.satisfiable).toBe(true);
  });
  it('无主体 → 视为可满足（场景兜底）', () => {
    const r = evaluateSatisfiability(spec({ segmentId: 1, targetSubjects: [] }), seg({ segmentId: 1, topChars: ['英宰'] }), null);
    expect(r.satisfiable).toBe(true);
  });
  it('段 topChars 缺失但工单有主体 → 不可满足（topChars缺失）', () => {
    const r = evaluateSatisfiability(spec({ segmentId: 1, targetSubjects: ['英宰'] }), seg({ segmentId: 1, topChars: [] }), null);
    expect(r.satisfiable).toBe(false);
    expect(r.reason).toContain('topChars缺失');
  });
  it('主体越白名单 → 不可满足', () => {
    const r = evaluateSatisfiability(spec({ segmentId: 1, targetSubjects: ['路人'] }), seg({ segmentId: 1, topChars: ['英宰'] }), null);
    expect(r.satisfiable).toBe(false);
    expect(r.reason).toContain('不在段topChars内');
  });
  it('段不存在 → 不可满足（段不存在）', () => {
    const r = evaluateSatisfiability(spec({ segmentId: 999, targetSubjects: ['英宰'] }), null, null);
    expect(r.satisfiable).toBe(false);
    expect(r.reason).toContain('段不存在');
  });
});

// ==================== evaluateFittingConcern（③ 配场存疑） ====================

describe('evaluateFittingConcern：配场存疑校验（不重开）', () => {
  it('无主体但段有主体 → 存疑（无主体仅靠scene）', () => {
    const r = evaluateFittingConcern(spec({ segmentId: 1, targetSubjects: [] }), seg({ segmentId: 1, topChars: ['英宰'] }));
    expect(r.suspicious).toBe(true);
  });
  it('有主体 → 不存疑', () => {
    const r = evaluateFittingConcern(spec({ segmentId: 1, targetSubjects: ['英宰'] }), seg({ segmentId: 1, topChars: ['英宰'] }));
    expect(r.suspicious).toBe(false);
  });
  it('高信息位景别但段无景别记录 → 存疑', () => {
    const r = evaluateFittingConcern(
      spec({ segmentId: 1, targetSubjects: ['英宰'], preferredShot: 'CLOSE_SHOT' as any }),
      seg({ segmentId: 1, topChars: ['英宰'], shotDist: {} }),
    );
    expect(r.suspicious).toBe(true);
  });
  it('段有中文近景素材 → 近景工单不存疑（修复中文键误判）', () => {
    const r = evaluateFittingConcern(
      spec({ segmentId: 1, targetSubjects: ['英宰'], preferredShot: 'CLOSE_SHOT' as any }),
      seg({ segmentId: 1, topChars: ['英宰'], shotDist: { '近景': 8, '中景': 5 } }),
    );
    expect(r.suspicious).toBe(false);
  });
  it('段有中文特写素材 → 特写工单不存疑（修复中文键误判）', () => {
    const r = evaluateFittingConcern(
      spec({ segmentId: 1, targetSubjects: ['英宰'], preferredShot: 'EXTREME_CLOSE' as any }),
      seg({ segmentId: 1, topChars: ['英宰'], shotDist: { '特写': 3, '中景': 5 } }),
    );
    expect(r.suspicious).toBe(false);
  });
  it('段仅有中景/全景（无特写近景）→ 高信息位景别工单存疑（真实素材缺口）', () => {
    const r = evaluateFittingConcern(
      spec({ segmentId: 1, targetSubjects: ['英宰'], preferredShot: 'CLOSE_SHOT' as any }),
      seg({ segmentId: 1, topChars: ['英宰'], shotDist: { '中景': 5, '全景': 7 } }),
    );
    expect(r.suspicious).toBe(true);
    expect(r.reason).toContain('无特写/近景素材');
  });
  it('段不存在 → 不重复标存疑', () => {
    const r = evaluateFittingConcern(spec({ segmentId: 1, targetSubjects: ['英宰'] }), null);
    expect(r.suspicious).toBe(false);
  });
});

// ==================== hasCloseLikeFootage（段景别分布是否含特写/近景类） ====================

describe('hasCloseLikeFootage：段 shotDist 是否含高信息位景别素材', () => {
  it('中文近景/特写键 → true', () => {
    expect(hasCloseLikeFootage({ '近景': 8, '中景': 5 })).toBe(true);
    expect(hasCloseLikeFootage({ '特写': 3 })).toBe(true);
    expect(hasCloseLikeFootage({ '中近景': 1 })).toBe(true);
  });
  it('仅中景/全景/远景（无特写近景）→ false', () => {
    expect(hasCloseLikeFootage({ '中景': 5, '全景': 7 })).toBe(false);
    expect(hasCloseLikeFootage({ '远景': 2 })).toBe(false);
  });
  it('英文契约枚举兼容 → EXTREME_CLOSE/CLOSE_SHOT/MEDIUM_CLOSE 判 true，MEDIUM_SHOT 判 false', () => {
    expect(hasCloseLikeFootage({ EXTREME_CLOSE: 1 })).toBe(true);
    expect(hasCloseLikeFootage({ CLOSE_SHOT: 2 })).toBe(true);
    expect(hasCloseLikeFootage({ MEDIUM_CLOSE: 3 })).toBe(true);
    expect(hasCloseLikeFootage({ MEDIUM_SHOT: 1 })).toBe(false);
  });
  it('空/缺省 → false', () => {
    expect(hasCloseLikeFootage({})).toBe(false);
    expect(hasCloseLikeFootage(null)).toBe(false);
    expect(hasCloseLikeFootage(undefined)).toBe(false);
  });
});

// ==================== aggregateEvaluation（聚合诊断） ====================

describe('aggregateEvaluation：聚合可满足率 + 配场存疑率', () => {
  it('汇总 correct 计数与逐单理由', () => {
    const orders = [
      spec({ segmentId: 1, targetSubjects: ['英宰'] }),
      spec({ segmentId: 1, targetSubjects: ['路人'] }),      // 不可满足
      spec({ segmentId: 1, targetSubjects: [] }),              // 无主体→存疑
    ];
    const byId = new Map<number, SegmentSummary | null>([[1, seg({ segmentId: 1, topChars: ['英宰'] })]]);
    const s = aggregateEvaluation(orders, byId, null);
    expect(s.total).toBe(3);
    expect(s.satisfiableCount).toBe(2);  // #0 在场、#2 无主体(场景兜底)均可满足；#1 越白名单不可满足
    expect(s.suspiciousCount).toBe(1);   // 仅 #2（无主体仅靠 scene）
    expect(s.points[0].satisfiable).toBe(true);
    expect(s.points[1].satisfiable).toBe(false);
    expect(s.points[2].suspicious).toBe(true);
  });
});

// ==================== sanitizeTopChars（topChars 幻觉清洗） ====================

describe('sanitizeTopChars：剔除道具/占位/幻觉性名，保真人主体', () => {
  const empty: PersonRegistry = { chars: [] };
  // 用《浪漫满屋》部分注册表：英宰↔郑智薰/Rain、韩智恩↔宋慧乔、柳民赫↔民赫。
  const registry: PersonRegistry = {
    chars: [
      { charId: 'a', canonical: '李英宰', kind: 'role',
        aliasesHigh: [
          { literal: '郑智薰', count: 1, channel: 'actor' },
          { literal: 'Rain', count: 1, channel: 'actor' },
        ], aliasesLow: [], gatingAllowed: true },
      { charId: 'b', canonical: '韩智恩', kind: 'role',
        aliasesHigh: [
          { literal: '宋慧乔', count: 1, channel: 'actor' },
          { literal: '宋慧乔饰演的角色', count: 1, channel: 'actor' },
        ], aliasesLow: [], gatingAllowed: true },
      { charId: 'c', canonical: '柳民赫', kind: 'role',
        aliasesHigh: [
          { literal: '民赫', count: 1, channel: 'role' },
        ], aliasesLow: [], gatingAllowed: true },
    ],
  };

  it('剔除道具/物体/占位与注册表外幻觉性名，保留外观描述真人', () => {
    const kept = sanitizeTopChars(
      ['黄衣女子', '门缝', '金发女子', '无主体人物', '冰箱物品'], empty,
    );
    expect(kept).toEqual(['黄衣女子', '金发女子']);
  });

  it('按注册表保留裸真人名与别名，剔除注册表外性名', () => {
    const kept = sanitizeTopChars(
      ['站立的男子', '李民浩', '多人', '窗外路灯', '三人围坐沙发', '宋慧乔', 'Rain', '郑智薰'], registry,
    );
    expect(kept).toContain('站立的男子');
    expect(kept).toContain('多人');
    expect(kept).toContain('三人围坐沙发');
    expect(kept).toContain('宋慧乔');   // 注册真人
    expect(kept).toContain('Rain');     // 注册别名
    expect(kept).toContain('郑智薰');   // 注册别名
    expect(kept).not.toContain('李民浩');   // 注册表外幻觉性名
    expect(kept).not.toContain('窗外路灯'); // 道具
  });

  it('注册表为空时裸姓名无法确认 → 剔除；外观描述与占位仍按启发式', () => {
    const kept = sanitizeTopChars(['郑智薰', '卷发女子', '宋慧乔饰演的角色', '未知人物'], empty);
    expect(kept).toEqual(['卷发女子']);
  });

  it('空输入 → 空输出', () => {
    expect(sanitizeTopChars([], registry)).toEqual([]);
    expect(sanitizeTopChars(null, registry)).toEqual([]);
  });

  // 用真实 temp 数据做冒烟验证（仅 dev 态存在 temp，缺失则跳过，不阻塞 CI）。
  it('真实 temp 数据：段7剔除窗外路灯/李民浩，段5保留宋慧乔饰演的角色', () => {
    const dir = path.join(process.cwd(), 'temp', 'scene-log');
    const segPath = path.join(dir, 'segments.json');
    const regPath = path.join(dir, 'person_registry.json');
    if (!fs.existsSync(segPath) || !fs.existsSync(regPath)) return; // 非 dev 环境跳过
    const segs = JSON.parse(fs.readFileSync(segPath, 'utf-8')) as Array<{ segmentId: number; topChars: string[] }>;
    const realReg = JSON.parse(fs.readFileSync(regPath, 'utf-8')) as PersonRegistry;
    const byId = new Map(segs.map((s) => [s.segmentId, s]));
    const seg7 = byId.get(7);
    if (seg7) {
      const cleaned = sanitizeTopChars(seg7.topChars, realReg);
      expect(cleaned).not.toContain('窗外路灯');
      expect(cleaned).not.toContain('李民浩');
      expect(cleaned).toContain('多人');
    }
    const seg5 = byId.get(5);
    if (seg5) {
      const cleaned = sanitizeTopChars(seg5.topChars, realReg);
      expect(cleaned).toContain('宋慧乔饰演的角色');   // 注册别名，保留
      expect(cleaned).not.toContain('英祖');
    }
  });
});