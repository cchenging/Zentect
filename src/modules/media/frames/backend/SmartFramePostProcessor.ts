// 📁 路径：src/modules/media/frames/backend/SmartFramePostProcessor.ts
// 关键帧追加式后处理：在 FFmpeg 抽帧落盘后，用 sharp 做像素级质检与精简
//
// 设计原则（追加式，不破坏 FFmpeg 抽帧核心与 framePaths 契约）：
//   1. 清晰度门禁：拉普拉斯方差打分，剔除运动撕裂/失焦的模糊帧
//   2. 黑屏检测：平均亮度过低（残影/溶接/黑场）的帧直接丢弃 —— 处理转场残影
//   3. 感知去重：aHash（8x8 灰度平均哈希）汉明距离判断，剔除重复静态帧
//   4. 时序元数据：按策略推断 timeMs，供下游步骤5绑定时间轴
//   5. P0 预算封顶（BudgetClipper）：根据 densityPreset × 视频时长，做全片总帧数控
//
// 依赖：sharp（已安装 ^0.34.5），无需 OpenCV 绑定

import sharp from 'sharp';
import { BudgetClipper } from './BudgetClipper';
import { InSceneDiffSampler } from './InSceneDiffSampler';
import { AsrAnchorMatcher, type AsrAnchoringConfig } from './AsrAnchorMatcher';
import {
  GapFrameRefiller,
  type GapRefillConfig,
  type SingleFrameRunner,
} from './GapFrameRefiller';
import type { DensityPreset } from '../types';
import type { BudgetClipPriorityFlag } from './BudgetClipper';
import type { AsrLine } from '../../../../shared/types/entities/editor';
import { normalizeFrameStrategy, type FrameExtractStrategy } from '../../../../shared/contracts/capabilities';

/** 单帧质检与元数据结果 */
export interface FrameAssetDetail {
  /** 图片落盘绝对路径 */
  framePath: string;
  /** 该帧在原视频中的毫秒时间戳 */
  timeMs: number;
  /** 格式化时间戳（如 "00:04.25"） */
  timeStr: string;
  /** 清晰度得分（拉普拉斯方差，越大越清晰） */
  clarityScore: number;
  /** 平均亮度（0-255，黑屏检测依据） */
  lumaScore: number;
  /** 所属物理镜头序号（本实现为保留帧的递增序号） */
  sceneIndex: number;
  /** 时间戳是否为估算值（非均匀抽帧策略下可能不精确） */
  estimatedTime?: boolean;
}

/** P1 · 镜内差分采样配置（追加式，不破坏 P0 既有契约）
 *  — enabled=false / strategy=UNIFORM_FPS → 全流程 gate 跳过（节省差分打分 + sharp hash 重算成本）
 *  — peakRatio 默认 1.5：中心差分 > 前后均值 × 1.5 = 动作峰值
 *  — lumaJumpThreshold 默认 100：luma 跳变超阈值 → 光效帧剔除以缓解转场溶接误报
 */
export interface DiffSamplingConfig {
  /** 是否启用镜内差分采样（默认 true：AUTO_ADAPTIVE 下启用；UNIFORM_FPS 下即使 enabled=true 也 gate 跳过） */
  enabled?: boolean;
  /** 动作峰阈值系数（中心差分 / 前后邻居均值比），默认 1.5，越大越严格（仅显著跳变 = 峰值） */
  peakRatio?: number;
  /** 光效帧剔除阈值（中心帧 luma 与前帧 luma 差绝对值 ≤ lumaJumpThreshold 才进动作峰），默认 100 */
  lumaJumpThreshold?: number;
}

