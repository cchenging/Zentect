// 📁 路径: src/main/engine/strategies/__tests__/RoleTiering.test.ts
// 🎯 GAP 2a: 服务端角色主次分级 computeRoleTierByFrequency 单元测试
// 规则（用户明确规定，唯一真源）:
//   1. 频次(faceCount) ≥ 3 的簇 → main 主角
//   2. 其余低频簇 → extra 背景路人
//      注: supporting 配角不自动分配, 留给前端用户手动标注（三档徽章循环切换）
//   3. 兜底: 如果全片无人 ≥3, 强制保留最高频 1 个为 main 主角
//      （并列最高频时取数组第一个, 稳定不随机）
//   4. 非法 faceCount(null/undefined/NaN/<0) → 按 0 处理（错就错不兜底 UI 状态）

import { describe, it, expect } from 'vitest';
import { FaceDetectStrategy } from '../FaceDetectStrategy';

type TestRole = { id: string; faceCount?: number | null };
const run = (roles: TestRole[]) => (FaceDetectStrategy as any).computeRoleTierByFrequency(roles);

describe('FaceDetectStrategy.computeRoleTierByFrequency — GAP 2a 角色频次分级', () => {
  it('[GAP2A-1] 主场景：faceCount≥3 → main主角，<3 → extra路人（2主+3路）', () => {
    const roles: TestRole[] = [
      { id: 'r_a', faceCount: 10 },
      { id: 'r_b', faceCount: 5 },
      { id: 'r_c', faceCount: 2 },
      { id: 'r_d', faceCount: 1 },
      { id: 'r_e', faceCount: 1 },
    ];
    const out = run(roles);
    expect(out).toHaveLength(5);
    expect(out.map((r: any) => r.id + ':' + r.tier)).toEqual([
      'r_a:main', 'r_b:main',   // 10/5 ≥ 3 → 主角
      'r_c:extra', 'r_d:extra', 'r_e:extra', // 2/1/1 < 3 → 路人
    ]);
    // 不可变性: 原对象未被改写
    expect((roles[0] as any).tier).toBeUndefined();
  });

  it('[GAP2A-2] 全<3兜底：无人达3次时，最高频第1个提升为 main，其余 extra', () => {
    const roles: TestRole[] = [
      { id: 'r_low1', faceCount: 2 },
      { id: 'r_low2', faceCount: 1 },
      { id: 'r_low3', faceCount: 1 },
    ];
    const out = run(roles);
    expect(out.map((r: any) => r.id + ':' + r.tier)).toEqual([
      'r_low1:main',  // 兜底最高频 1 个 = main
      'r_low2:extra', 'r_low3:extra',
    ]);
  });

  it('[GAP2A-3] 并列≥3：多个 main 保留，全 ≥3 时全员 main', () => {
    const roles: TestRole[] = [
      { id: 'r1', faceCount: 3 },
      { id: 'r2', faceCount: 3 },
      { id: 'r3', faceCount: 5 },
      { id: 'r4', faceCount: 2 },
    ];
    const out = run(roles);
    expect(out.map((r: any) => r.tier)).toEqual(['main', 'main', 'main', 'extra']);
  });

  it('[GAP2A-4] 空角色数组 → 返回空数组（不抛错）', () => {
    expect(run([])).toEqual([]);
    expect(run(null as any)).toEqual([]);
    expect(run(undefined as any)).toEqual([]);
  });

  it('[GAP2A-5] 非法 faceCount(null/undefined/NaN/负数) → 按 0 处理，全员 extra，然后兜底最高频第1个升 main', () => {
    const roles: TestRole[] = [
      { id: 'r_null', faceCount: null },
      { id: 'r_undef', faceCount: undefined },
      { id: 'r_nan', faceCount: NaN },
      { id: 'r_neg', faceCount: -5 },
    ];
    const out = run(roles);
    // 全部按 0 算 < 3 → 兜底最高频（并列时第 1 个）升 main
    expect(out.map((r: any) => r.id + ':' + r.tier)).toEqual([
      'r_null:main',
      'r_undef:extra', 'r_nan:extra', 'r_neg:extra',
    ]);
  });

  it('[GAP2A-6] 极端单角色：1 个角色 faceCount=0 → 兜底升 main（保证至少 1 个主角不尴尬）', () => {
    const out = run([{ id: 'alone', faceCount: 0 }]);
    expect(out[0].tier).toBe('main');
  });
});
