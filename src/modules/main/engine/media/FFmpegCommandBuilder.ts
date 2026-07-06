// 📁 路径: src/main/engine/media/FFmpegCommandBuilder.ts
/**
 * FFmpeg 命令结构化构建器
 *
 * METHODOLOGY OBLIGATION: FFmpeg Command Builder Spec
 * 1. INPUT ALWAYS FIRST: -ss (if preset) must be placed BEFORE -i for fast seeking.
 * 2. SEPARATION: Hardware acceleration, filter chains, and quality flags must be explicitly split.
 * 3. NO HARDCODING: All output names must use standardized sequential naming (e.g., frame_%04d.jpg).
 * 4. TYPE SAFETY: All parameters are strongly typed with range validation.
 * 5. NO STRING CONCAT: Filter chains are built programmatically, never by template literal.
 *
 * ⚠️ 抽帧功能已迁移至 src/modules/media/frames/
 *   - FrameStrategy 类型 → 从 frames 模块重新导出
 *   - buildExtractCommand → 从 frames 模块重新导出
 *   - 策略滤镜类 → 从 frames 模块重新导出
 * 此处保留封面生成（buildCoverCommand）和元数据探测（buildProbeCommand）。
 */

// ──────────────────────────────────────────────
// 1. 配置接口 — 强类型约束
// ──────────────────────────────────────────────

/** @deprecated 抽帧策略枚举已迁移至 src/modules/media/frames/，请使用 FrameStrategy from '@/modules/media/frames' */
export type { FrameStrategy } from '../../../modules/media/frames';

/** 抽帧命令配置 */
export interface ExtractConfig {
  /** 输入视频文件路径（必须为物理绝对路径） */
  videoPath: string;
  /** 输出路径（目录或带 %04d 的文件模式） */
  outputPath: string;
  /** 抽帧策略，默认 VLM_OPTIMIZED */
  strategy?: FrameStrategy;
  /** 均匀抽帧帧率，例如 0.5 表示每两秒一帧，默认 1 */
  fps?: number;
  /** 场景变化阈值，0.0~1.0，越小越敏感，默认 0.28 */
  sceneThreshold?: number;
  /** VLM 模式最小帧间隔（秒），默认 4 — 防止文戏场景丢失 */
  minFrameInterval?: number;
  /** 缩放宽度（像素），VLM 推荐1024，默认 1024 */
  width?: number;
  /** JPEG 画质 1-5（1=最高画质低压缩，5=最低画质高压缩），默认 3 */
  quality?: number;
  /** 起始时间点（秒），放在 -i 前实现快速 seek */
  inPoint?: number;
  /** 结束时间点（秒） */
  outPoint?: number;
  /** 精准截图时间点（秒），仅 PRECISE_SINGLE 策略使用 */
  timePoint?: number;
  /** 线程数，默认 2 */
  threads?: number;
}

/** 封面生成配置 */
export interface CoverConfig {
  /** 输入视频文件路径 */
  videoPath: string;
  /** 输出封面图片完整路径 */
  outputPath: string;
  /** 截取时间点（秒），默认 0.1 */
  seekTime?: number;
  /** 缩放高度（像素），默认 360 */
  scaleHeight?: number;
  /** JPEG 画质 1-31，默认 2 */
  jpgQuality?: number;
}

/** 元数据探测配置 */
export interface ProbeConfig {
  /** 输入视频文件路径 */
  videoPath: string;
}

// ──────────────────────────────────────────────
// 2. 滤镜链构建器 — 每个滤镜独立类，杜绝字符串拼接
// ⚠️ 抽帧专用滤镜（FpsFilter/KeyframeSelectFilter/SceneSelectFilter/VlmOptimizedSelectFilter）已迁移至 src/modules/media/frames/backend/Strategy.ts
// ──────────────────────────────────────────────

/** 滤镜基类：所有滤镜必须继承并实现 toString() */
abstract class VideoFilter {
  /** 将滤镜序列化为 FFmpeg 滤镜表达式 */
  abstract toString(): string;
}

