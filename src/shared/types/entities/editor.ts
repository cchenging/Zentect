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
  start: string; text: string; originalText?: string; end?: string; editing: boolean;
}

/** VLM 帧描述 */
export interface VlmFrame {
  url: string; description: string; editing: boolean; confirmed: boolean;
}

/** 解说文案段落 */
export interface ScriptParagraph {
  id: string; shotId?: string; text: string; duration?: number; emotion?: string; editing: boolean;
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