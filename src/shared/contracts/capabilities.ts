/** 四大抽帧策略类型 */
export type FrameExtractStrategy = 'VLM_OPTIMIZED' | 'UNIFORM_FPS' | 'FAST_KEYFRAME' | 'PRECISE_SINGLE';

export interface IFrameExtractor {
  extractFrames(params: ExtractFramesParams): Promise<ExtractFramesResult>;
  getProgress(): number;
  abort(): void;
}

export interface ExtractFramesParams {
  mediaPath: string;
  outputDir: string;
  /** 抽帧策略，默认 VLM_OPTIMIZED（前端 store 用 mode，后端统一映射为 strategy） */
  strategy?: FrameExtractStrategy;
  /** 均匀抽帧帧率，默认 2 */
  fps?: number;
  /** 场景变化阈值 (0,1]，默认 0.28（前端 store 用 sceneThreshold，与后端一致） */
  sceneThreshold?: number;
  /** 缩放宽度，VLM 推荐 1024，默认 1024（前端 store 用 scale，VideoProcessor 解构为 scale，传给 FFmpegBuilder 映射为 width） */
  scale?: number;
  /** JPEG 画质 1-5，默认 3 */
  quality?: number;
  /** VLM 模式最小帧间隔（秒），默认 4 */
  minFrameInterval?: number;
  /** 精准截图时间点（秒），仅 PRECISE_SINGLE */
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
