// 📁 路径：src/modules/media/frames/__tests__/InSceneDiffSampler.test.ts
// P1 · 镜内差分采样 TDD RED 阶段（全部用 mock hash，免磁盘 sharp）
import { describe, it, expect, vi, type Mock } from 'vitest';
import * as path from 'path';
import type { FrameAssetDetail } from '../types';
import type { BudgetClipPriorityFlag } from '../backend/BudgetClipper';

// 待实现静态类 InSceneDiffSampler
import { InSceneDiffSampler, type DiffFn } from '../backend/InSceneDiffSampler';

/** 生成不带磁盘文件的假帧（纯内存，免 sharp） */
function makeFrameMem(
  idx: number,
  overrides: Partial<FrameAssetDetail> = {}
): FrameAssetDetail {
  const framePath = path.join('/fake/dir', `frame_${String(idx).padStart(8, '0')}.jpg`);
  const timeMs = idx * 1000;
  const totalSec = Math.floor(timeMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  const ms = String(timeMs % 1000).padStart(3, '0').slice(0, 2);
  return {
    framePath,
    timeMs,
    timeStr: `${mm}:${ss}.${ms}`,
    clarityScore: 0.8,
    lumaScore: 128,
    sceneIndex: idx + 1, // P0 默认递增（P1 差分分裂会覆盖）
    ...overrides,
  };
}

/** 计算两 hash 字符串的汉明距离（InSceneDiffSampler 内部也会用到，测试用相同算法） */
function hammingDistance(a: string, b: string): number {
  let dist = 0;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ac = a.charCodeAt(i) || 0;
    const bc = b.charCodeAt(i) || 0;
    if (ac !== bc) {
      // 每一位不同：字符差异对应多位像素翻转，这里简单用 bit count 对应 aHash 64 位
      let xor = ac ^ bc;
      while (xor) {
        dist += xor & 1;
        xor >>= 1;
      }
    }
  }
  return dist;
}

