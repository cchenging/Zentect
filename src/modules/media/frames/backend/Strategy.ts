// 📁 路径：src/modules/media/frames/backend/Strategy.ts
// P0 重构 · 抽帧 FFmpeg 滤镜路由：仅保留 2 条主分支（AUTO_ADAPTIVE / UNIFORM_FPS）
// 历史 4 策略（VLM_OPTIMIZED / FAST_KEYFRAME / PRECISE_SINGLE / UNIFORM）在 Service 层已归一化，
// 此处额外做一层 defensive normalize，避免调用方绕过 Service 时抛 TypeScript 类型错误。
//
// 路由说明（内部归一化后）：
// - PRECISE_SINGLE 别名 → 定点单帧截图 vframes=1（独立 screenshotAt API 使用）
// - UNIFORM_FPS → 传统 fps 均匀步长抽帧
// - AUTO_ADAPTIVE（默认，含 VLM_OPTIMIZED / FAST_KEYFRAME 历史别名） → scene select + minInterval 兜底

import { AppError, ErrorCode } from '@modules/infra/error/AppError';

/** Strategy 内部使用的归一化分支枚举；PRECISE_SINGLE 用于 screenshotAt 独立 API */
type InternalStrategy = 'AUTO_ADAPTIVE' | 'UNIFORM_FPS' | 'PRECISE_SINGLE';

/**
 * 内部归一化：将任意输入字符串（旧 4 枚举 / 新 2 枚举 / 别名 / 空值）
 * 映射为 3 路内部分支（AUTO_ADAPTIVE / UNIFORM_FPS / PRECISE_SINGLE）
 */
function normalizeInternalStrategy(raw: string | null | undefined): InternalStrategy {
  if (!raw) return 'AUTO_ADAPTIVE';
  const r = String(raw).trim().toLowerCase().replace(/[\s-]/g, '_');
  if (r === 'precise_single' || r === 'precise' || r === 'precise_one' || r === 'single_frame') {
    return 'PRECISE_SINGLE';
  }
  if (r === 'uniform_fps' || r === 'uniform') return 'UNIFORM_FPS';
  // 其余：VLM_OPTIMIZED / FAST_KEYFRAME / AUTO_ADAPTIVE / 未知值 → 统一走智能自适应
  return 'AUTO_ADAPTIVE';
}

// ──────────────────────────────────────────────
// 1. 滤镜基类与滤镜链
// ──────────────────────────────────────────────

/** 滤镜基类：所有滤镜必须继承并实现 toString() */
abstract class VideoFilter {
  abstract toString(): string;
}

/** 滤镜链：管理多个滤镜的有序组合 */
class FilterChain {
  private readonly filters: VideoFilter[] = [];

  add(filter: VideoFilter): this {
    this.filters.push(filter);
    return this;
  }

  get length(): number {
    return this.filters.length;
  }

  toString(): string {
    if (this.filters.length === 0) {
      throw new AppError(ErrorCode.SYS_UNKNOWN, '[FrameStrategy] 滤镜链为空，无法序列化');
    }
    return this.filters.map(f => f.toString()).join(',');
  }
}

// ──────────────────────────────────────────────
// 2. 策略滤镜实现
// ──────────────────────────────────────────────

/** fps 滤镜：均匀抽帧 */
class FpsFilter extends VideoFilter {
  constructor(private readonly fps: number) {
    super();
    if (fps <= 0 || fps > 120) throw new AppError(ErrorCode.SYS_UNKNOWN, `[FrameStrategy] fps 超出合法范围 (0, 120]: ${fps}`);
  }
  toString(): string { return `fps=${this.fps}`; }
}

/** P0 已废弃：FAST_KEYFRAME → 统一归并到 AUTO_ADAPTIVE 的 VlmOptimizedSelectFilter
 *  select 滤镜：VLM 最优化复合选择（场景变化 + 最小间隔兜底） */
class VlmOptimizedSelectFilter extends VideoFilter {
  private readonly threshold: number;
  private readonly minInterval: number;

