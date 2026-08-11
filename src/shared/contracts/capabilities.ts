// ──────────────────────────────────────────────
// P0 · 抽帧策略契约收拢
// - 对外暴露 2 枚举：AUTO_ADAPTIVE（智能自适应，默认）| UNIFORM_FPS（等间隔调试）
// - 历史 4 枚举（VLM_OPTIMIZED / FAST_KEYFRAME / PRECISE_SINGLE）通过兼容映射
//   统一归一化到 AUTO_ADAPTIVE，保证存量 job / 旧 API 反序列化不崩。
// - PRECISE_SINGLE（定点截图）不再作为管线策略，拆为独立的 screenshotAt API。
// ──────────────────────────────────────────────

/** P0 对外抽帧策略（2 值） */
export type FrameExtractStrategy = 'AUTO_ADAPTIVE' | 'UNIFORM_FPS';

/** P0 抽帧密度预设档位：精简 / 标准 / 高密，绑定帧数预算与最小间隔 */
export type DensityPreset = 'sparse' | 'standard' | 'dense';

/** 抽帧密度预设 → 内部参数映射（唯一真源 SSOT）
 *  framesPerMinute：BudgetClipper 总帧数封顶依据（12/20/35 帧/分钟）
 *  minFrameInterval：AUTO_ADAPTIVE 内部的 FFmpeg 最小兜底间隔
 *  sceneThreshold：AUTO_ADAPTIVE 内部的转场灵敏度（高密档需更灵敏）
 */
export const DENSITY_PRESET_CONFIG: Record<DensityPreset, {
  framesPerMinute: number;
  minFrameInterval: number;
  sceneThreshold: number;
  label: string;
  description: string;
}> = {
  sparse: {
    framesPerMinute: 12,
    minFrameInterval: 5.0,
    sceneThreshold: 0.30,
    label: '精简模式',
    description: '约 12 帧/分钟，适合访谈/演讲，极省 Token',
  },
  standard: {
    framesPerMinute: 20,
    minFrameInterval: 3.0,
    sceneThreshold: 0.28,
    label: '标准模式',
    description: '约 20 帧/分钟，适合影视剧/Vlog，平衡精度与成本（默认）',
  },
  dense: {
    framesPerMinute: 35,
    minFrameInterval: 1.7,
    sceneThreshold: 0.25,
    label: '高密模式',
    description: '约 35 帧/分钟，适合动作片/动漫快剪，不漏关键动作',
  },
} as const;

/** 历史旧枚举 → 新 2 枚举兼容映射
 *  VLM_OPTIMIZED / FAST_KEYFRAME / PRECISE_SINGLE 均归一化到 AUTO_ADAPTIVE，
 *  PRECISE_SINGLE 在进入抽帧主流程前应由 screenshotAt 独立 API 拦截消费。
 */
export const LEGACY_FRAME_STRATEGY_COMPAT_MAP: Record<string, FrameExtractStrategy> = {
  // 新枚举（恒等）
  AUTO_ADAPTIVE: 'AUTO_ADAPTIVE',
  UNIFORM_FPS: 'UNIFORM_FPS',
  // 历史别名：小写 + 下划线
  auto_adaptive: 'AUTO_ADAPTIVE',
  uniform_fps: 'UNIFORM_FPS',
  // 历史 4 枚举：VLM_OPTIMIZED 系列
  VLM_OPTIMIZED: 'AUTO_ADAPTIVE',
  vlm_optimized: 'AUTO_ADAPTIVE',
  scene: 'AUTO_ADAPTIVE',
  SCENE: 'AUTO_ADAPTIVE',
  // 历史 4 枚举：FAST_KEYFRAME 系列
  FAST_KEYFRAME: 'AUTO_ADAPTIVE',
  fast_keyframe: 'AUTO_ADAPTIVE',
  iframe: 'AUTO_ADAPTIVE',
  IFRAME: 'AUTO_ADAPTIVE',
  keyframe: 'AUTO_ADAPTIVE',
  // 历史 4 枚举：PRECISE_SINGLE 系列（抽帧主流程归一化前应被拦截）
  PRECISE_SINGLE: 'AUTO_ADAPTIVE',
  precise_single: 'AUTO_ADAPTIVE',
  // 历史 4 枚举：UNIFORM_FPS 系列
  UNIFORM: 'UNIFORM_FPS',
  uniform: 'UNIFORM_FPS',
} as const;