/** 后处理选项 */
export interface SmartFramePostProcessOptions {
  /** 抽帧策略，决定 timeMs 推断方式（P0 2 值枚举；历史旧字符串允许兼容传入；内部 normalize） */
  strategy: 'VLM_OPTIMIZED' | 'UNIFORM_FPS' | 'FAST_KEYFRAME' | 'PRECISE_SINGLE'
    | 'AUTO_ADAPTIVE' | string | FrameExtractStrategy;
  /** 均匀抽帧帧率（UNIFORM_FPS 用） */
  fps?: number;
  /** 精准截图时间点（秒，PRECISE_SINGLE 用） */
  timePoint?: number;
  /** 清晰度下限，低于此值视为模糊帧丢弃，默认 100 */
  minClarity?: number;
  /** 平均亮度下限（0-255），低于此值视为黑屏丢弃，默认 16 */
  minLuma?: number;
  /** aHash 汉明距离上限，<= 此值视为重复静态帧，默认 5 */
  dedupThreshold?: number;
  /** 可选：每帧精确 PTS（毫秒，与 files 顺序对齐）。
   *  由 FFmpeg showinfo 捕获；提供时优先使用，否则按策略推断 */
  ptsMs?: number[];

  /**
   * 🎬 源坐标偏移（毫秒）：OP/ED 裁剪后 FFmpeg -ss 前置 seek 使输出 PTS 归零（body 坐标）。
   * 传入 offsetSec×1000 后，所有帧 timeMs 统一换算为源坐标（原视频绝对时间），
   * 与 ASR / chunks 等已落库的源坐标数据基准一致（MediaTrimPolicy 模式 A）。
   * 未传或 0 = 不裁剪，行为与旧版一致。
   */
  sourceOffsetMs?: number;

  // ── P0 · BudgetClipper 预算封顶参数 ──────────────────────────────
  /** 抽帧密度预设；与 videoDurationMinutes 同时提供时启用预算封顶 */
  densityPreset?: DensityPreset;
  /** 视频总时长（分钟）；与 densityPreset 一起提供，计算 maxFrames */
  videoDurationMinutes?: number;
  /** 显式指定总帧数上限（比 densityPreset 优先级高）；UNIFORM_FPS 模式可直接传 */
  maxFrames?: number;
  /** 超预算容忍度，默认 0.1（10%）；≤ maxFrames × (1 + tolerance) 时不裁剪 */
  toleranceRatio?: number;
  /** P0 优先权标志：key = framePath（files 顺序），value = 保留标志；首末帧自动入白名单无需声明
   *  P1 追加：合并动作峰值帧 action_peak 标志（immutable 不覆盖 upstream 声明的 hardCut/asrAnchor）
   */
  priorityFlags?: Record<string, BudgetClipPriorityFlag[]>;
  /** 关闭 BudgetClipper 日志 */
  silentBudgetClipper?: boolean;

  // ── P1 · 镜内差分采样参数 ────────────────────────────────────────
  /** P1 镜内差分采样配置（默认：enabled=true）；可在调用侧传 enabled=false 临时关闭做 A/B 基线回归 */
  diffSampling?: DiffSamplingConfig;

  // ── P2 · 声画锚定参数 ──────────────────────────────────────────
  /** P2 声画锚定配置（默认：enabled=true）；可在调用侧传 enabled=false 临时关闭做 A/B 基线回归；
   *  strategy=UNIFORM_FPS 即使 enabled=true 也 gate 跳过（均匀时序优先）
   */
  asrSampling?: AsrAnchoringConfig;
  /** P2 上游已有的 ASR 台词结果（Step1 ASR 产生的 asrLines）；不传或空数组 → 声画锚定零吸附（不 crash） */
  asrLines?: AsrLine[];

  // ── P3 · V2 真补帧参数（长镜头空段，二次 FFmpeg 单帧 seek 补帧） ─────────────
  /** P3 V2 真补帧配置（默认：enabled=true；UNIFORM_FPS gate=空；每长空段最多 3 帧 25%/50%/75%） */
  refillConfig?: GapRefillConfig;
  /** P3 必需：原视频绝对路径（缺省时 P3 流程全 skip，不 crash） */
  videoPath?: string;
  /** P3 必需：帧落盘目录（=Service safeOutputDir）；缺省时 P3 skip，不 crash */
  framesDir?: string;
  /** P3 生产环境注入（Service 层传 spawn(ffmpeg) 包装；测试 mock 即可）；缺省时 P3 skip */
  runSingleFrameExtract?: SingleFrameRunner;
}

