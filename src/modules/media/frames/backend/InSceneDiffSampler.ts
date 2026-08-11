// 📁 路径：src/modules/media/frames/backend/InSceneDiffSampler.ts
// P1 · 镜内差分采样器：在 P0 BudgetClipper 预算封顶之前，对 scene select 初筛帧做：
//   1. aHash 汉明差分计算（scoreFramesDiff，缓存 precomputedHashes 复用 SmartFramePostProcessor 已有结果，零新增 sharp）
//   2. 物理镜头边界 sceneIndex 差分分裂（splitSceneBoundary，hamming>40 → 新 sceneIndex，修复 P0 递增序号语义失真）
//   3. 滑动窗口 N=3 动作峰值帧识别（detectActionPeaks，含 UNIFORM_FPS gate + lumaJumpThreshold 光效帧剔除）
//   4. 动作峰值 priorityFlags 构造（buildPriorityFlags，合并 upstream 不覆盖 hardCut/asrAnchor）
import type { FrameAssetDetail } from '../types';
import type { BudgetClipPriorityFlag } from './BudgetClipper';
// 复用 SmartFramePostProcessor 的 computeHash / hammingDistance（纯静态方法，零 new 实例成本）
import { SmartFramePostProcessor } from './SmartFramePostProcessor';

/** 帧对差分函数抽象（默认 aHash 汉明距离；未来 SSIM / MSE 扩展点）
 * @param hashA 前序帧的 aHash 字符串
 * @param hashB 后序帧的 aHash 字符串
 * @param pairIndex 后序帧在原始 frames 数组中的下标（等于 "第 N 个相邻对"：1..frames.length-1）
 * @returns 差分分数：aHash 默认 0-64（越大越不相似）
 */
export type DiffFn = (hashA: string, hashB: string, pairIndex?: number) => number;

/** 差分打分后帧（内部类型，不外泄到对外契约）：携带 diffToPrev / sceneBoundaryFlag / actionPeakFlag
 *  — 除 sceneIndex 将在 splitSceneBoundary 中被覆写外，其余字段只读参考，不污染原 FrameAssetDetail 对象
 */
export interface ScoredFrame extends FrameAssetDetail {
  /** 相对前一帧的差分分数（0 = 完全相同，hash 相同；默认 aHash hamming，最大 64）；首帧 = 0 */
  diffToPrev: number;
  /** 是否是差分分裂出来的新物理镜头边界（splitSceneBoundary 写入） */
  sceneBoundaryFlag?: boolean;
  /** 是否是动作峰值帧（detectActionPeaks 写入，仅调试用，对外 priorityFlags 通过 buildPriorityFlags 输出） */
  actionPeakFlag?: boolean;
}

/** 归一化抽帧策略（detectActionPeaks 用）：UNIFORM_FPS / uniform → 跳过，其它（含 AUTO_ADAPTIVE/历史别名）→ 启用 */
function normalizeStrategyGate(raw: string | undefined | null): 'uniform' | 'adaptive' {
  if (!raw) return 'adaptive';
  const s = String(raw).trim().toLowerCase().replace(/[\s_-]/g, '');
  if (s === 'uniformfps' || s === 'uniform') return 'uniform';
  return 'adaptive';
}

/** P1 · 镜内差分采样静态工具类 */
export class InSceneDiffSampler {

  /**
   * 计算相邻帧的差分距离（默认 aHash 汉明距离），缓存 precomputedHashes 命中则跳过 sharp 计算（P1 R6 优化）
   * 函数级中文注释：
   *  - 输入 frames 时间有序（P0 SmartFramePostProcessor 保证），返回 ScoredFrame 同顺序
   *  - diffFn 未传时用 SmartFramePostProcessor.hammingDistance（从 computeHash 文档可知两 hash 长度等长，该方法可直接复用）
   *  - precomputedHashes：framePath -> hash；命中则不调用 computeHash（避免 P0 去重已算过的 hash 重算，每帧节省 ~5ms sharp）
   *  - 首帧 ScoredFrame.diffToPrev = 0（无前序）
   *  - diffFn 传了第三个参数 pairIndex：对应 frames 的下标（1..frames.length-1），便于单元测试注入固定差分
   */
  static async scoreFramesDiff(
    frames: FrameAssetDetail[],
    diffFn?: DiffFn,
    precomputedHashes?: Map<string, string> | undefined,
  ): Promise<ScoredFrame[]> {
    if (!frames || frames.length === 0) return [];
    const cache = new Map<string, string>(precomputedHashes?.entries() ?? []);
    const hashes: string[] = new Array(frames.length);

    // Step A: 计算每帧 hash（仅当未传自定义 diffFn 时才需要——默认 hammingDistance 依赖 hash；自定义 DiffFn 直接返回差分则跳过 hash，避免测试无磁盘文件时 sharp 崩溃）
    const needComputeHash = !diffFn;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (!needComputeHash) {
        // 自定义 DiffFn：直接占位空串（DiffFn 应忽略 hashA/hashB 内容，读 pairIndex 注入差分）
        hashes[i] = '';
        continue;
      }
      const cached = cache.get(f.framePath);
      if (cached) {
        hashes[i] = cached;
      } else {
        const h = await SmartFramePostProcessor.computeHash(f.framePath);
        hashes[i] = h;
        cache.set(f.framePath, h);
      }
    }