/**
 * 归一化抽帧策略字符串：兼容历史所有别名与大小写
 * @param raw 任意输入字符串（可能是历史 job 的旧枚举 / 小写）
 * @param fallback 无法识别时的兜底策略（默认 AUTO_ADAPTIVE）
 * @returns 标准 2 值枚举 FrameExtractStrategy
 */
export function normalizeFrameStrategy(
  raw: string | null | undefined,
  fallback: FrameExtractStrategy = 'AUTO_ADAPTIVE',
): FrameExtractStrategy {
  if (!raw) return fallback;
  const mapped = LEGACY_FRAME_STRATEGY_COMPAT_MAP[String(raw).trim()];
  return mapped ?? fallback;
}

export interface IFrameExtractor {
  extractFrames(params: ExtractFramesParams): Promise<ExtractFramesResult>;
  getProgress(): number;
  abort(): void;
}

export interface ExtractFramesParams {
  mediaPath: string;
  outputDir: string;
  /** 抽帧策略，默认 AUTO_ADAPTIVE（P0 新契约；历史值自动归一化） */
  strategy?: FrameExtractStrategy;
  /** P0 抽帧密度预设，默认 standard（AUTO_ADAPTIVE 模式下生效，绑定帧数预算/最小间隔/转场阈值） */
  densityPreset?: DensityPreset;
  /** 均匀抽帧帧率，默认 2（仅 UNIFORM_FPS 模式生效；AUTO_ADAPTIVE 下由 densityPreset 派生） */
  fps?: number;
  /** 场景变化阈值 (0,1]，默认由 densityPreset 派生（P0 UI 隐藏，调试仍可手动覆盖） */
  sceneThreshold?: number;
  /** 缩放宽度，VLM 推荐 1024，默认 1024（前端 store 用 scale，VideoProcessor 解构为 scale，传给 FFmpegBuilder 映射为 width） */
  scale?: number;
  /** JPEG 画质 1-5，默认 3 */
  quality?: number;
  /** VLM 模式最小帧间隔（秒），默认由 densityPreset 派生（P0 UI 隐藏，调试仍可手动覆盖） */
  minFrameInterval?: number;
  /** ⚠️ 历史兼容保留：精准截图时间点（秒）。P0 起不应进入抽帧主流程，统一走 screenshotAt 独立 API。 */
  timePoint?: number;
  /** 入点时间（秒），对应 VideoProcessor.inPoint */
  inPoint?: number;
  /** 出点时间（秒），对应 VideoProcessor.outPoint */
  outPoint?: number;
}

export interface ExtractFramesResult {
  /** 帧文件绝对路径数组（VideoProcessor 返回 files，ExtractionPipeline 返回 frames） */
  framePaths: string[];
  /** 实际抽帧帧率 */
  fps: number;
  /** 总帧数 */
  totalFrames: number;
  /** 处理耗时（毫秒） */
  durationMs: number;
  /** 追加式后处理产出的精选帧元数据（含 timeMs/清晰度等，未启用后处理时为空） */
  frameDetails?: FrameDetail[];
}

/** 单帧质检与元数据（追加式后处理产物） */
export interface FrameDetail {
  /** 图片落盘路径 */
  framePath: string;
  /** 该帧在原视频中的毫秒时间戳 */
  timeMs: number;
  /** 格式化时间戳（如 "00:04.25"） */
  timeStr: string;
  /** 清晰度得分（拉普拉斯方差） */
  qualityScore: number;
  /** 所属镜头序号 */
  sceneIndex: number;
}

export interface ITTSProvider {
  generateTTS(params: TTSParams): Promise<TTSResult>;
  getVoices(): Promise<TTSVoice[]>;
  abort(): void;
}

export interface TTSParams {
  text: string;
  voiceId?: string;
  speed?: number;
  pitch?: number;
  outputPath?: string;
}

export interface TTSResult {
  audioPath: string;
  duration: number;
  format: string;
}

export interface TTSVoice {
  id: string;
  name: string;
  language: string;
  description?: string;
}

export interface IASREngine {
  transcribe(params: ASRParams): Promise<ASRResult>;
  abort(): void;
}

export interface ASRParams {
  audioPath: string;
  language?: string;
}

export interface ASRResult {
  segments: ASRSegment[];
  fullText: string;
  language: string;
}

export interface ASRSegment {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface IVisionAnalyzer {
  analyze(framePath: string): Promise<VisionResult>;
  analyzeBatch(framePaths: string[]): Promise<VisionResult[]>;
}

export interface VisionResult {
  framePath: string;
  labels: string[];
  objects: { label: string; confidence: number; bbox?: number[] }[];
  description: string;
}