/** 后处理结果 */
export interface SmartFramePostProcessResult {
  /** 保留下来的精选帧（含元数据） */
  kept: FrameAssetDetail[];
  /** 被丢弃的帧及其原因 */
  dropped: { framePath: string; reason: string; clarityScore: number; lumaScore: number }[];
}

/**
 * 追加式关键帧后处理器
 * 纯静态工具，可在 Node 测试环境直接调用（sharp 依赖完成拉普拉斯/哈希计算）
 */
export class SmartFramePostProcessor {
  /** 3x3 拉普拉斯卷积核：检测边缘锐度，用于衡量画面清晰度 */
  private static readonly LAPLACIAN_KERNEL = {
    width: 3,
    height: 3,
    kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
    scale: 1,
    offset: 0,
  };

  /**
   * 计算单帧清晰度得分（拉普拉斯方差）
   * 灰度图过 3x3 拉普拉斯核 → 统计输出标准差 → 方差
   * @param filePath 图片绝对路径
   * @returns 清晰度得分（越大越清晰，模糊/运动撕裂画面得分低）
   */
  static async assessClarity(filePath: string): Promise<number> {
    // 转灰度 + 缩小到 512 宽，加速卷积与统计而不失真
    const convolved = await sharp(filePath)
      .greyscale()
      .resize({ width: 512 })
      .convolve(this.LAPLACIAN_KERNEL)
      .toBuffer();
    const stats = await sharp(convolved).stats();
    const stddev = stats.channels[0].stdev ?? 0;
    return Math.round(stddev * stddev);
  }

  /**
   * 计算单帧平均亮度（0-255），用于黑屏/残影检测
   * @param filePath 图片绝对路径
   * @returns 平均亮度
   */
  static async assessLuma(filePath: string): Promise<number> {
    const pixel = await sharp(filePath).greyscale().resize({ width: 64 }).stats();
    return Math.round(pixel.channels[0].mean ?? 0);
  }

