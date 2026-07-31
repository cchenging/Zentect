/**
 * Zentect 实体类型定义
 * 替换 storeTypes.ts 中所有 any[] 的使用
 */

/** 步骤状态 */
export type StepStatus = 'idle' | 'running' | 'completed' | 'failed';
/** 水线状态 */
export type HydrationStatus = 'IDLE' | 'LOADING' | 'READY' | 'ERROR';

/** ASR 台词行 */
export interface AsrLine {
  /** @deprecated 请使用 startMs */
  start: string;
  /** 起始时间（毫秒），唯一真实源 */
  startMs: number;
  text: string;
  originalText?: string;
  /** @deprecated 请使用 endMs */
  end?: string;
  /** 结束时间（毫秒），唯一真实源 */
  endMs: number;
  editing: boolean;
}

/** VLM 帧描述 */
export interface VlmFrame {
  url: string; description: string; editing: boolean; confirmed: boolean;
  /** P0-3：下游瘦身上下文，供 step3 消费 */
  downstream?: {
    action: string;
    emotion: string;
    keywords: string[];
  };
}

/** 解说文案段落 */
export interface ScriptParagraph {
  id: string; shotId?: string; text: string; duration?: number; emotion?: string; editing: boolean;
  audioSafeText?: string; cleanText?: string;
}

/** 管线 R/S/T/P 参数 */
export interface PipelineParams { R: number; S: number; T: number; P: number; }

/** TTS 合成结果 */
export interface TtsResult { shotId: string; audioUrl?: string; _failed?: boolean; _error?: string; }

/** 镜头匹配结果 */
export interface MatchResult {
  shotId: string; mediaId: string; thumbnail?: string; score: number;
  confirmed: boolean; appliedSpeedFactor?: number; audioDurationMs?: number; chunkData?: Record<string, unknown>;
}

/** 媒体项 */
export interface MediaItem {
  id: string; type: 'video'|'audio'|'frame'|'video_chunk'; filePath: string;
  fileName?: string; name?: string; coverPath?: string; thumbnail?: string;
  duration?: number; startMs?: number; endMs?: number; motionScore?: number;
  // 🔧 修复 TS2339：useExtractionHandler/useStepRunner 动态访问的可选字段
  sourceType?: 'vocals' | 'bgm' | 'original' | string;
  mediaId?: string;
}

/** 视频片段 */
export interface VideoChunk {
  id: string; filePath?: string; coverPath?: string; thumbnail?: string; name?: string;
  startMs: number; endMs: number; motionScore?: number;
}

/** 背景音乐 */
export interface BgmInfo { id: string; filePath: string; }

/** 角色 */
export interface Role {
  id: string; name: string; avatarPath?: string; featureVector?: number[];
  mergedFrom?: string[]; appearances?: number;
}

/**
 * 抽帧配置
 * 🔧 修复 TS2305：usePipelineStore 需要导入此类型
 */
export interface ExtractionConfig {
  /** 抽帧模式：scene=场景切换 / fixed=固定间隔 / manual=手动 */
  mode: 'scene' | 'fixed' | 'manual';
  /** 抽帧参数（mode=fixed 时为间隔秒数，scene 时为阈值） */
  value: number;
  /** 是否使用 GPU 加速 */
  useGpu?: boolean;
}