/** fps 滤镜：均匀抽帧 */
class FpsFilter extends VideoFilter {
  constructor(private readonly fps: number) {
    super();
    if (fps <= 0 || fps > 120) throw new Error(`[FFmpegBuilder] fps 超出合法范围 (0, 120]: ${fps}`);
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
    if (threshold <= 0 || threshold > 1) throw new Error(`[FFmpegBuilder] sceneThreshold 超出合法范围 (0, 1]: ${threshold}`);
  }
  toString(): string { return `select='gt(scene\\,${this.threshold})'`; }
}

/** select 滤镜：VLM 最优化复合选择（场景变化 + 最小间隔兜底） */
class VlmOptimizedSelectFilter extends VideoFilter {
  private readonly threshold: number;
  private readonly minInterval: number;

  constructor(threshold: number, minInterval: number) {
    super();
    if (threshold <= 0 || threshold > 1) throw new Error(`[FFmpegBuilder] sceneThreshold 超出合法范围 (0, 1]: ${threshold}`);
    if (minInterval <= 0) throw new Error(`[FFmpegBuilder] minFrameInterval 必须 > 0: ${minInterval}`);
    this.threshold = threshold;
    this.minInterval = minInterval;
  }

  /**
   * 复合 select 表达式：
   * gt(scene, threshold) — 检测场景剧变（导演切镜头、画面转场）
   * gte(t-prev_selected_t, minInterval) — 最小间隔兜底（防止文戏场景丢失）
   * 两者取 OR（+），确保即使无转场也能定期补帧
   */
  toString(): string {
    return `select='gt(scene\\,${this.threshold})+gte(t-prev_selected_t\\,${this.minInterval})'`;
  }
}

/** scale 滤镜：缩放 */
class ScaleFilter extends VideoFilter {
  constructor(private readonly width: number) {
    super();
    if (width < 0) throw new Error(`[FFmpegBuilder] scale width 不能为负数: ${width}`);
  }
  toString(): string {
    /** width=0 表示不缩放，width>0 按宽度等比缩放 */
    const w = this.width > 0 ? this.width : -1;
    return `scale=${w}:-1`;
  }
}

/** scale 滤镜：按高度缩放（封面专用） */
class ScaleByHeightFilter extends VideoFilter {
  constructor(private readonly height: number) {
    super();
    if (height <= 0) throw new Error(`[FFmpegBuilder] scaleHeight 必须 > 0: ${height}`);
  }
  toString(): string { return `scale=-1:${this.height}`; }
}

/** 滤镜链：管理多个滤镜的有序组合 */
class FilterChain {
  private readonly filters: VideoFilter[] = [];

  /** 添加一个滤镜到链尾 */
  add(filter: VideoFilter): this {
    this.filters.push(filter);
    return this;
  }

  /** 链中滤镜数量 */
  get length(): number { return this.filters.length; }

  /** 序列化为 FFmpeg -vf 参数值，滤镜之间用逗号连接 */
  toString(): string {
    if (this.filters.length === 0) throw new Error('[FFmpegBuilder] 滤镜链为空，无法序列化');
    return this.filters.map(f => f.toString()).join(',');
  }
}

// ──────────────────────────────────────────────
// 3. 命令构建器 — 核心入口
// ──────────────────────────────────────────────

/**
 * FFmpeg 命令构建器
 *
 * 强制按规范顺序生成参数：
 *   [全局选项] [输入选项] -i [输入] [滤镜] [输出选项] [输出]
 */
export class FFmpegCommandBuilder {
  private readonly args: string[] = [];

  private constructor() {}

  /** 创建新的构建器实例 */
  static create(): FFmpegCommandBuilder {
    return new FFmpegCommandBuilder();
  }

  /** 添加覆盖输出标志 */
  overwrite(): this {
    this.args.push('-y');
    return this;
  }

  /** 快速 seek：放在 -i 前实现快速定位（不逐帧解码） */
  seek(seconds: number): this {
    if (seconds < 0) throw new Error(`[FFmpegBuilder] seek 时间不能为负: ${seconds}`);
    this.args.push('-ss', seconds.toString());
    return this;
  }