describe('InSceneDiffSampler（P1 镜内差分采样）', () => {

  // 第 1 用例：差分基础 - 5 帧 hash 相似度递减（差分距离单调递增）
  it('差分基础：5 帧 hash 相似度递减 → 相邻帧汉明差分单调递增', async () => {
    // 16 chars hash：每相邻对严格新增 1/2/3/4 个不同 bit → hamming = 1,2,3,4
    const hashes = [
      '0000000000000000', // h0
      '0000000000000001', // h1: hamming(h0,h1) = 1 位不同（pos15）
      '0000000000001101', // h2: hamming(h1,h2) = 2 位新增不同（pos12,13）
      '0000000001111101', // h3: hamming(h2,h3) = 3 位新增不同（pos9,10,11）
      '0000011111111101', // h4: hamming(h3,h4) = 4 位新增不同（pos5,6,7,8）
    ];
    // 自测断言：确保 hash 序列 hamming 相邻差 = 1, 2, 3, 4
    expect(hammingDistance(hashes[0], hashes[1])).toBe(1);
    expect(hammingDistance(hashes[1], hashes[2])).toBe(2);
    expect(hammingDistance(hashes[2], hashes[3])).toBe(3);
    expect(hammingDistance(hashes[3], hashes[4])).toBe(4);
    const frames = hashes.map((_, i) => makeFrameMem(i));
    const precomputed = new Map<string, string>();
    frames.forEach((f, i) => precomputed.set(f.framePath, hashes[i]));

    const scored = await InSceneDiffSampler.scoreFramesDiff(frames, undefined, precomputed);
    expect(scored).toHaveLength(5);
    // 差分（diffToPrev）应严格单调递增
    for (let i = 2; i < scored.length; i++) {
      expect(scored[i].diffToPrev).toBeGreaterThan(scored[i - 1].diffToPrev);
    }
    // 第一帧 diffToPrev = 0（无前序）
    expect(scored[0].diffToPrev).toBe(0);
  });

  // 第 2 用例：场景边界分裂
  it('场景边界分裂：hamming=50/55/58 三连大差分 → sceneIndex 从 1→4（3 次分裂）', async () => {
    // 构造 7 帧 hash，对应差分位置：
    // frame1.diffToPrev=50（frame0~1）、frame3.diffToPrev=55、frame4.diffToPrev=58
    // → splitSceneBoundary 应按 hamming>40 分裂 → sceneIndex：[1, 2, 2, 3, 4, 4, 4]
    const frames = Array.from({ length: 7 }, (_, i) => makeFrameMem(i, { sceneIndex: 1 }));
    // 用自定义 DiffFn 直接注入差分
    const mockDiffFn: DiffFn = (_a, _b, pairIndex?: number) => {
      // DiffFn 参数（hashA, hashB, pairIndex = 后一帧在 frames 的 index = pairIndex = i from 1..n-1）
      // 这里用后一帧的 index
      if (pairIndex === 1) return 50;
      if (pairIndex === 3) return 55;
      if (pairIndex === 4) return 58;
      return 5; // 其余普通差分
    };
    const scored = await InSceneDiffSampler.scoreFramesDiff(frames, mockDiffFn);
    const split = InSceneDiffSampler.splitSceneBoundary(scored, 40);
    const sceneIndexes = split.map(s => s.sceneIndex);
    // 预期 sceneIndex 序列：[1, 2, 2, 3, 4, 4, 4]（3 次分裂 → 最大 sceneIndex=4）
    expect(sceneIndexes).toEqual([1, 2, 2, 3, 4, 4, 4]);
  });

  // 第 3 用例：动作峰值命中
  it('动作峰值判定：差分序列 [10,8,45,7,9] 中心 45 > 前后均值 × 1.5 → detectActionPeaks 返回该帧 path', async () => {
    const frames = Array.from({ length: 5 }, (_, i) => makeFrameMem(i));
    const mockDiffFn: DiffFn = (_a, _b, pairIndex) => {
      // pairIndex 1..4 对应 4 段差分 → 序列 = [10, 8, 45, 7]（与 9 无关？中心帧 i=2 的中心差分对应 pairIndex=2 = 45）
      // 窗口 N=3：以当前帧的 diffToPrev（当前=该帧前的差分）和 下一帧 diffToPrev（该帧与下一帧间差分）组成前后均值
      // 帧 i=2 的 diffToPrev = pairIndex=2 值 = 45，作为中心；帧 i=2 后序差分 = pairIndex=3 对应值 = 7；前序差分 = 帧 i=1 的 diffToPrev = pairIndex=1 = 8
      // 所以需要 pairIndex 1..4 返回 [8, 45, 7, 9]（即 idx=1 前后差分 8；idx=2 差分 45；idx=3 差分 7；idx=4 差分 9）
      // 这样中心帧 i=2 窗口 = [prev=8, center=45, next=7] → 均值 = (8+7)/2=7.5 × 1.5 = 11.25，45>11.25 → 峰值 = frames[2].framePath
      if (pairIndex === 1) return 8;
      if (pairIndex === 2) return 45;
      if (pairIndex === 3) return 7;
      if (pairIndex === 4) return 9;
      return 0;
    };
    const scored = await InSceneDiffSampler.scoreFramesDiff(frames, mockDiffFn);
    const peaks = InSceneDiffSampler.detectActionPeaks(scored, { strategy: 'AUTO_ADAPTIVE' });
    expect(peaks).toHaveLength(1);
    expect(peaks[0]).toBe(frames[2].framePath);
  });

  // 第 4 用例：动作峰值不命中
  it('动作峰值不命中：差分序列 [10,11,12,10,9]（无跳变）→ 返回空数组', async () => {
    const frames = Array.from({ length: 5 }, (_, i) => makeFrameMem(i));
    const mockDiffFn: DiffFn = (_a, _b, pairIndex) => {
      // pairIndex 1..4 → [10, 11, 12, 10]（帧 i=2 对应 pairIndex=2=11；窗口 = [10,11,12]，均值 11 → 11×1.5=16.5，11<16.5 → 不命中）
      if (pairIndex === 1) return 10;
      if (pairIndex === 2) return 11;
      if (pairIndex === 3) return 12;
      if (pairIndex === 4) return 10;
      return 0;
    };
    const scored = await InSceneDiffSampler.scoreFramesDiff(frames, mockDiffFn);
    const peaks = InSceneDiffSampler.detectActionPeaks(scored, { strategy: 'AUTO_ADAPTIVE' });
    expect(peaks).toHaveLength(0);
  });

  // 第 5 用例：光效帧剔除（luma 跳变 > 100）
  it('光效帧剔除：lumaPrev=50 lumaCur=200（差 150 > threshold=100）→ diff=50 跳变也不进白名单', async () => {
    // 帧 2 的 lumaScore = 200，帧 1 的 lumaScore = 50 → 前后差 = 150 > lumaJumpThreshold=100
    const frames = Array.from({ length: 5 }, (_, i) => makeFrameMem(i));
    frames[1].lumaScore = 50;
    frames[2].lumaScore = 200; // 帧 2 前序 luma 差 150
    // 差分序列构造：帧 2 对应 pairIndex=2 的 diff=50（刚好是动作峰值）→ 但 luma 跳变超阈值应剔除
    const mockDiffFn: DiffFn = (_a, _b, pairIndex) => {
      if (pairIndex === 1) return 10;
      if (pairIndex === 2) return 50; // 满足动作峰值条件
      if (pairIndex === 3) return 8;
      if (pairIndex === 4) return 12;
      return 0;
    };
    const scored = await InSceneDiffSampler.scoreFramesDiff(frames, mockDiffFn);
    // lumaJumpThreshold=100（默认）
    const peaks = InSceneDiffSampler.detectActionPeaks(scored, { strategy: 'AUTO_ADAPTIVE', lumaJumpThreshold: 100 });
    // frames[2] 因为 luma 跳变超阈值 → 被剔除，结果应为空
    expect(peaks).toHaveLength(0);
  });

  // 第 6 用例：priorityFlags 合并不覆盖 upstream
  it('priorityFlags 合并：上游已传 hardCut → buildPriorityFlags 不覆盖原有 flags，同时追加 action_peak', () => {
    const frameHardcutPath = '/fake/dir/frame_hardcut.jpg';
    const framePeakOnlyPath = '/fake/dir/frame_peak_only.jpg';
    const existing: Record<string, BudgetClipPriorityFlag[]> = {
      [frameHardcutPath]: ['hardCut'],
    };
    const merged = InSceneDiffSampler.buildPriorityFlags(
      [frameHardcutPath, framePeakOnlyPath],
      existing
    );
    // 上游 hardCut 帧：保留原有 'hardCut' 同时追加 'action_peak'
    expect(merged[frameHardcutPath]).toEqual(expect.arrayContaining(['hardCut']));
    expect(merged[frameHardcutPath]).toEqual(expect.arrayContaining(['action_peak']));
    // 纯新动作峰值帧：只有 'action_peak'
    expect(merged[framePeakOnlyPath]).toEqual(['action_peak']);
    // existing 原对象不被修改（immutable 行为）
    expect(existing[frameHardcutPath]).toEqual(['hardCut']);
  });

  // 第 7 用例：边界空输入
  it('边界：空帧列表 → scoreFramesDiff / detectActionPeaks / buildPriorityFlags 都不抛错且返回空', async () => {
    const scored = await InSceneDiffSampler.scoreFramesDiff([]);
    expect(scored).toEqual([]);
    const peaks = InSceneDiffSampler.detectActionPeaks([], { strategy: 'AUTO_ADAPTIVE' });
    expect(peaks).toEqual([]);
    const flags = InSceneDiffSampler.buildPriorityFlags([], undefined);
    expect(flags).toEqual({});
  });

  // 第 8 用例：边界单帧
  it('边界：单帧（不足窗口 N=3）→ 不抛错，动作峰值返回 []，sceneIndex=1', async () => {
    const frames = [makeFrameMem(0, { sceneIndex: 99 })]; // 原 sceneIndex=99
    // 传 mock DiffFn（空实现，避免 needComputeHash 触发 sharp 访问不存在的磁盘文件）
    const mockNoop: DiffFn = () => 0;
    const scored = await InSceneDiffSampler.scoreFramesDiff(frames, mockNoop);
    expect(scored).toHaveLength(1);
    expect(scored[0].diffToPrev).toBe(0);
    const split = InSceneDiffSampler.splitSceneBoundary(scored, 40);
    // 单帧无法差分，sceneIndex 重置为 1（P0 语义失真修复：差分分裂后从 1 重新编号）
    expect(split[0].sceneIndex).toBe(1);
    const peaks = InSceneDiffSampler.detectActionPeaks(scored, { strategy: 'AUTO_ADAPTIVE' });
    expect(peaks).toHaveLength(0);
  });

  // 第 9 用例：边界双帧
  it('边界：双帧 → 不抛错，sceneIndex 分裂 1 次（hamming>40），动作峰值空', async () => {
    const frames = [makeFrameMem(0), makeFrameMem(1)];
    const mockDiffFn: DiffFn = (_a, _b, pairIndex) => (pairIndex === 1 ? 50 : 0); // 差分 50 > 40
    const scored = await InSceneDiffSampler.scoreFramesDiff(frames, mockDiffFn);
    const split = InSceneDiffSampler.splitSceneBoundary(scored, 40);
    // frame0 sceneIndex=1；frame1 diffToPrev=50>40 → sceneIndex=2
    expect(split[0].sceneIndex).toBe(1);
    expect(split[1].sceneIndex).toBe(2);
    const peaks = InSceneDiffSampler.detectActionPeaks(scored, { strategy: 'AUTO_ADAPTIVE' });
    expect(peaks).toHaveLength(0); // 双帧不足 N=3 窗口
  });

  // 第 10 用例：aHash 缓存不变式（precomputedHashes 命中时，computeHash 不调用）
  it('aHash 缓存不变式：precomputedHashes 注入 10 个 hash → scoreFramesDiff 内部 computeHash 调用次数 = 0', async () => {
    // 先 mock SmartFramePostProcessor.computeHash，因为 InSceneDiffSampler.scoreFramesDiff 内部会调用它
    const { SmartFramePostProcessor } = await import('../backend/SmartFramePostProcessor');
    const spy = vi.spyOn(SmartFramePostProcessor, 'computeHash').mockResolvedValue('FROMSHARP');
    try {
      const frames = Array.from({ length: 10 }, (_, i) => makeFrameMem(i));
      const precomputed = new Map<string, string>();
      frames.forEach((f, i) => precomputed.set(f.framePath, `hash_${i}`)); // 全命中
      await InSceneDiffSampler.scoreFramesDiff(frames, undefined, precomputed);
      // 全命中 → computeHash 不应被调
      expect((spy as Mock).mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  // 第 11 用例：strategy gate（UNIFORM_FPS 跳过差分，动作峰值返回空）
  it('strategy gate：UNIFORM_FPS → detectActionPeaks 直返空数组（即使有差分跳变）', async () => {
    const frames = Array.from({ length: 5 }, (_, i) => makeFrameMem(i));
    const mockDiffFn: DiffFn = (_a, _b, pairIndex) => {
      if (pairIndex === 2) return 50; // 大差分（否则条件同上第 3 用例）
      return 5;
    };
    const scored = await InSceneDiffSampler.scoreFramesDiff(frames, mockDiffFn);
    // strategy='UNIFORM_FPS' 归一化后 gate
    const peaks = InSceneDiffSampler.detectActionPeaks(scored, { strategy: 'UNIFORM_FPS' });
    expect(peaks).toHaveLength(0);
    // 同时 AUTO_ADAPTIVE 策略下同样 diff 应该返回峰值（对照组）
    const peaksAuto = InSceneDiffSampler.detectActionPeaks(scored, { strategy: 'AUTO_ADAPTIVE' });
    expect(peaksAuto.length).toBeGreaterThanOrEqual(1);
  });
});
