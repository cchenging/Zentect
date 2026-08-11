// 📁 路径：src/modules/media/frames/types.ts
// 接口契约：关键帧抽取模块的输入/输出/策略定义
// P0 · 契约收拢：与 src/shared/contracts/capabilities.ts 共享 2 值枚举 + DensityPreset

import type {
  FrameExtractStrategy as SharedFrameStrategy,
  DensityPreset as SharedDensityPreset,
} from '../../../shared/contracts/capabilities';
import {
  normalizeFrameStrategy,
  DENSITY_PRESET_CONFIG,
} from '../../../shared/contracts/capabilities';

/** P0 抽帧策略枚举（2 值；历史 4 值通过 normalizeFrameStrategy 归一化） */
export type FrameStrategy = SharedFrameStrategy;
export type DensityPreset = SharedDensityPreset;

/** 抽帧策略兼容常量（包含历史别名与新枚举；内部值自动归一化为 2 值）
 *  注意：FAST_KEYFRAME / VLM_OPTIMIZED / PRECISE_SINGLE 均会在 buildExtractCommand 前
 *  通过 normalizeFrameStrategy 归一化到 AUTO_ADAPTIVE，不保证保留原始语义。
 */
export const FRAME_STRATEGIES = {
  /** P0 新默认：智能自适应（scene + densityPreset 绑定 minInterval + BudgetClipper 封顶） */
  AUTO_ADAPTIVE: 'AUTO_ADAPTIVE' as const,
  /** 调试兜底：等间隔均匀抽帧（fps 由用户显式指定） */
  UNIFORM_FPS: 'UNIFORM_FPS' as const,
  // ── 历史兼容别名（类型层保留，运行时归一化到 AUTO_ADAPTIVE）──
  /** ⚠️ 历史兼容：等价 AUTO_ADAPTIVE，不再区分 I 帧 GOP 结构 */
  VLM_OPTIMIZED: 'AUTO_ADAPTIVE' as const,
  /** ⚠️ 历史兼容：等价 AUTO_ADAPTIVE，不再区分 I 帧 GOP 结构 */
  FAST_KEYFRAME: 'AUTO_ADAPTIVE' as const,
  /** ⚠️ 历史兼容：等价 AUTO_ADAPTIVE；定点截图请使用独立 screenshotAt API */
  PRECISE_SINGLE: 'AUTO_ADAPTIVE' as const,
} as const;

/** 密度预设配置唯一真源（直接复用 shared 契约，保持 SSOT） */
export { DENSITY_PRESET_CONFIG, normalizeFrameStrategy };

/** 抽帧输入参数 */
export interface FrameExtractInput {
  /** 输入视频文件物理绝对路径 */
  videoPath: string;
  /** 抽帧策略模式（P0 2 值；历史旧字符串自动归一化） */
  mode: FrameStrategy | string;
  /** P0 抽帧密度预设（仅 AUTO_ADAPTIVE 模式生效，绑定帧数预算/最小间隔/转场阈值，默认 standard） */
  densityPreset?: DensityPreset;
  /** 场景变化阈值 0.0~1.0；AUTO_ADAPTIVE 下默认由 densityPreset 派生（可手动覆盖调试） */
  sceneThreshold?: number;
  /** 最小帧间隔（秒）；AUTO_ADAPTIVE 下默认由 densityPreset 派生（可手动覆盖调试） */
  minFrameInterval?: number;
  /** 均匀抽帧帧率，默认 2（仅 UNIFORM_FPS 模式生效） */
  fps?: number;
  /** 缩放宽度（像素），VLM推荐1024，默认 1024 */
  scale?: number;
  /** JPEG 画质 1-5（1=最高，5=最低压缩），默认 3 */
  quality?: number;
  /** ⚠️ 历史兼容保留：定点秒数；P0 起抽帧主流程不应消费；请走 screenshotAt 独立 API */
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

/** 单帧质检与元数据（追加式后处理产物，说明见 SmartFramePostProcessor.ts） */
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
  /** 所属镜头序号 */
  sceneIndex: number;
  /** 时间戳是否为估算值（非均匀且无 PTS 时可能不精确） */
  estimatedTime?: boolean;
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
  /** 追加式后处理产出的精选帧元数据（未启用后处理时为空数组） */
  frameDetails?: FrameAssetDetail[];
}
