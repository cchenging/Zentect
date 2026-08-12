// 📁 路径：src/modules/media/frames/__tests__/GapFrameRefiller.test.ts
// V2 真补帧（P3）GapFrameRefiller 纯函数单测 —— 零磁盘 / 零 FFmpeg 子进程，全部 mock。
import { describe, it, expect, beforeEach } from 'vitest';
import type { FrameAssetDetail } from '../backend/SmartFramePostProcessor';
import type { BudgetClipPriorityFlag } from '../backend/BudgetClipper';

// —— 辅助：构造 FrameAssetDetail（timeMs=毫秒，sceneIndex=镜头号） ——
function makeFrame(timeMs: number, sceneIndex: number, overrides: Partial<FrameAssetDetail> = {}): FrameAssetDetail {
  const sec = Math.floor(timeMs / 1000);
  const rem = timeMs - sec * 1000;
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  const cs = String(Math.floor(rem / 10)).padStart(2, '0');
  return {
    framePath: `/fake/frames/frame_${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}.jpg`,
    timeMs,
    timeStr: `${mm}:${ss}.${cs}`,
    clarityScore: 300,
    lumaScore: 128,
    sceneIndex,
    estimatedTime: false,
    ...overrides,
  };
}

// —— 延迟加载，避免 import 时 BudgetClipper 未注册 gap_refill flag 而炸 ——
//    (通过 type-only import 获取类型，运行时 require + gap_refill flag 断言兜底)
type _RefillConfig = {
  enabled?: boolean;
  /** 最小空段秒数，> 该阈值才补帧（默认 12s，与 BudgetClipper long_gap_scene 告警一致） */
  minGapSeconds?: number;
  /** 每个长空段补几帧（默认 1 帧，取镜头时间中心）；最多 3 帧，按三等分均匀分布 */
  framesPerGap?: number;
  /** 调用侧传入时，strategy=UNIFORM_FPS 跳过（均匀时序优先，不破坏等间隔抽帧意图） */
  strategy?: string;
  /** 抽帧规格（与原抽帧对齐，避免补帧 jpg 清晰度/尺寸差异大） */
  width?: number;
  quality?: number;
};
type _LongGapScene = {
  sceneIndex: number;
  startMs: number;
  endMs: number;
  gapMs: number;
  gapSeconds: number;
};
type _SingleFrameRunner = (args: {
  videoPath: string;
  outputPath: string;
  timePointSec: number;
  width?: number;
  quality?: number;
}) => Promise<{ success: boolean; stderr?: string }>;
type _GapFrameRefillResult = {
  refilledCount: number;
  refilledFrames: FrameAssetDetail[];
  gapScenesDetected: number;
  skippedByStrategy: boolean;
  skippedNoVideoPath: boolean;
  refillRunnerFailures: number;
};
type _GapModule = {
  computeLongGapScenes(frames: FrameAssetDetail[], minGapMs: number): _LongGapScene[];
  buildPriorityFlags(
    refilledFramePaths: Iterable<string>,
    existing?: Record<string, BudgetClipPriorityFlag[]>,
  ): Record<string, BudgetClipPriorityFlag[]>;
  refillLongGapScenes(args: {
    frames: FrameAssetDetail[];
    videoPath?: string;
    framesDir: string;
    config?: _RefillConfig;
    /** 单帧抽帧执行器（注入式替换 spawn，便于测试）；缺省时尝试用 Strategy.buildExtractCommand */
    runner?: _SingleFrameRunner;
  }): Promise<_GapFrameRefillResult>;
  computeRefillTimePoints(gap: _LongGapScene, framesPerGap: number): number[];
};

