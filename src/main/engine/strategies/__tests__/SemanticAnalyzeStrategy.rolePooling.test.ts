// 📁 路径: src/main/engine/strategies/__tests__/SemanticAnalyzeStrategy.rolePooling.test.ts
// 🎯 补丁18 · 切片角色时序众数归约（评审稿 §13.1）单元测试
// 覆盖:
//   1. 单人近景: 出现帧率 ≥50% → primarySubject = 角色名 + conf
//   2. 多人戏: ≥2 角色但无唯一 ≥50% → MULTIPLE 哨兵
//   3. 空镜: 涵盖帧内无角色 → EMPTY 哨兵（conf=0）
//   4. characters 30% 时长占比过滤: 瞬时路人被滤、主控保留
//   5. 无涵盖帧: primarySubject=undefined（不改写、不造假值）
//   6. 帧率分母 = 涵盖帧数（无角色帧也占分母）+ 50% 边界取闭区间
//   7. 开关缺省 off（env 未设/非法值均视为关）

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

import {
  SemanticAnalyzeStrategy,
  isRolePoolingEnabled,
  ROLE_POOLING_ENV,
} from '../SemanticAnalyzeStrategy';

/** 构造涵盖帧（timeMs 升序；chars 省略 = 该帧无角色） */
const frame = (timeMs: number, chars?: string[]) => (chars ? { timeMs, characters: chars } : { timeMs });
const reduce = (frames: any[], startMs: number, endMs: number) =>
  SemanticAnalyzeStrategy.reduceChunkRolesFromFrames(frames, startMs, endMs);

describe('补丁18 · 切片角色时序众数归约', () => {
  it('单人近景：出现帧率 ≥50% → primarySubject = 该角色 + conf', () => {
    // 4 帧（0/1000/2000/3000ms，窗口 0~4000ms），女主出现在 3 帧 → 75%
    const r = reduce([
      frame(0, ['女主']), frame(1000, ['女主']), frame(2000, ['女主']), frame(3000),
    ], 0, 4000);
    expect(r.primarySubject).toBe('女主');
    expect(r.primarySubjectConf).toBeCloseTo(0.75, 3);
    expect(r.characters).toEqual(['女主']);
    expect(r.totalFrames).toBe(4);
  });

  it('多人戏：≥2 角色但无唯一 ≥50% → MULTIPLE 哨兵', () => {
    // 3 帧各一个不同角色 → 最高帧率 1/3 < 50%
    const r = reduce([frame(0, ['甲']), frame(1000, ['乙']), frame(2000, ['丙'])], 0, 3000);
    expect(r.primarySubject).toBe('MULTIPLE');
    expect(r.primarySubjectConf).toBeCloseTo(1 / 3, 3);
  });

  it('空镜：涵盖帧内无任何角色 → EMPTY 哨兵（conf=0）', () => {
    const r = reduce([frame(0), frame(1000), frame(2000)], 0, 3000);
    expect(r.primarySubject).toBe('EMPTY');
    expect(r.primarySubjectConf).toBe(0);
    expect(r.characters).toBeUndefined();
  });

  it('characters 30% 时长占比过滤：瞬时路人滤除、主控保留', () => {
    // 窗口 0~5000ms，5 帧各覆盖 1000ms；女主 3 帧(60%)、路人 1 帧(20%)
    const r = reduce([
      frame(0, ['女主']), frame(1000, ['女主', '路人']), frame(2000, ['女主']), frame(3000), frame(4000),
    ], 0, 5000);
    expect(r.primarySubject).toBe('女主');
    expect(r.characters).toEqual(['女主']); // 路人 20% < 30% 被滤
    expect(r.coveredMs).toBe(5000);
  });

  it('无涵盖帧：primarySubject=undefined（不改写、不造假值）', () => {
    const r = reduce([], 0, 3000);
    expect(r.primarySubject).toBeUndefined();
    expect(r.primarySubjectConf).toBe(0);
    expect(r.characters).toBeUndefined();
    expect(r.totalFrames).toBe(0);
  });

  it('帧率分母 = 涵盖帧数（无角色帧占分母）；恰好 50% 取闭区间认单焦点', () => {
    const r = reduce([frame(0, ['男主']), frame(1000), frame(2000, ['男主']), frame(3000)], 0, 4000);
    expect(r.primarySubject).toBe('男主');
    expect(r.primarySubjectConf).toBe(0.5);
  });

  it('开关缺省 off：env 未设 / 非法值均视为关', () => {
    const saved = process.env[ROLE_POOLING_ENV];
    try {
      delete process.env[ROLE_POOLING_ENV];
      expect(isRolePoolingEnabled()).toBe(false);
      process.env[ROLE_POOLING_ENV] = 'off';
      expect(isRolePoolingEnabled()).toBe(false);
      process.env[ROLE_POOLING_ENV] = 'on';
      expect(isRolePoolingEnabled()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[ROLE_POOLING_ENV];
      else process.env[ROLE_POOLING_ENV] = saved;
    }
  });
});