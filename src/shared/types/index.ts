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
 * 3. 任务与管线载荷 (后端执行契约)
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