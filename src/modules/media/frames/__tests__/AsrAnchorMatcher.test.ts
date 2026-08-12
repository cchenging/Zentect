// 📁 路径：src/modules/media/frames/__tests__/AsrAnchorMatcher.test.ts
// P2 · AsrAnchorMatcher TDD 测试：
//   验证帧 ↔ ASR 台词吸附 + priorityFlags 合并不覆盖 + strategy gate。
import { describe, it, expect } from 'vitest';
import { AsrAnchorMatcher, type AsrAnchoringConfig } from '../backend/AsrAnchorMatcher';
import type { BudgetClipPriorityFlag } from '../backend/BudgetClipper';
import type { FrameAssetDetail } from '../types';
import type { AsrLine } from '../../../../shared/types/entities/editor';

/** 生成一条假帧数据（纯内存，无磁盘 I/O） */
function makeFrame(
  idx: number,
  timeMs: number,
  overrides: Partial<FrameAssetDetail> = {}
): FrameAssetDetail {
  const totalSec = Math.floor(timeMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  const ms = String(timeMs % 1000).padStart(3, '0').slice(0, 2);
  return {
    framePath: `/tmp/dir/frame_${String(idx).padStart(4, '0')}.jpg`,
    timeMs,
    timeStr: `${mm}:${ss}.${ms}`,
    clarityScore: 0.8,
    lumaScore: 128,
    sceneIndex: 1,
    ...overrides,
  };
}

/** 生成一条假 ASR 台词（纯内存，无磁盘 I/O） */
function makeAsr(startMs: number, endMs: number, text: string, overrides: Partial<AsrLine> = {}): AsrLine {
  return {
    start: '',
    startMs,
    end: '',
    endMs,
    text,
    editing: false,
    ...overrides,
  };
}

describe('AsrAnchorMatcher', () => {
  // ── 用例 1：单帧单台词匹配（距离≤tolerance） ───────────────────────────────
  it('用例1：单帧(1500ms) + 单台词(1000-2000ms, center=1500) → 帧被吸附为 asrAnchor', () => {
    const frames = [makeFrame(0, 1500)];
    const asrLines = [makeAsr(1000, 2000, '台词1')];
    const opts: AsrAnchoringConfig = { toleranceMs: 2000 };

    const { anchoredCount, anchoredFramePaths } = AsrAnchorMatcher.matchFramesToAsr(
      frames, asrLines, opts,
    );

    expect(anchoredCount).toBe(1);
    expect(anchoredFramePaths.has(frames[0].framePath)).toBe(true);
  });

  // ── 用例 2：超出 tolerance → 不匹配 ──────────────────────────────────────
  it('用例2：单帧(1500ms) + 单台词(4000-6000ms, center=5000) 且 tolerance=1000ms → 零吸附', () => {
    const frames = [makeFrame(0, 1500)];
    const asrLines = [makeAsr(4000, 6000, '台词2')];
    const opts: AsrAnchoringConfig = { toleranceMs: 1000 };

    const { anchoredCount, anchoredFramePaths } = AsrAnchorMatcher.matchFramesToAsr(
      frames, asrLines, opts,
    );

    expect(anchoredCount).toBe(0);
    expect(anchoredFramePaths.size).toBe(0);
  });

  // ── 用例 3：多台词 → 多帧吸附（1 对 1） ───────────────────────────────────
  it('用例3：3 条台词均匀分布 + 5 帧 → 3 张帧被分别吸附为 asrAnchor（不重复）', () => {
    const frames = [
      makeFrame(0, 1000),   // ≈ line1 center=1200
      makeFrame(1, 3000),   // ≈ line2 center=3200
      makeFrame(2, 5000),   // ≈ line3 center=5200
      makeFrame(3, 7000),
      makeFrame(4, 9000),
    ];
    const asrLines = [
      makeAsr(1000, 1400, '开头台词'),
      makeAsr(3000, 3400, '中段台词'),
      makeAsr(5000, 5400, '收尾台词'),
    ];
    const opts: AsrAnchoringConfig = { toleranceMs: 1500 };

    const { anchoredCount, anchoredFramePaths, asrLineIndexByPath } = AsrAnchorMatcher.matchFramesToAsr(
      frames, asrLines, opts,
    );

    expect(anchoredCount).toBe(3);
    expect(anchoredFramePaths.size).toBe(3);
    // 路径 1→line0, 路径2→line1, 路径3→line2
    expect(asrLineIndexByPath.get(frames[0].framePath)).toBe(0);
    expect(asrLineIndexByPath.get(frames[1].framePath)).toBe(1);
    expect(asrLineIndexByPath.get(frames[2].framePath)).toBe(2);
  });

  // ── 用例 4：空台词跳过（text.trim()=空 或 缺失 startMs/endMs 非法） ─────────
  it('用例4：3 条台词中 1 条空 1 条太短(minTextLength=4) → 仅 1 条有效台词有吸附', () => {
    const frames = [
      makeFrame(0, 1000),   // line1 (有效)
      makeFrame(1, 3000),   // line2 (空 text → 跳过)
      makeFrame(2, 5000),   // line3 (短 text="Hi" < 4 → 跳过)
    ];
    const asrLines = [
      makeAsr(500, 1500, '有效长台词'),
      makeAsr(2500, 3500, ''),            // 空 → 过滤
      makeAsr(4500, 5500, 'Hi'),          // 长度 2 < minTextLength 4 → 过滤
    ];
    const opts: AsrAnchoringConfig = { toleranceMs: 2000, minTextLength: 4 };

    const { anchoredCount, asrLineIndexByPath } = AsrAnchorMatcher.matchFramesToAsr(
      frames, asrLines, opts,
    );

    expect(anchoredCount).toBe(1);
    // 有效匹配 = 第 0 条台词 → frames[0]
    expect(asrLineIndexByPath.get(frames[0].framePath)).toBe(0);
    // frame[1]/[2] 没匹配（无效台词被跳过）
    expect(asrLineIndexByPath.has(frames[1].framePath)).toBe(false);
    expect(asrLineIndexByPath.has(frames[2].framePath)).toBe(false);
  });

  // ── 用例 5：多帧等距 → 选更早的帧（稳定性） ─────────────────────────────
  it('用例5：两帧等距(1000ms 和 2000ms，台词 center=1500) → 吸附更早一帧（时间轴稳定性）', () => {
    const frames = [
      makeFrame(0, 1000),
      makeFrame(1, 2000),
    ];
    const asrLines = [makeAsr(1000, 2000, '等距台词')];
    const opts: AsrAnchoringConfig = { toleranceMs: 2000 };

    const { anchoredFramePaths } = AsrAnchorMatcher.matchFramesToAsr(
      frames, asrLines, opts,
    );

    expect(anchoredFramePaths.has(frames[0].framePath)).toBe(true);
    expect(anchoredFramePaths.has(frames[1].framePath)).toBe(false);
  });

  // ── 用例 6：UNIFORM_FPS strategy gate → 空吸附（保持均匀优先） ─────────
  it('用例6：strategy=UNIFORM_FPS → gate 零吸附（不变式：不干扰均匀抽帧策略）', () => {
    const frames = [makeFrame(0, 1500)];
    const asrLines = [makeAsr(1000, 2000, '台词')];
    const opts: AsrAnchoringConfig = { toleranceMs: 2000, strategy: 'UNIFORM_FPS' };

    const { anchoredCount, skippedByStrategy } = AsrAnchorMatcher.matchFramesToAsr(
      frames, asrLines, opts,
    );

    expect(anchoredCount).toBe(0);
    expect(skippedByStrategy).toBe(true);
  });

  // ── 用例 7：buildPriorityFlags · 合并不覆盖 upstream hardCut ────────────
  it('用例7：priorityFlags 合并不覆盖 upstream（已有 hardCut 不丢，asrAnchor 追加）', () => {
    const frameHardcutPath = '/tmp/hardcut.jpg';
    const frameAnchorPath = '/tmp/anchor.jpg';
    const existing: Record<string, BudgetClipPriorityFlag[]> = {
      [frameHardcutPath]: ['hardCut'],
    };

    const merged = AsrAnchorMatcher.buildPriorityFlags(
      new Set([frameHardcutPath, frameAnchorPath]),
      existing,
    );

    // hardCut 保留（不被覆盖）
    expect(merged[frameHardcutPath]?.includes('hardCut')).toBe(true);
    // asrAnchor 追加（同 frameHardcutPath 也吸附了）
    expect(merged[frameHardcutPath]?.includes('asrAnchor')).toBe(true);
    // frameAnchorPath 只有 asrAnchor
    expect(merged[frameAnchorPath]).toEqual(['asrAnchor']);
  });

  // ── 用例 8：同帧多次台词 → 白名单只加 1 次 asrAnchor（去重） ──────────────
  it('用例8：同帧被 3 条台词匹配 → priorityFlags 中 asrAnchor 只出现一次（不重复）', () => {
    const frames = [makeFrame(0, 3000)];
    const asrLines = [
      makeAsr(2000, 2500, '台词1'),  // center 2250 → Δ=750
      makeAsr(2500, 3000, '台词2'),  // center 2750 → Δ=250（best）
      makeAsr(3000, 4000, '台词3'),  // center 3500 → Δ=500
    ];
    const opts: AsrAnchoringConfig = { toleranceMs: 2000 };

    const { anchoredCount, asrLineIndexByPath, anchoredFramePaths } = AsrAnchorMatcher.matchFramesToAsr(
      frames, asrLines, opts,
    );

    expect(anchoredCount).toBe(1);
    expect(anchoredFramePaths.size).toBe(1);
    // 最佳匹配 = line1（delta 最小），不是 line2 更晚的台词
    expect(asrLineIndexByPath.get(frames[0].framePath)).toBe(1);

    const flags = AsrAnchorMatcher.buildPriorityFlags(anchoredFramePaths);
    const flagArr = flags[frames[0].framePath] || [];
    const asrAnchorCount = flagArr.filter(f => f === 'asrAnchor').length;
    expect(asrAnchorCount).toBe(1);
  });

  // ── 用例 9：边界：零帧 / 零台词 → 零吸附 ────────────────────────────────
  it('用例9：空 frames 数组 / 空 asrLines → 零吸附（不 crash，全零返回）', () => {
    const frames = [makeFrame(0, 1000)];
    const asrLines = [makeAsr(1000, 2000, '台词')];

    const rEmptyFrames = AsrAnchorMatcher.matchFramesToAsr([], asrLines);
    const rEmptyAsr = AsrAnchorMatcher.matchFramesToAsr(frames, []);

    expect(rEmptyFrames.anchoredCount).toBe(0);
    expect(rEmptyFrames.anchoredFramePaths.size).toBe(0);
    expect(rEmptyAsr.anchoredCount).toBe(0);
    expect(rEmptyAsr.anchoredFramePaths.size).toBe(0);
  });

  // ── 用例 10：ASR 起点 0ms 的首帧吸附 ────────────────────────────────────
  it('用例10：首帧 timeMs=0 + 台词 startMs=0 endMs=500 (center=250) → 首帧吸附为 asrAnchor', () => {
    const frames = [
      makeFrame(0, 0),
      makeFrame(1, 2000),
    ];
    const asrLines = [makeAsr(0, 500, '开场')];
    const opts: AsrAnchoringConfig = { toleranceMs: 2000 };

    const { anchoredFramePaths } = AsrAnchorMatcher.matchFramesToAsr(
      frames, asrLines, opts,
    );

    expect(anchoredFramePaths.has(frames[0].framePath)).toBe(true);
  });

  // ── 用例 11：matchMode=start（吸附台词开头）vs matchMode=center 默认 ─────
  it('用例11：matchMode=start → 吸附离台词 startMs 最近的帧（而非默认 center）', () => {
    const frames = [
      makeFrame(0, 1000),   // startMode: Δ=0 → 最佳；centerMode: Δ=1000
      makeFrame(1, 2000),   // startMode: Δ=1000；centerMode: Δ=0 → 最佳（不同模式选不同帧）
    ];
    const asrLines = [makeAsr(1000, 3000, '开场模式对比')];

    const rStart = AsrAnchorMatcher.matchFramesToAsr(frames, asrLines, {
      toleranceMs: 3000, matchMode: 'start',
    });
    const rCenter = AsrAnchorMatcher.matchFramesToAsr(frames, asrLines, {
      toleranceMs: 3000, matchMode: 'center',
    });

    expect(rStart.anchoredFramePaths.has(frames[0].framePath)).toBe(true);
    expect(rStart.anchoredFramePaths.has(frames[1].framePath)).toBe(false);
    expect(rCenter.anchoredFramePaths.has(frames[1].framePath)).toBe(true);
    expect(rCenter.anchoredFramePaths.has(frames[0].framePath)).toBe(false);
  });
});
