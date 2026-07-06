// 📁 路径：src/modules/media/frames/types.ts
// 接口契约：关键帧抽取模块的输入/输出/策略定义

/** 抽帧策略枚举 */
export type FrameStrategy = 'VLM_OPTIMIZED' | 'UNIFORM_FPS' | 'FAST_KEYFRAME' | 'PRECISE_SINGLE';

/** 四种抽帧策略常量 */
export const FRAME_STRATEGIES = {
  /** VLM最优化：场景动态切换+最小间隔兜底补帧（电影解说最优） */
  VLM_OPTIMIZED: 'VLM_OPTIMIZED' as const,
  /** 均匀抽帧：按固定帧率均匀抽取 */
  UNIFORM_FPS: 'UNIFORM_FPS' as const,
  /** 极速关键帧：只读I帧，速度极快 */
  FAST_KEYFRAME: 'FAST_KEYFRAME' as const,
  /** 精准单帧：指定时间点截取 */
  PRECISE_SINGLE: 'PRECISE_SINGLE' as const,
} as const;

/** 抽帧输入参数 */
export interface FrameExtractInput {
  /** 输入视频文件物理绝对路径 */
  videoPath: string;
  /** 抽帧策略模式 */
  mode: FrameStrategy;
  /** 场景变化阈值 0.0~1.0，越小越敏感，默认 0.28 */
  sceneThreshold?: number;
  /** VLM模式最小帧间隔（秒），默认 4 */
  minFrameInterval?: number;
  /** 均匀抽帧帧率，默认 2 */
  fps?: number;
  /** 缩放宽度（像素），VLM推荐1024，默认 1024 */
  scale?: number;
  /** JPEG 画质 1-5（1=最高，5=最低压缩），默认 3 */
  quality?: number;
  /** 精准截图时间点（秒），仅 PRECISE_SINGLE 策略 */
  timePoint?: number;
  /** 起始时间点（秒） */
  inPoint?: number;
  /** 结束时间点（秒） */
  outPoint?: number;
}

/** 抽帧输出 */
export interface FrameExtractOutput {
  /** 抽取的帧文件绝对路径列表 */
  framePaths: string[];
  /** 抽帧数量 */
  frameCount: number;
}

/** 抽帧遥测结果（含性能指标） */
export interface FrameExtractionTelemetry {
  files: string[];
  metrics: {
    durationMs: number;
    frameCount: number;
    totalSizeMB: number;
    processingFps: number;
  };
}