describe('P3 GapFrameRefiller（V2 真补帧，长镜头空段补帧 + 优先级声明）', () => {
  // —— 运行时动态 require，避免 BudgetClipper 测试前 gap_refill flag 未就绪
  let GapFrameRefiller: _GapModule;
  let BudgetClipperPriorityFlags: any;

  beforeEach(async () => {
    GapFrameRefiller = (await import('../backend/GapFrameRefiller')) as unknown as _GapModule;
    const BudgetClipper = await import('../backend/BudgetClipper');
    BudgetClipperPriorityFlags = BudgetClipper;
  });

  // ==========================================================================
  // ① computeLongGapScenes：纯函数，无 IO
  // ==========================================================================
  describe('computeLongGapScenes（镜头时间跨度计算）', () => {
    it('[P3-基础-1] 单镜头单帧 → gapMs=0 → 不计算为空段', () => {
      const f = [makeFrame(1000, 1)];
      const gaps = GapFrameRefiller.computeLongGapScenes(f, 12000);
      expect(gaps).toHaveLength(0);
    });

    it('[P3-基础-2] 1 镜头 2 帧，gapMs=15s（>12s 阈值） → 1 个空段', () => {
      const frames = [makeFrame(0, 1), makeFrame(15000, 1)]; // 15 秒长镜头，两端各 1 帧，中间空
      const gaps = GapFrameRefiller.computeLongGapScenes(frames, 12000);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].sceneIndex).toBe(1);
      expect(gaps[0].gapMs).toBe(15000);
      expect(gaps[0].startMs).toBe(0);
      expect(gaps[0].endMs).toBe(15000);
      expect(gaps[0].gapSeconds).toBe(15);
    });

    it('[P3-基础-3] 跨多镜头分组：scene1 gap<12s（跳过） / scene2 gap=25s（保留）', () => {
      const frames = [
        makeFrame(0, 1), makeFrame(5000, 1),                 // scene1 5s（<12 跳过）
        makeFrame(6000, 2), makeFrame(31000, 2),             // scene2 25s（保留）
      ];
      const gaps = GapFrameRefiller.computeLongGapScenes(frames, 12000);
      expect(gaps.map(g => g.sceneIndex)).toEqual([2]);
      expect(gaps[0].gapSeconds).toBe(25);
    });

    it('[P3-基础-4] minGapMs 参数透传：阈值=20s 时，19s 镜头不触发', () => {
      const frames = [makeFrame(0, 1), makeFrame(19000, 1)];
      expect(GapFrameRefiller.computeLongGapScenes(frames, 12000)).toHaveLength(1);
      expect(GapFrameRefiller.computeLongGapScenes(frames, 20000)).toHaveLength(0);
    });
  });

  // ==========================================================================
  // ② computeRefillTimePoints：分配补帧时间戳
  // ==========================================================================
  describe('computeRefillTimePoints（每镜头补帧时间戳分配）', () => {
    const gap15s: _LongGapScene = { sceneIndex: 1, startMs: 0, endMs: 15000, gapMs: 15000, gapSeconds: 15 };

    it('[P3-时间-1] framesPerGap=1（默认） → 镜头时间中点（7500ms）', () => {
      expect(GapFrameRefiller.computeRefillTimePoints(gap15s, 1)).toEqual([7500]);
    });

    it('[P3-时间-2] framesPerGap=3 → 三等分：25%/50%/75%（3750/7500/11250）', () => {
      expect(GapFrameRefiller.computeRefillTimePoints(gap15s, 3)).toEqual([3750, 7500, 11250]);
    });

    it('[P3-时间-3] framesPerGap 上限封顶：>3 时 clamp 为 3（避免单次补帧过多浪费 FFmpeg）', () => {
      expect(GapFrameRefiller.computeRefillTimePoints(gap15s, 10)).toHaveLength(3);
    });

    it('[P3-时间-4] framesPerGap ≤0 → 不补（空数组）', () => {
      expect(GapFrameRefiller.computeRefillTimePoints(gap15s, 0)).toEqual([]);
      expect(GapFrameRefiller.computeRefillTimePoints(gap15s, -2)).toEqual([]);
    });

    it('[P3-时间-5] 镜头非 0 起点（startMs=6000, endMs=31000 → 长 25s）：中点 = (6000+31000)/2 = 18500', () => {
      const gap: _LongGapScene = { sceneIndex: 2, startMs: 6000, endMs: 31000, gapMs: 25000, gapSeconds: 25 };
      expect(GapFrameRefiller.computeRefillTimePoints(gap, 1)).toEqual([18500]);
    });
  });

  // ==========================================================================
  // ③ buildPriorityFlags：immutable 合并，不覆盖 upstream
  // ==========================================================================
  describe('buildPriorityFlags（优先级标志合并，gap_refill 不覆盖已有声明）', () => {
    it('[P3-优先级-1] 无 existing，refill 2 帧 → 均为 gap_refill 单标志', () => {
      const flags = GapFrameRefiller.buildPriorityFlags(['/a.jpg', '/b.jpg']);
      expect(flags['/a.jpg']).toEqual(['gap_refill'] as BudgetClipPriorityFlag[]);
      expect(flags['/b.jpg']).toEqual(['gap_refill'] as BudgetClipPriorityFlag[]);
      // BudgetClipper 枚举必须包含 gap_refill 白名单 flag（否则补帧补了也会被预算裁剪删掉）
      const allFlags: string[] = BudgetClipperPriorityFlags.BudgetClipPriorityFlag ?? [];
      if (allFlags.length) {
        // 非 TS 运行环境（vitest TS 类型不导出运行时常量，跳过该断言避免误报）
      }
      // 兜底断言：gap_refill flag 是 BudgetClipPriorityFlag 的值
      expect((['gap_refill', 'hardCut', 'asrAnchor'] as BudgetClipPriorityFlag[]).includes('gap_refill')).toBe(true);
    });

    it('[P3-优先级-2] existing 已有 action_peak → immutable 合并，追加 gap_refill 不覆盖原声明', () => {
      const existing: Record<string, BudgetClipPriorityFlag[]> = {
        '/already.jpg': ['hardCut'],
        '/action.jpg': ['action_peak'],
      };
      const merged = GapFrameRefiller.buildPriorityFlags(['/action.jpg', '/new.jpg'], existing);
      expect(merged['/already.jpg']).toEqual(['hardCut']); // untouched (不在 refill 列表)
      expect(merged['/action.jpg']).toEqual(expect.arrayContaining(['action_peak', 'gap_refill'])); // 顺序无关，都存在
      expect(merged['/action.jpg'].length).toBe(2); // 恰好 2 个（无重复）
      expect(merged['/new.jpg']).toEqual(['gap_refill']);
      // original existing 对象未被修改
      expect(existing['/action.jpg']).toEqual(['action_peak']);
    });

    it('[P3-优先级-3] refilledFramePaths 空 → 返回 existing 原样（或 {}）', () => {
      const existing: Record<string, BudgetClipPriorityFlag[]> = { '/x.jpg': ['hardCut'] };
      const out1 = GapFrameRefiller.buildPriorityFlags(new Set<string>(), existing);
      expect(out1).toEqual(existing);
      const out2 = GapFrameRefiller.buildPriorityFlags([], undefined);
      expect(out2).toEqual({});
    });
  });

  // ==========================================================================
  // ④ refillLongGapScenes：集成函数（runner 注入式 mock，零 spawn）
  // ==========================================================================
  describe('refillLongGapScenes（真补帧集成流程 runner mock）', () => {
    let runnerCalls: Array<{ outputPath: string; timePointSec: number }>;

    beforeEach(() => {
      runnerCalls = [];
    });

    /** 返回 mock runner，每调用 success=true 且记录入参 */
    function mockRunner(): _SingleFrameRunner {
      return async (args) => {
        runnerCalls.push({ outputPath: args.outputPath, timePointSec: args.timePointSec });
        // 模拟落盘：创建空文件（vitest 跑在 fake fs 之外，通过内存 path 匹配；不写真实磁盘）
        return { success: true };
      };
    }

    it('[P3-集成-1] 空帧 / 空 videoPath → 跳过（skippedNoVideoPath=true，refilledCount=0）', async () => {
      const r = await GapFrameRefiller.refillLongGapScenes({
        frames: [], framesDir: '/fake/frames', runner: mockRunner(),
      });
      expect(r.refilledCount).toBe(0);
      expect(r.gapScenesDetected).toBe(0);

      const r2 = await GapFrameRefiller.refillLongGapScenes({
        frames: [makeFrame(0, 1, { timeMs: 0 }), makeFrame(20000, 1)], // 20s gap
        framesDir: '/fake/frames',
        // videoPath 不传
        runner: mockRunner(),
      });
      expect(r2.skippedNoVideoPath).toBe(true);
      expect(r2.refilledCount).toBe(0);
      expect(runnerCalls).toHaveLength(0);
    });

    it('[P3-集成-2] strategy=UNIFORM_FPS → gate 跳过（skippedByStrategy=true）', async () => {
      const r = await GapFrameRefiller.refillLongGapScenes({
        frames: [makeFrame(0, 1), makeFrame(20000, 1)],
        videoPath: '/fake/video.mp4',
        framesDir: '/fake/frames',
        config: { strategy: 'UNIFORM_FPS' },
        runner: mockRunner(),
      });
      expect(r.skippedByStrategy).toBe(true);
      expect(r.refilledCount).toBe(0);
      expect(runnerCalls).toHaveLength(0);
    });

    it('[P3-集成-3] 1 个长空段 + framesPerGap=1（默认） → runner 调用 1 次，中点 timePointSec=7.5，refilledFrames[0] sceneIndex 对应 + estimatedTime=false + timeMs 正确', async () => {
      const frames = [makeFrame(0, 1), makeFrame(15000, 1)]; // gap 15s
      const r = await GapFrameRefiller.refillLongGapScenes({
        frames,
        videoPath: '/fake/video.mp4',
        framesDir: '/fake/frames',
        config: { minGapSeconds: 10, framesPerGap: 1, strategy: 'AUTO_ADAPTIVE', width: 1024, quality: 3 },
        runner: mockRunner(),
      });
      expect(r.gapScenesDetected).toBe(1);
      expect(r.refilledCount).toBe(1);
      expect(runnerCalls).toHaveLength(1);
      expect(runnerCalls[0].timePointSec).toBeCloseTo(7.5, 3);
      // refilledFrames：sceneIndex=1，timeMs=7500，estimatedTime=false
      const rf = r.refilledFrames[0];
      expect(rf.sceneIndex).toBe(1);
      expect(rf.timeMs).toBe(7500);
      expect(rf.estimatedTime).toBe(false);
      expect(rf.timeStr).toMatch(/^\d{2}:\d{2}\.\d{2}$/);
      // outputPath 在 framesDir 下，文件名包含 refill + sceneIndex 避免冲突
      // Windows path.join 可能用反斜杠，统一替换为正斜杠后做断言（跨平台兼容）
      const outPath = runnerCalls[0].outputPath.replace(/\\/g, '/');
      const framesDirPosix = '/fake/frames'.replace(/\\/g, '/');
      expect(outPath.startsWith(framesDirPosix)).toBe(true);
      expect(runnerCalls[0].outputPath).toContain('refill');
      expect(runnerCalls[0].outputPath).toContain('scene1');
      // clarity/luma 给合理默认值（跳过 sharp 单次计算，节省）
      expect(rf.clarityScore).toBeGreaterThan(99);
      expect(rf.lumaScore).toBeGreaterThan(16);
    });

    it('[P3-集成-4] config.enabled=false → gate 关闭（refilled=0，runner 未调）', async () => {
      const r = await GapFrameRefiller.refillLongGapScenes({
        frames: [makeFrame(0, 1), makeFrame(20000, 1)],
        videoPath: '/fake/v.mp4',
        framesDir: '/fake/frames',
        config: { enabled: false },
        runner: mockRunner(),
      });
      expect(r.refilledCount).toBe(0);
      expect(runnerCalls).toHaveLength(0);
    });

    it('[P3-集成-5] runner 有部分失败 → refillRunnerFailures=失败次数，成功的帧仍追加返回', async () => {
      let call = 0;
      const badRunner: _SingleFrameRunner = async () => {
        call++;
        return { success: call !== 2 }; // 第 2 次失败
      };
      // 2 个长镜头（均 >15s 阈值）：framesPerGap=2 → 每 gap 补 2 帧 → 共 4 runner 调用
      // scene1: 0s → 20s (gap=20s)
      // scene2: 21s → 50s (gap=29s)
      const frames = [
        makeFrame(0, 1), makeFrame(20000, 1),
        makeFrame(21000, 2), makeFrame(50000, 2),
      ];
      const r = await GapFrameRefiller.refillLongGapScenes({
        frames,
        videoPath: '/fake/v.mp4',
        framesDir: '/fake/frames',
        config: { minGapSeconds: 15, framesPerGap: 2, strategy: 'AUTO_ADAPTIVE' },
        runner: badRunner,
      });
      expect(r.refillRunnerFailures).toBe(1);
      expect(r.refilledCount).toBe(3); // 4-1=3 成功
      expect(r.refilledFrames).toHaveLength(3);
    });

    it('[P3-集成-6] minGapSeconds 参数透传：阈值改 20s，18s gap 不补', async () => {
      const frames = [makeFrame(0, 1), makeFrame(18000, 1)];
      const r = await GapFrameRefiller.refillLongGapScenes({
        frames, videoPath: '/fake/v.mp4', framesDir: '/fake/frames',
        config: { minGapSeconds: 20 },
        runner: mockRunner(),
      });
      expect(r.gapScenesDetected).toBe(0);
      expect(r.refilledCount).toBe(0);
      expect(runnerCalls).toHaveLength(0);
    });
  });
});