    // Step B: 组装 ScoredFrame + 填充 diffToPrev（默认 hammingDistance 或自定义 diffFn）
    const scored: ScoredFrame[] = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      // 浅拷贝（sceneIndex / lumaScore / clarityScore 等保留）
      const sf: ScoredFrame = {
        framePath: f.framePath,
        timeMs: f.timeMs,
        timeStr: f.timeStr,
        clarityScore: f.clarityScore,
        lumaScore: f.lumaScore,
        sceneIndex: f.sceneIndex, // 先保留原值；splitSceneBoundary 中再覆写为差分分裂后序号
        diffToPrev: 0,
      };
      if (i >= 1) {
        const pairIndex = i; // 相邻对的后帧下标 = pairIndex
        if (diffFn) {
          sf.diffToPrev = Math.max(0, Number(diffFn(hashes[i - 1], hashes[i], pairIndex)) || 0);
        } else {
          sf.diffToPrev = SmartFramePostProcessor.hammingDistance(hashes[i - 1], hashes[i]);
        }
      }
      scored[i] = sf;
    }
    return scored;
  }

  /**
   * 按差分阈值分裂物理镜头 sceneIndex（默认 hamming > 40 → >62.5% 像素翻转 = 新镜头）
   * 覆写 P0 递增序号（修复「sceneIndex 语义失真」R2 风险）：
   *  - sceneIndex 从 1 开始重新编号
   *  - i>=1 如果 scored[i].diffToPrev > threshold → 新 scene（currentScene++），并标记 sceneBoundaryFlag=true
   *  - 同一场景内的所有帧共享同一 sceneIndex
   */
  static splitSceneBoundary(scored: ScoredFrame[], threshold = 40): ScoredFrame[] {
    if (!scored || scored.length === 0) return [];
    let currentScene = 1;
    const result: ScoredFrame[] = new Array(scored.length);
    for (let i = 0; i < scored.length; i++) {
      const sf = scored[i];
      let boundaryFlag = false;
      if (i >= 1 && sf.diffToPrev > threshold) {
        currentScene++;
        boundaryFlag = true;
      }
      // 新对象返回（不 mutate 原 scored），sceneIndex 被覆写为差分分裂后 currentScene
      result[i] = {
        ...sf,
        sceneIndex: currentScene,
        sceneBoundaryFlag: boundaryFlag,
      };
    }
    return result;
  }

  /**
   * 滑动窗口 N=3 动作峰值检测：中心帧差分 > 前后均值 × peakRatio = 动作峰值锚点帧
   * 含三道 gate：
   *  1) strategy gate：UNIFORM_FPS → 直接返回空（保持均匀时序覆盖用户心智，D6 Decision）
   *  2) 长度 gate：n < 3 → 不足窗口，直返空
   *  3) 光效帧剔除：中心帧 luma - 前帧 luma 绝对值 > lumaJumpThreshold → 视作闪白/闪黑镜头（溶接转场残影），不进白名单（R1 缓解）
   *
   * @param scored 差分打分后的 ScoredFrame[]（时间有序）
   * @param opts.windowSize 滑动窗口大小（默认 3，奇数）
   * @param opts.peakRatio 中心差分 / 邻居均值比阈值（默认 1.5：超过 50% 跳变 = 峰值）
   * @param opts.lumaJumpThreshold 光效剔除阈值（默认 100：luma 差值超该值视为光效）
   * @param opts.strategy 当前抽帧策略字符串（归一化后判断 UNIFORM_FPS）
   * @returns 动作峰值帧的 framePath 列表（可直接传给 buildPriorityFlags），去重有序
   */
  static detectActionPeaks(
    scored: ScoredFrame[],
    opts?: {
      windowSize?: number;
      peakRatio?: number;
      lumaJumpThreshold?: number;
      strategy?: string;
    },
  ): string[] {
    if (!scored || scored.length < 3) return [];
    // 1) strategy gate：UNIFORM_FPS 不跑动作峰（用户要均匀，不应峰值优先）
    if (normalizeStrategyGate(opts?.strategy) === 'uniform') return [];
    const N = Math.max(3, opts?.windowSize ?? 3);
    const half = Math.floor(N / 2); // N=3 → half=1
    // 中心帧 i 范围：必须保证「前序差分」= scored[i-half].diffToPrev 是真实差分（非首帧的 0），即 i-half ≥ 1 → i ≥ half+1
    // 同时「后序差分」= scored[i+half].diffToPrev 存在 → i+half ≤ scored.length-1 → i ≤ scored.length-1-half
    const minCenterIdx = half + 1; // N=3, half=1 → 2
    const maxCenterIdx = scored.length - 1 - half; // N=3, n=5 → 5-1-1=3
    const peakRatio = Math.max(1.0, opts?.peakRatio ?? 1.5);
    const lumaJumpThreshold = Math.max(0, opts?.lumaJumpThreshold ?? 100);
    const result: string[] = [];
    const seen = new Set<string>();

    for (let i = minCenterIdx; i <= maxCenterIdx; i++) {
      // 窗口 N=3：中心差分 = scored[i].diffToPrev（帧 i-1 到 i）
      //   前序邻居差分 = scored[i-half].diffToPrev（帧 i-2 到 i-1）
      //   后序邻居差分 = scored[i+half].diffToPrev（帧 i 到 i+1）
      const before = scored[i - half].diffToPrev;
      const center = scored[i].diffToPrev;
      const after = scored[i + half].diffToPrev;
      const meanNeighbors = (before + after) / 2;
      if (center <= meanNeighbors * peakRatio) continue;

      // 光效帧剔除：中心帧 luma 相对前帧 luma 跳变绝对值超阈值 → 跳过
      const lumaDelta = Math.abs(scored[i].lumaScore - scored[i - 1].lumaScore);
      if (lumaDelta > lumaJumpThreshold) continue;

      // 动作峰值命中，去重加入结果
      const p = scored[i].framePath;
      if (!seen.has(p)) {
        seen.add(p);
        result.push(p);
      }
    }
    return result;
  }

  /**
   * 合并动作峰值帧 priorityFlags（action_peak 标记）+ 上游传入的 priorityFlags（hardCut / asrAnchor 等）
   * 不变式：
   *  - 不 mutate 传入的 existing（纯函数 immutable 返回新对象）
   *  - 不覆盖 existing 中每个 framePath 原有的 flags 数组（上游声明 hardCut 不应被差分动作峰覆盖；Decision D5）
   *  - action_peak flag 去重追加（若已存在不重复 push）
   *  - 纯 action_peak 帧（上游未声明）：输出仅含 ['action_peak']
   *
   * @param actionPeakPaths detectActionPeaks 返回的动作峰值帧路径列表
   * @param existing 上游传入的 priorityFlags（如 ASR 吸附帧、硬切帧，可 undefined）
   * @returns 合并后的 priorityFlags 对象（供 BudgetClipper.clip 使用）
   */
  static buildPriorityFlags(
    actionPeakPaths: string[],
    existing?: Record<string, BudgetClipPriorityFlag[]> | undefined,
  ): Record<string, BudgetClipPriorityFlag[]> {
    // immutable 克隆：existing 各 framePath 的 flags 数组 slice()（浅拷贝即可，BudgetClipPriorityFlag 是字符串字面量）
    const result: Record<string, BudgetClipPriorityFlag[]> = {};
    if (existing) {
      for (const key of Object.keys(existing)) {
        const arr = existing[key];
        if (Array.isArray(arr)) result[key] = arr.slice();
      }
    }
    // 追加 action_peak
    for (const path of actionPeakPaths) {
      if (!result[path]) {
        result[path] = ['action_peak'];
      } else {
        const list = result[path];
        if (!list.includes('action_peak')) list.push('action_peak');
      }
    }
    return result;
  }
}