  constructor(threshold: number, minInterval: number) {
    super();
    if (threshold <= 0 || threshold > 1) throw new AppError(ErrorCode.SYS_UNKNOWN, `[FrameStrategy] sceneThreshold 超出合法范围 (0, 1]: ${threshold}`);
    if (minInterval <= 0) throw new AppError(ErrorCode.SYS_UNKNOWN, `[FrameStrategy] minFrameInterval 必须 > 0: ${minInterval}`);
    this.threshold = threshold;
    this.minInterval = minInterval;
  }

  toString(): string {
    // 🎬 电影级智能抽帧（时间物理化）：
    // 1. isnan(prev_selected_t)：首帧强保 —— prev_selected_t 初始为 NaN，旧版 gte(t-NaN,..) 恒 false 导致整段 0 帧
    // 2. gte(t-prev_selected_t, minInterval)：时间兜底 —— 叠化/溶接/长镜头场景差值被摊薄，按最大无抽帧间隔兜底补帧
    // 3. gt(scene, threshold)：场景试别 —— 硬切/转场优先捕捉
    // 三者 OR 组合，保证任意镜头节奏都能抽到帧。
    return `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${this.minInterval})+gt(scene\\,${this.threshold})'`;
  }
}

/** scale 滤镜：按宽度等比缩放 */
class ScaleFilter extends VideoFilter {
  constructor(private readonly width: number) {
    super();
    if (width < 0) throw new AppError(ErrorCode.SYS_UNKNOWN, `[FrameStrategy] scale width 不能为负数: ${width}`);
  }
  toString(): string {
    const w = this.width > 0 ? this.width : -1;
    return `scale=${w}:-1`;
  }
}

// ──────────────────────────────────────────────
// 3. FFmpeg 参数构建器（帧模块专用精简版）
// ──────────────────────────────────────────────

interface ExtractConfig {
  videoPath: string;
  outputPath: string;
  /** P0 · 放宽为 string：兼容历史 4 策略别名；实际路由由 normalizeInternalStrategy 归一化 */
  strategy: string;
  fps: number;
  sceneThreshold: number;
  minFrameInterval: number;
  width: number;
  quality: number;
  inPoint?: number;
  outPoint?: number;
  timePoint?: number;
  threads: number;
  /** 是否附加 showinfo 滤镜，向 stderr 输出每帧 pts_time（供精确时序元数据） */
  attachShowinfo?: boolean;
}

/** 帧模块专用的精简 FFmpeg 命令构建器 */
class FrameCommandBuilder {
  private readonly args: string[] = [];

  private overwrite(): this { this.args.push('-y'); return this; }
  private seek(seconds: number): this { this.args.push('-ss', seconds.toString()); return this; }
  private to(seconds: number): this { this.args.push('-to', seconds.toString()); return this; }
  // P0 废弃：skipFrameNoKey（FAST_KEYFRAME 旧 GOP 级跳过，改为 AUTO_ADAPTIVE scene select）
  private input(filePath: string): this { this.args.push('-i', filePath); return this; }
  private videoFilter(chain: FilterChain): this { this.args.push('-vf', chain.toString()); return this; }
  private vsyncVfr(): this { this.args.push('-vsync', 'vfr'); return this; }
  private vframes(count: number): this { this.args.push('-vframes', count.toString()); return this; }
  private qualityJpeg(level: number): this { this.args.push('-q:v', level.toString()); return this; }
  private threads(count: number): this { this.args.push('-threads', count.toString()); return this; }
  private output(filePath: string): this { this.args.push(filePath); return this; }

  build(): string[] {
    return this.args.filter(a => a !== undefined && a !== null && a !== '').map(String);
  }

