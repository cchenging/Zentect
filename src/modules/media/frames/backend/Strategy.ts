// 📁 路径：src/modules/media/frames/backend/Strategy.ts
// 四大抽帧策略的FFmpeg滤镜实现，按规格 §3.5.2 定义
//
// 策略说明：
// - VLM_OPTIMIZED：场景动态切片 + 最小间隔兜底补帧（电影解说最优方案）
// - UNIFORM_FPS：传统均匀时间步长抽帧
// - FAST_KEYFRAME：极速全片索引（只读关键I帧）
// - PRECISE_SINGLE：精准单帧时间戳截图

import type { FrameStrategy } from '../types';
import { AppError, ErrorCode } from '../../../../infra/error/AppError';

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

/** select 滤镜：关键帧选择 */
class KeyframeSelectFilter extends VideoFilter {
  toString(): string { return "select='eq(pict_type\\,I)'"; }
}

/** select 滤镜：场景变化检测 */
class SceneSelectFilter extends VideoFilter {
  constructor(private readonly threshold: number) {
    super();
    if (threshold <= 0 || threshold > 1) throw new AppError(ErrorCode.SYS_UNKNOWN, `[FrameStrategy] sceneThreshold 超出合法范围 (0, 1]: ${threshold}`);
  }
  toString(): string { return `select='gt(scene\\,${this.threshold})'`; }
}

/** select 滤镜：VLM 最优化复合选择（场景变化 + 最小间隔兜底） */
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
    return `select='gt(scene\\,${this.threshold})+gte(t-prev_selected_t\\,${this.minInterval})'`;
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
  strategy: FrameStrategy;
  fps: number;
  sceneThreshold: number;
  minFrameInterval: number;
  width: number;
  quality: number;
  inPoint?: number;
  outPoint?: number;
  timePoint?: number;
  threads: number;
}

/** 帧模块专用的精简 FFmpeg 命令构建器 */
class FrameCommandBuilder {
  private readonly args: string[] = [];

  private overwrite(): this { this.args.push('-y'); return this; }
  private seek(seconds: number): this { this.args.push('-ss', seconds.toString()); return this; }
  private to(seconds: number): this { this.args.push('-to', seconds.toString()); return this; }
  private skipFrameNoKey(): this { this.args.push('-skip_frame', 'nokey'); return this; }
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
      width, quality, inPoint, outPoint, timePoint, threads,
    } = config;

    const builder = new FrameCommandBuilder();
    builder.overwrite();

    // 1. 策略路由：输入选项阶段
    switch (strategy) {
      case 'PRECISE_SINGLE': {
        const seekTime = timePoint ?? inPoint ?? 0;
        builder.seek(seekTime);
        builder.input(videoPath);
        builder.vframes(1);
        break;
      }
      case 'FAST_KEYFRAME': {
        builder.skipFrameNoKey();
        if (inPoint !== undefined) builder.seek(inPoint);
        builder.input(videoPath);
        if (outPoint !== undefined) builder.to(outPoint);
        break;
      }
      case 'UNIFORM_FPS': {
        if (inPoint !== undefined) builder.seek(inPoint);
        builder.input(videoPath);
        if (outPoint !== undefined) builder.to(outPoint);
        break;
      }
      case 'VLM_OPTIMIZED':
      default: {
        if (inPoint !== undefined) builder.seek(inPoint);
        builder.input(videoPath);
        if (outPoint !== undefined) builder.to(outPoint);
        break;
      }
    }

    // 2. 构建滤镜链
    const chain = new FilterChain();

    switch (strategy) {
      case 'VLM_OPTIMIZED':
        chain.add(new VlmOptimizedSelectFilter(sceneThreshold, minFrameInterval));
        break;
      case 'FAST_KEYFRAME':
        chain.add(new KeyframeSelectFilter());
        break;
      case 'UNIFORM_FPS':
        chain.add(new FpsFilter(fps));
        break;
      case 'PRECISE_SINGLE':
        break;
    }

    if (width > 0 && strategy !== 'PRECISE_SINGLE') {
      chain.add(new ScaleFilter(width));
    }

    if (chain.length > 0) {
      builder.videoFilter(chain);
    }

    // 3. select 类滤镜需要 vfr 模式
    if (strategy === 'VLM_OPTIMIZED' || strategy === 'FAST_KEYFRAME') {
      builder.vsyncVfr();
    }

    // 4. JPEG 画质非线性映射：quality 1-5 → q:v 6-2
    const QUALITY_MAP: Record<number, number> = { 5: 2, 4: 3, 3: 4, 2: 5, 1: 6 };
    const qv = QUALITY_MAP[quality] ?? 4;
    builder.qualityJpeg(qv);

    // 5. 线程数
    if (strategy !== 'PRECISE_SINGLE') {
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
 * 构建抽帧命令参数
 *
 * 四大策略路由：
 * - VLM_OPTIMIZED：场景动态切片 + 最小间隔兜底补帧（电影解说最优）
 * - UNIFORM_FPS：传统均匀时间步长
 * - FAST_KEYFRAME：极速全片索引（只读关键I帧）
 * - PRECISE_SINGLE：精准单帧时间戳截图
 */
export function buildExtractCommand(config: {
  videoPath: string;
  outputPath: string;
  strategy: FrameStrategy;
  fps: number;
  sceneThreshold: number;
  minFrameInterval: number;
  width: number;
  quality: number;
  inPoint?: number;
  outPoint?: number;
  timePoint?: number;
  threads: number;
}): string[] {
  return FrameCommandBuilder.buildExtractCommand(config);
}