  /** 结束时间点 */
  to(seconds: number): this {
    if (seconds < 0) throw new Error(`[FFmpegBuilder] to 时间不能为负: ${seconds}`);
    this.args.push('-to', seconds.toString());
    return this;
  }

  /** 跳帧解码：仅解码关键帧，大幅提升抽帧速度 */
  skipFrameNoKey(): this {
    this.args.push('-skip_frame', 'nokey');
    return this;
  }

  /** 载入输入源 */
  input(filePath: string): this {
    if (!filePath) throw new Error('[FFmpegBuilder] 输入路径不能为空');
    this.args.push('-i', filePath);
    return this;
  }

  /** 应用视频滤镜链 */
  videoFilter(chain: FilterChain): this {
    if (chain.length === 0) return this;
    this.args.push('-vf', chain.toString());
    return this;
  }

  /** 可变帧率模式（配合 select 滤镜使用） */
  vsyncVfr(): this {
    this.args.push('-vsync', 'vfr');
    return this;
  }

  /** 仅输出指定帧数 */
  framesV(count: number): this {
    if (count <= 0) throw new Error(`[FFmpegBuilder] frames:v 不能 <= 0: ${count}`);
    this.args.push('-frames:v', count.toString());
    return this;
  }

  /** 仅输出指定帧数（-vframes 别名） */
  vframes(count: number): this {
    if (count <= 0) throw new Error(`[FFmpegBuilder] vframes 不能 <= 0: ${count}`);
    this.args.push('-vframes', count.toString());
    return this;
  }

  /** JPEG 画质（1=最高，31=最低） */
  qualityJpeg(level: number): this {
    const clamped = Math.max(1, Math.min(31, Math.round(level)));
    this.args.push('-q:v', clamped.toString());
    return this;
  }

  /** 线程数 */
  threads(count: number): this {
    if (count < 1) throw new Error(`[FFmpegBuilder] threads 不能 < 1: ${count}`);
    this.args.push('-threads', count.toString());
    return this;
  }

  /** 输出路径 */
  output(filePath: string): this {
    if (!filePath) throw new Error('[FFmpegBuilder] 输出路径不能为空');
    this.args.push(filePath);
    return this;
  }

  /** 构建最终参数数组，自动清洗脏数据 */
  build(): string[] {
    return this.args
      .filter(a => a !== undefined && a !== null && a !== '')
      .map(String);
  }
}

// ──────────────────────────────────────────────
// 4. 高级构建函数 — 按业务场景封装
// ⚠️ buildExtractCommand 已迁移至 src/modules/media/frames/backend/Strategy.ts
// ──────────────────────────────────────────────

/**
 * 构建抽帧命令参数
 * @deprecated 已迁移至 src/modules/media/frames/，请使用 buildExtractCommand from '@/modules/media/frames/backend/Strategy'
 */
export { buildExtractCommand } from '../../../modules/media/frames/backend/Strategy';

/**
 * 构建封面生成命令参数
 *
 * 规范：
 * - -ss 放在 -i 前实现快速 seek
 * - 仅截取 1 帧
 */
export function buildCoverCommand(config: CoverConfig): string[] {
  const {
    videoPath, outputPath,
    seekTime = 0.1, scaleHeight = 360, jpgQuality = 2,
  } = config;

  const builder = FFmpegCommandBuilder.create();

  builder.overwrite();
  builder.seek(seekTime);
  builder.input(videoPath);
  builder.framesV(1);

  const chain = new FilterChain();
  chain.add(new ScaleByHeightFilter(scaleHeight));
  builder.videoFilter(chain);

  builder.qualityJpeg(jpgQuality);
  builder.output(outputPath);

  return builder.build();
}

/**
 * 构建 ffprobe 元数据探测命令参数
 */
export function buildProbeCommand(config: ProbeConfig): string[] {
  const { videoPath } = config;
  if (!videoPath) throw new Error('[FFmpegBuilder] 探测路径不能为空');
  return ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath];
}