  static buildExtractCommand(config: ExtractConfig): string[] {
    const {
      videoPath, outputPath, strategy,
      fps, sceneThreshold, minFrameInterval,
      width, quality, inPoint, outPoint, timePoint, threads, attachShowinfo,
    } = config;

    // P0 · 内部归一化：任意策略字符串 → 3 路由分支
    const route = normalizeInternalStrategy(strategy);
    // `normalizeFrameStrategy` 仅用于上层参数派生，这里保留 3 路路由（含 screenshotAt PRECISE_SINGLE）

    const builder = new FrameCommandBuilder();
    builder.overwrite();

    // 1. 策略路由：输入选项阶段（AUTO_ADAPTIVE 统一接管 VLM_OPTIMIZED / FAST_KEYFRAME）
    switch (route) {
      case 'PRECISE_SINGLE': {
        const seekTime = timePoint ?? inPoint ?? 0;
        builder.seek(seekTime);
        builder.input(videoPath);
        builder.vframes(1);
        break;
      }
      case 'UNIFORM_FPS': {
        if (inPoint !== undefined) builder.seek(inPoint);
        builder.input(videoPath);
        if (outPoint !== undefined) builder.to(outPoint);
        break;
      }
      case 'AUTO_ADAPTIVE':
      default: {
        if (inPoint !== undefined) builder.seek(inPoint);
        builder.input(videoPath);
        if (outPoint !== undefined) builder.to(outPoint);
        break;
      }
    }

    // 2. 构建滤镜链
    const chain = new FilterChain();

    switch (route) {
      case 'AUTO_ADAPTIVE':
        // P0 · AUTO_ADAPTIVE 沿用 VLM_OPTIMIZED 的 scene select + minInterval 兜底（sceneThreshold 由 densityPreset 派生）
        chain.add(new VlmOptimizedSelectFilter(sceneThreshold, minFrameInterval));
        break;
      case 'UNIFORM_FPS':
        chain.add(new FpsFilter(fps));
        break;
      case 'PRECISE_SINGLE':
      default:
        break;
    }

    if (width > 0 && route !== 'PRECISE_SINGLE') {
      chain.add(new ScaleFilter(width));
    }

    // 附加 showinfo：向 stderr 输出每帧 pts_time，供精确时序元数据捕获
    if (attachShowinfo && route !== 'PRECISE_SINGLE') {
      chain.add(new (class extends VideoFilter {
        toString(): string { return 'showinfo'; }
      })());
    }

    if (chain.length > 0) {
      builder.videoFilter(chain);
    }

    // 3. AUTO_ADAPTIVE 用 select 滤镜 → 需要 vsync vfr
    if (route === 'AUTO_ADAPTIVE') {
      builder.vsyncVfr();
    }

    // 4. JPEG 画质非线性映射：quality 1-5 → q:v 6-2
    const QUALITY_MAP: Record<number, number> = { 5: 2, 4: 3, 3: 4, 2: 5, 1: 6 };
    const qv = QUALITY_MAP[quality] ?? 4;
    builder.qualityJpeg(qv);

    // 5. 线程数（单帧截图通常不需要多线程，避免额外开销）
    if (route !== 'PRECISE_SINGLE') {
      builder.threads(threads);
    }

    // 6. 输出
    builder.output(outputPath);

    return builder.build();
  }
}

// ──────────────────────────────────────────────
// 4. 对外导出：buildExtractCommand
// ──────────────────────────────────────────────

/**
 * 构建抽帧命令参数（P0 · 对外公开 API）
 *
 * 归一化后的策略路由（内部 normalizeInternalStrategy 自动兼容历史别名）：
 * - PRECISE_SINGLE 别名 → 定点单帧截图 vframes=1（独立 screenshotAt API 使用）
 * - UNIFORM_FPS → 传统 fps 均匀步长抽帧
 * - AUTO_ADAPTIVE（默认，含 VLM_OPTIMIZED / FAST_KEYFRAME 历史别名） → scene select + minInterval 兜底
 */
export function buildExtractCommand(config: {
  videoPath: string;
  outputPath: string;
  /** P0 · 放宽为 string：支持历史 4 策略别名；内部 normalizeInternalStrategy 归一化为 3 路路由 */
  strategy: string;
  fps: number;
  sceneThreshold: number;
  minFrameInterval: number;
  width: number;
  quality: number;
  inPoint?: number;
  outPoint?: number;
  timePoint?: number;
  threads: number;
  attachShowinfo?: boolean;
}): string[] {
  return FrameCommandBuilder.buildExtractCommand(config);
}
