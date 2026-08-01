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

/** 角色的人脸元数据（单张脸） */
export interface FaceFeature {
  /** 人脸图片路径（项目内相对路径或绝对路径，由调用方决定） */
  facePath?: string;
  /** 性别（male/female） */
  gender?: string;
  /** 年龄估计 */
  age?: number;
  /** 人脸框坐标 */
  bbox?: number[];
  /** 所属帧索引（用于帧级角色锚定） */
  frameIndex?: number;
  /** 所属帧路径 */
  frame?: string;
}

/** 角色 */
export interface Role {
  id: string;
  name: string;
  /** @deprecated 已被 avatar 取代 */
  avatarPath?: string;
  /** @deprecated 已被 mergedRoles 取代 */
  mergedFrom?: string[];
  /** @deprecated 已被 faces 计数取代 */
  appearances?: number;
  /** @deprecated embedding 已下沉到 faces/representative */
  featureVector?: number[];

  /** 聚类 ID（媒体内唯一，如 role_0），非全局人物标识 */
  systemId?: string;
  /** 角色头像路径 */
  avatar?: string;
  /** 代词（他/她/它） */
  pronoun?: string;
  /** 角色描述 */
  description?: string;
  /** TTS 音色 ID */
  voiceId?: string;
  /** 所属媒体 ID */
  mediaId?: string;
  /** 已合并到本角色的子角色列表 */
  mergedRoles?: Role[];
  /** 代表性人脸（聚类中心） */
  representative?: FaceFeature;
  /** 该角色的所有人脸 */
  faces?: FaceFeature[];
  /** 人脸数量（= faces.length） */
  faceCount?: number;
  /** 🎭 P1 全局人物注册中心：绑定的全局人物 ID */
  globalCharacterId?: string;
}

/**
 * 🎭 P1 全局人物注册中心：跨集/跨项目人物复用
 * 每个全局人物对应一个真实人物（如"张三"），可被多个项目的本地角色引用
 */
export interface GlobalCharacter {
  /** 全局人物 ID（gc_ 前缀） */
  id: string;
  /** 全局人物名 */
  name: string;
  /** 全局代表头像绝对路径 */
  avatar?: string;
  /** 512 维 ArcFace 归一化向量（JSON 字符串，DB 存储；运行时为 number[]） */
  embeddingCenter: string | number[];
  /** embedding 模型版本（如 arcface_v1），模型升级时用于失效重建 */
  embeddingVersion: string;
  /** 全局默认 TTS 音色 ID */
  voiceId?: string;
  /** 代词 */
  pronoun?: string;
  /** 描述 */
  description?: string;
  /** 累计被识别绑定的次数 */
  appearanceCount: number;
  /** 出现过的项目 ID 列表（JSON 数组字符串，DB 存储；运行时为 string[]） */
  sourceProjectIds: string | string[];
  /** 创建时间 */
  createTime?: string;
  /** 更新时间 */
  updateTime?: string;
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