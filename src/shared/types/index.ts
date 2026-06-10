import { DICT } from '../locales/dictionary';

/**
 * 1. 基础媒体实体
 */
export interface MediaItem {
  id: string;
  projectId?: string;
  name?: string;
  type?: string;
  filePath?: string;
  path?: string;
  coverPath?: string;
  fileName?: string;
  cover?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  status?: string;
  frames?: string[];
  extractedAudio?: string;
  extractedVocals?: string;
  extractedBgm?: string;
  extractedText?: string;
  thumbnail?: string;
  narrationScript?: string;
  createTime?: string;
  updateTime?: string;
}

/**
 * 2. 动态视频切片素材
 */
export interface VideoChunkMaterial {
  id: string;              // 素材唯一ID
  filePath: string;        // 原始长视频绝对路径
  startMs: number;         // 动态视频切片在原视频中的毫秒起点
  endMs: number;           // 动态视频切片在原视频中的毫秒终点
  durationMs: number;      // 物理视频切片的实际原长
  visionEmbedding: number[]; // 本地Video-CLIP提取的动态语义特征向量
  motionScore: number;     // 视觉运动显著性得分（用于高潮动作截取）
  colorHistogram: number[];// 画面平均色彩直方图（用于转场平滑度计算）
  coverPath?: string;      // 切片封面图路径
}

/**
 * 3. 匹配结果项：从静态帧演进为动态视频切片
 */
export interface MatchResultItem {
  shotId: string;          // 对应剧本的分镜ID
  mediaType: 'video_chunk' | 'frame'; // 动态视频切片或静态帧
  mediaId: string;         // 匹配到的素材ID
  score: number;           // 全局 KM 综合对齐得分
  thumbnail: string;       // 封面图路径
  chunkData: VideoChunkMaterial | null; // 绑定的动态视频切片
  audioDurationMs: number; // 步骤4生成的配音刚性时长（由TTS输出提供）
  videoTimelineStartMs: number; // 该镜头在最终合成时间线上的绝对起点
  videoTimelineEndMs: number;   // 该镜头在最终合成时间线上的绝对终点
  appliedSpeedFactor: number;   // 算法自适应时光流插值慢动作或快进系数（默认1.0）
  confirmed: boolean;      // 用户是否确认
}

/**
 * 4. 任务与管线载荷 (后端执行契约)
 */
export interface PipelineTask {
  nodeId: string;
  actionType: string;
  label: string;
  params: Record<string, any>;
  dependsOn: string[];
  mergedInputs: Record<string, any>;
}

export interface PipelinePayload {
  projectId: string;
  workflowId: string;
  sourceMedia?: string;
  sequence: PipelineTask[];
}

/**
 * 4. IPC 通信事件载荷
 */
export interface TaskProgressPayload {
  nodeId?: string;
  mediaId?: string;
  progress?: number;
  percent?: number;
  status?: 'processing' | 'success' | 'error' | string;
  code?: string;
  message?: string;
  text?: string;
  results?: any;
}

/**
 * 5. 其他原有类型保持兼容
 */
export interface Project { id: string; name: string; createdAt: number; updatedAt: number; cover?: string; }
export interface Shot { id: string; mediaId: string; imagePath: string; text: string; originalText?: string; visionText?: string; start: number; end: number; duration: number; linkedRoleId?: string; audioPath?: string; ttsText?: string; aiText?: string; audioDuration?: number; audioEmotion?: string; contextFrames?: string[]; roleId?: string; originalRoleId?: string; matchedStart?: number; coverPath?: string; reasoning?: string; characters?: any[]; camera?: string; alignStrategy?: string; type?: string; filePath?: string; }
export interface Role { id: string; systemId: string; name: string; avatar: string; mergedRoles?: Role[]; pronoun?: string; description?: string; voiceId?: string; mediaId?: string; }

export type UnifiedTaskStatus = typeof DICT.TASK_STATUS[keyof typeof DICT.TASK_STATUS];

export interface TaskCompletedPayload {
  mediaId: string;
  projectId: string;
  result: any;
}

export interface AppNotifyPayload {
  code: string;
  level: 'success' | 'error' | 'info' | 'warn' | 'warning';
}

export interface PipelineExtractionResult {
  type: string;
  mediaId: string;
  roles: Role[];
  shots: Shot[];
  frames: string[];
  audioPath?: string;
  vocalsPath?: string;
  bgmPath?: string;
  text?: string;
}

export interface AIAction {
  type: 'UPDATE_TEXT' | 'REORDER' | 'DELETE' | 'ADD_SHOT' | 'SEARCH_BROLL';
  targetId?: string;
  newText?: string;
  targetIndex?: number;
  mediaId?: string;
  query?: string;
}

export interface ProcessingAction {
  nodeId: string;
  actionType: string;
  engine: string;
  params: Record<string, any>;
  dependsOn: string[];
}

export interface PipelineContext {
  [nodeId: string]: {
    mediaPath?: string;
    framesDir?: string;
    vocalPath?: string;
    bgmPath?: string;
    textData?: any;
    vectorIndex?: string;
  };
}