  /**
   * 计算单帧 aHash（8x8 灰度平均哈希，64 位）
   * 用于静态画面去重：相似画面哈希接近，汉明距离小
   * @param filePath 图片绝对路径
   * @returns 64 位 '0'/'1' 哈希字符串
   */
  static async computeHash(filePath: string): Promise<string> {
    // 8x8 灰度原始像素
    const { data } = await sharp(filePath)
      .greyscale()
      .resize(8, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = [...data];
    const mean = pixels.reduce((s, v) => s + v, 0) / pixels.length;
    // 每像素 >= 均值记为 1，否则 0
    return pixels.map((v) => (v >= mean ? '1' : '0')).join('');
  }

  /**
   * 计算两个 aHash 的汉明距离（逐位不同数）
   * @param a 哈希 A
   * @param b 哈希 B
   * @returns 汉明距离
   */
  static hammingDistance(a: string, b: string): number {
    if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) distance++;
    }
    return distance;
  }

  /**
   * 格式化毫秒时间戳为 "mm:ss.SSS" 形式
   * @param timeMs 毫秒
   * @returns 格式化字符串（如 "00:04.250"）
   */
  static formatTimeMs(timeMs: number): string {
    const totalSec = Math.max(0, timeMs) / 1000;
    const minutes = Math.floor(totalSec / 60);
    const seconds = Math.floor(totalSec % 60);
    const millis = Math.floor((totalSec % 1) * 1000);
    const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
    return `${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
  }

  /**
   * 主流程：对一批已落盘的帧做质检 + 精简 + 元数据封装
   * 会删除被丢弃的帧文件（保持磁盘与返回结果一致）
   * @param files FFmpeg 产出的帧路径列表（按时间顺序）
   * @param options 后处理选项
   * @returns 保留帧与被丢弃帧
   */
  static async process(
    files: string[],
    options: SmartFramePostProcessOptions,
  ): Promise<SmartFramePostProcessResult> {
    const {
      strategy,
      fps = 2,
      timePoint,
      minClarity = 100,
      minLuma = 16,
      dedupThreshold = 5,
      ptsMs,
    } = options;

    // kept 声明为 let：P0 BudgetClipper 可能会裁剪并替换整个数组（末尾重新赋值）
    let kept: FrameAssetDetail[] = [];
    const dropped: SmartFramePostProcessResult['dropped'] = [];
    let lastHash = '';
    let sceneIndex = 0;
    // P1 · aHash 缓存：③ 中 computeHash 一次计算，⑥ InSceneDiffSampler.scoreFramesDiff 零 computeHash 复用
    const aHashCache = new Map<string, string>();

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      let clarityScore = 0;
      let lumaScore = 255;
      try {
        // 并行计算清晰度与亮度（两者独立）
        [clarityScore, lumaScore] = await Promise.all([
          this.assessClarity(filePath),
          this.assessLuma(filePath),
        ]);
      } catch (e: any) {
        // 单个文件读取失败不阻断整体，按最低分处理（交由门禁丢弃）
        clarityScore = 0;
        lumaScore = 0;
      }

      // ① 黑屏/残影门禁：亮度过低（黑场/叠化残影）
      if (lumaScore < minLuma) {
        dropped.push({ framePath: filePath, reason: `黑屏/残影 (luma=${lumaScore})`, clarityScore, lumaScore });
        this.tryUnlink(filePath);
        continue;
      }

      // ② 清晰度门禁：模糊帧（运动撕裂/失焦）
      if (clarityScore < minClarity) {
        dropped.push({ framePath: filePath, reason: `模糊帧 (clarity=${clarityScore})`, clarityScore, lumaScore });
        this.tryUnlink(filePath);
        continue;
      }

      // ③ 感知去重：与上一保留帧高度相似的静态画面折叠
      const currentHash = await this.computeHash(filePath).catch(() => '');
      if (currentHash) {
        // P1 · 缓存写入：只要 hash 非空就写缓存（无论该帧是否因重复被丢弃，后续 P1 差分采样可能仍需 hash，但该帧若已删 → 实际只需要 kept 帧的 hash）
        // 为节省内存：仅在「非重复帧（将进入 kept）」时写入缓存（重复帧被删，不需要参与后续差分）
        const isDup = !!lastHash && this.hammingDistance(lastHash, currentHash) <= dedupThreshold;
        if (!isDup) {
          aHashCache.set(filePath, currentHash);
          lastHash = currentHash;
        } else {
          dropped.push({ framePath: filePath, reason: `重复静态帧 (hamming<=${dedupThreshold})`, clarityScore, lumaScore });
          this.tryUnlink(filePath);
          continue;
        }
      } else if (lastHash) {
        // hash 读取失败但 lastHash 存在：为保留该帧（不把 hash 失败当去重依据），跳过去重判断；lastHash 保持不变
      }

      // ④ 时序元数据（优先用 showinfo 捕获的精确 PTS，否则按策略推断）
      const exactMs = ptsMs && ptsMs[i] !== undefined ? ptsMs[i] : undefined;
      const sourceOffsetMs = options.sourceOffsetMs ?? 0;
      const base = exactMs !== undefined
        ? { timeMs: exactMs, estimatedTime: false }
        : this.inferTimeMs(strategy, i, fps, timePoint);
      // 🎬 body 坐标 → 源坐标（叠加 OP 裁剪偏移）。相对量（帧间差/占比）不受影响，
      //   AsrAnchorMatcher（源坐标 ASR）与 GapFrameRefiller（源视频 seek）因此同步修正。
      const timeMs = base.timeMs + sourceOffsetMs;
      sceneIndex += 1;
      kept.push({
        framePath: filePath,
        timeMs,
        timeStr: this.formatTimeMs(timeMs),
        clarityScore,
        lumaScore,
        sceneIndex,
        estimatedTime: base.estimatedTime,
      });
    }

    // ⑥ P1 · 镜内差分采样（新插入的追加式后处理）：
    //   Gate 条件：strategy 归一化为 UNIFORM_FPS → 跳过（用户意图是均匀时序覆盖，不跑动作峰）
    //              kept.length < 3 → 不足窗口 N=3 → 跳过
    //              diffSampling?.enabled === false → 调用侧显式关闭（A/B 基线回归用）
    //   执行逻辑（aHash 缓存命中，零新增 sharp 计算）：
    //     ⑥-1 InSceneDiffSampler.scoreFramesDiff → ScoredFrame[]
    //     ⑥-2 splitSceneBoundary → 差分分裂 sceneIndex（覆写 P0 递增序号，修复 R2）
    //     ⑥-3 detectActionPeaks → 动作峰值帧路径列表
    //     ⑥-4 buildPriorityFlags → 合并 upstream options.priorityFlags（immutable，不覆盖）
    //   mergedPriorityFlags 供后续 ⑤ BudgetClipper 传参使用
    const normalizedStrategy = normalizeFrameStrategy(strategy) as FrameExtractStrategy;
    const diffEnabled = options.diffSampling?.enabled !== false; // 默认 true
    const shouldRunDiff = diffEnabled
      && normalizedStrategy === 'AUTO_ADAPTIVE'
      && kept.length >= 3;
    let mergedPriorityFlags = options.priorityFlags;
    if (shouldRunDiff) {
      try {
        const scored = await InSceneDiffSampler.scoreFramesDiff(kept, undefined, aHashCache);
        const splitScored = InSceneDiffSampler.splitSceneBoundary(scored);
        // ⑥-2 覆写 kept[i].sceneIndex（P0 递增序号 → 差分分裂后 sceneIndex；修复「语义失真」R2 风险）
        for (let idx = 0; idx < kept.length; idx++) {
          kept[idx].sceneIndex = splitScored[idx].sceneIndex;
        }
        const peakRatio = options.diffSampling?.peakRatio ?? 1.5;
        const lumaJumpThreshold = options.diffSampling?.lumaJumpThreshold ?? 100;
        const actionPeakPaths = InSceneDiffSampler.detectActionPeaks(splitScored, {
          strategy: normalizedStrategy, // AUTO_ADAPTIVE，不会被 gate
          peakRatio,
          lumaJumpThreshold,
        });
        mergedPriorityFlags = InSceneDiffSampler.buildPriorityFlags(actionPeakPaths, options.priorityFlags);
      } catch (err) {
        // ⑥ P1 为"尽力而为"追加优化：失败时不 crash 主流程，退回 baseline（P0 行为）；避免单帧异常导致整条抽帧任务挂
        if (!options.silentBudgetClipper) {
          console.warn('[SFPP·P1] 镜内差分采样异常，fallback 到 baseline：', err instanceof Error ? err.message : String(err));
        }
        mergedPriorityFlags = options.priorityFlags;
      }
    }

    // ⑦ P2 · 声画锚定（新插入的追加式后处理，纯函数无磁盘 I/O、无 FFmpeg 调用）
    //   Gate 条件：strategy 归一化为 UNIFORM_FPS → 跳过（均匀时序优先，不做 ASR 吸附）
    //              asrSampling?.enabled === false → 显式关闭（A/B 基线回归用）
    //              asrLines 空/不传 → 跳过（不 crash）
    //              kept.length < 1 → 无帧可吸附 → 跳过
    //   执行逻辑（无 sharp/无 IO，全内存）：
    //     ⑦-1 AsrAnchorMatcher.matchFramesToAsr → anchoredFramePaths
    //     ⑦-2 buildPriorityFlags → 合并 ⑥ P1 产出的 mergedPriorityFlags（immutable，绝不覆盖 hardCut/action_peak）
    //   失败回退：try/catch fallback，返回 baseline mergedPriorityFlags，不 crash
    const asrEnabled = options.asrSampling?.enabled !== false; // 默认 true
    const asrLinesArr = Array.isArray(options.asrLines) ? options.asrLines : [];
    const shouldRunAsr = asrEnabled
      && normalizedStrategy === 'AUTO_ADAPTIVE'
      && kept.length >= 1
      && asrLinesArr.length > 0;
    if (shouldRunAsr) {
      try {
        const matchResult = AsrAnchorMatcher.matchFramesToAsr(kept, asrLinesArr, {
          strategy: normalizedStrategy,
          ...(options.asrSampling ?? {}),
        });
        // ⑦-2 immutable 合并：把 asrAnchor 追加到 mergedPriorityFlags
        mergedPriorityFlags = AsrAnchorMatcher.buildPriorityFlags(
          matchResult.anchoredFramePaths,
          mergedPriorityFlags,
        );
      } catch (err) {
        if (!options.silentBudgetClipper) {
          console.warn('[SFPP·P2] 声画锚定异常，fallback 到 baseline：', err instanceof Error ? err.message : String(err));
        }
        // 失败回退：mergedPriorityFlags 保持 step 6 产出（或 options.priorityFlags），绝不丢失 upstream 的 hardCut/action_peak
      }
    }

    // ⑧ P3 · V2 真补帧（新插入的追加式后处理，长空段单帧 seek 补代表帧）
    //   Gate 条件：
    //     - refillConfig?.enabled !== false（默认 true；调用侧显式关 = A/B baseline）
    //     - strategy 归一化为 AUTO_ADAPTIVE（UNIFORM_FPS gate=空，均匀时序优先）
    //     - kept.length >= 2（至少 2 帧才能计算长空段）
    //     - videoPath / framesDir 均提供（否则无法跑 FFmpeg seek）
    //     - runSingleFrameExtract runner 已注入（Service 层提供 spawn 包装；测试 mock）
    //   执行（P3 尽力而为：整段 try/catch，失败不 crash 主流程）：
    //     ⑧-1 GapFrameRefiller.refillLongGapScenes → 得到 refilledFrames + 落盘 jpg
    //     ⑧-2 kept.push(...refilledFrames)（追加到候选池；不删原帧，不破坏原 kept 顺序稳定性）
    //     ⑧-3 buildPriorityFlags：gap_refill flag immutable 合并不覆盖 ⑥/⑦/P0 声明
    //   随后进入 ⑤ BudgetClipper（硬顶预算裁剪；gap_refill 属白名单 flag 保留优先级）
    const refillEnabled = options.refillConfig?.enabled !== false; // 默认 true
    if (typeof (process as any)?.env?.DEBUG_P3 !== 'undefined' && !options.silentBudgetClipper) {
      console.debug('[DEBUG-P3] shouldRunRefill factors:', {
        refillEnabled,
        normalizedStrategy,
        keptLength: kept.length,
        hasVideoPath: !!options.videoPath,
        hasFramesDir: !!options.framesDir,
        runnerType: typeof options.runSingleFrameExtract,
      });
    }
    const shouldRunRefill = refillEnabled
      && normalizedStrategy === 'AUTO_ADAPTIVE'
      && kept.length >= 2
      && !!options.videoPath
      && !!options.framesDir
      && typeof options.runSingleFrameExtract === 'function';
    if (shouldRunRefill) {
      try {
        const refillResult = await GapFrameRefiller.refillLongGapScenes({
          frames: kept,
          videoPath: options.videoPath,
          // 上方 shouldRunRefill 守卫已保证 framesDir 非空（!!options.framesDir）
          framesDir: options.framesDir!,
          config: {
            strategy: normalizedStrategy,
            ...(options.refillConfig ?? {}),
          },
          runner: options.runSingleFrameExtract,
        });
        if (refillResult.refilledFrames.length > 0) {
          // ⑧-2 追加（kept 在之前为去重/质检/P1/P2 后的 stable 数组；push 不破坏原有帧顺序）
          kept.push(...refillResult.refilledFrames);
          // ⑧-3 immutable 合并 gap_refill flag（不覆盖 hardCut/action_peak/asrAnchor）
          mergedPriorityFlags = GapFrameRefiller.buildPriorityFlags(
            refillResult.refilledFrames.map(f => f.framePath),
            mergedPriorityFlags,
          );
          if (!options.silentBudgetClipper && (refillResult.refillRunnerFailures > 0 || refillResult.skippedByStrategy || refillResult.skippedNoVideoPath)) {
            console.warn('[SFPP·P3] V2 补帧部分完成：', {
              gapScenesDetected: refillResult.gapScenesDetected,
              refilled: refillResult.refilledCount,
              failures: refillResult.refillRunnerFailures,
              skippedByStrategy: refillResult.skippedByStrategy,
              skippedNoVideoPath: refillResult.skippedNoVideoPath,
            });
          }
        }
      } catch (err) {
        if (!options.silentBudgetClipper) {
          console.warn('[SFPP·P3] V2 补帧异常，fallback 到 baseline：', err instanceof Error ? err.message : String(err));
        }
        // 失败回退：kept 与 mergedPriorityFlags 保持 P2 产出，不 crash、不丢失任何声明
      }
    }

    // ⑤ P0 · BudgetClipper：预算封顶（densityPreset + 时长 或 maxFrames 任一提供时启用）
    const shouldClip = (!!options.densityPreset && typeof options.videoDurationMinutes === 'number')
      || typeof options.maxFrames === 'number';
    if (shouldClip && kept.length > 0) {
      const clipResult = BudgetClipper.clip(kept, {
        densityPreset: options.densityPreset,
        videoDurationMinutes: options.videoDurationMinutes,
        maxFrames: options.maxFrames,
        toleranceRatio: options.toleranceRatio,
        // P0 原 priorityFlags → P1 合并 action_peak 后的 mergedPriorityFlags（上游 hardCut/asrAnchor 不丢）
        priorityFlags: mergedPriorityFlags,
        silent: options.silentBudgetClipper,
        // 删除归口：所有 discarded 帧（黑屏/模糊/重复/预算裁剪）统一由 SmartFramePostProcessor tryUnlink，
        // 避免两个模块各删一份、日志重复；BudgetClipper 仅负责判定 dropped 列表。
        deleteDroppedFiles: false,
      });
      // 合并 BudgetClipper 丢弃项到 dropped（统一形状：含 clarity/luma 占位）
      for (const d of clipResult.dropped) {
        const percentDesc = d.timePercent != null ? `@${Math.round(d.timePercent * 100)}%时间` : '';
        dropped.push({
          framePath: d.framePath,
          reason: `预算裁剪 (${d.reason})${percentDesc}`,
          clarityScore: 0,
          lumaScore: 0,
        });
        // 被预算裁剪的帧也要从磁盘删除（保持磁盘与返回结果一致，不变式：returned kept ↔ 落盘）
        this.tryUnlink(d.framePath);
      }
      // 用裁剪后的 kept 替换
      kept = clipResult.kept;
    }

    return { kept, dropped };
  }

  /**
   * 按策略推断帧时间戳
   * - UNIFORM_FPS：index / fps，精确
   * - PRECISE_SINGLE：timePoint，精确
   * - VLM_OPTIMIZED / FAST_KEYFRAME / AUTO_ADAPTIVE：非均匀，无法精确 → 标记 estimatedTime
   */
  private static inferTimeMs(
    strategy: 'VLM_OPTIMIZED' | 'UNIFORM_FPS' | 'FAST_KEYFRAME' | 'PRECISE_SINGLE'
      | 'AUTO_ADAPTIVE' | string,
    index: number,
    fps: number,
    timePoint?: number,
  ): { timeMs: number; estimatedTime: boolean } {
    switch (String(strategy).toUpperCase()) {
      case 'UNIFORM_FPS':
      case 'UNIFORM':
        return { timeMs: Math.round((index / Math.max(1e-6, fps ?? 2)) * 1000), estimatedTime: false };
      case 'PRECISE_SINGLE':
      case 'PRECISE':
        return { timeMs: Math.round((timePoint ?? 0) * 1000), estimatedTime: false };
      case 'VLM_OPTIMIZED':
      case 'FAST_KEYFRAME':
      case 'AUTO_ADAPTIVE':
      case 'SCENE':
      case 'IFRAME':
      case 'KEYFRAME':
      default:
        // 非均匀抽帧无精确 PTS，返回占位并明确标记为估算，避免误导下游
        return { timeMs: -1, estimatedTime: true };
    }
  }

  /** 安全删除文件（失败不抛错） */
  private static tryUnlink(filePath: string): void {
    try {
      const fs = require('fs') as typeof import('fs');
      fs.unlinkSync(filePath);
    } catch {
      /* 忽略删除失败 */
    }
  }
}