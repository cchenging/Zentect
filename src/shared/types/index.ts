import { DICT } from '../../modules/infra/i18n/dictionary';

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
  // 🔧 修复 TS2339：动态访问的可选字段
  sourceType?: string;
  mediaId?: string;
  startMs?: number;
  endMs?: number;
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
  // 🔧 修复 TS2339：策略类动态访问的运行时字段（可选，由 BaseNodeStrategy 合并 params 后填充）
  mediaPath?: string;
  audioPath?: string;
  vocalPath?: string;
  scriptShots?: any[];
  /** ASR 原声时间轴（SemanticAnalyzeStrategy 原声段落定位用）：[{ text, startMs, endMs }] */
  asrLines?: any[];
  /** 步骤2 逐帧 VLM 描述（SemanticAnalyzeStrategy 帧描述聚合用）：[{ timeMs, description, emotion?, shotType?, downstream? }] */
  frameDescriptions?: any[];
  ttsDurations?: number[];
  bgmInfo?: any;
  /** 🎬 方向3（跨项目切片污染纵深防御）：本项目已保存的切片池（metadata.videoChunks 透传），
   *  步骤5 优先复用本项目自己的切片，避免依赖 daemon 跨项目缓存（PROJECT_MATERIAL_POOL）。 */
  videoChunks?: any[];
  /** 该节点执行完成后的输出结果，供下游节点作为上游上下文合并 */
  result?: any;
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
  /** L2 引擎层全局归一化进度（0~100 整数，单调递增）；前端状态条优先读它 */
  globalProgress?: number;
  percent?: number;
  /** 步骤1子步骤身份：frames/audio/whisper/faces。存在时表示本条进度属于该子步骤 */
  subStep?: string;
  /** 步骤1子步骤局部进度（0~100），由子引擎真实完成量动态计算，与全局 percent 解耦 */
  subStepProgress?: number;
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
export interface Shot {
  id: string;
  mediaId: string;
  imagePath: string;
  text: string;
  originalText?: string;
  visionText?: string;
  /**
   * 坐标系契约（模式 A）：start / end 一律为【源坐标】（源时间轴绝对位置，秒）。
   * OP/ED 裁剪后 body 坐标（正剧段内 0 起）仅管线内部瞬时存在，落库/导出前必须经
   * toSource 还原；读取消费方如需 body 坐标自行 toBody。禁止混存两种坐标系。
   */
  start: number;
  end: number;
  duration: number;
  linkedRoleId?: string;
  audioPath?: string;
  ttsText?: string;
  aiText?: string;
  audioDuration?: number;
  audioEmotion?: string;
  contextFrames?: string[];
  roleId?: string;
  originalRoleId?: string;
  matchedStart?: number;
  coverPath?: string;
  reasoning?: string;
  characters?: any[];
  camera?: string;
  alignStrategy?: string;
  type?: string;
  filePath?: string;
  pipelineStatus?: string;
  scriptPayload?: any;
}
export interface Role { id: string; systemId?: string; name: string; avatar?: string; mergedRoles?: Role[]; pronoun?: string; description?: string; voiceId?: string; mediaId?: string; }

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