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
  /** 该帧在视频中的绝对时间（毫秒），来自 VisionExtractStrategy FrameDetail，供步骤5 按时间轴聚合到切片 */
  timeMs?: number;
  /** 该帧绝对时间的可读格式，如 "00:12.15" */
  timeStr?: string;
  /** 🎭 P0 意境维度：该帧的情绪标签（如：紧张/平静/温馨），来自 FrameDetail.emotion（VLM 结构化输出 emotionalState），供步骤5 做"文案↔画面"情绪匹配 */
  emotion?: string;
  /** 🎬 该帧的镜头景别（如：特写/中景/全景），来自 FrameDetail.downstream.shotType，供步骤5 意境/衔接匹配 */
  shotType?: string;
  /** P0-3：下游瘦身上下文，供 step3 消费 */
  downstream?: {
    action: string;
    emotion: string;
    keywords: string[];
    /** 🎬 镜头景别（特写/中景/全景等），VLM 结构化输出 */
    shotType?: string;
  };
  /**
   * 🎭 P0.5 帧级锚定：该帧已检测到的人物名称列表
   * 来源：VisionExtractStrategy 的 effectiveFrameRoles[i]
   * 供下游 step3/step4 消费，未启用帧级锚定时为 undefined
   */
  characters?: string[];
}

/** 解说文案段落 */
export interface ScriptParagraph {
  id: string; shotId?: string; text: string; duration?: number; emotion?: string; editing: boolean;
  audioSafeText?: string; cleanText?: string;
  /** 原声段落标记：true 表示该段不合成配音，直接使用原片原声（关键台词保留/原声为主策略时由文案生成标记） */
  keepOriginalAudio?: boolean;
}

/**
 * 解说文案生成参数（融合方案：枚举按钮组 + 连续值协同）
 * 替代旧版 R/S/T/P 滑块，改为专业解说维度的枚举参数
 */
export interface PipelineParams {
  /** 叙事视角：third=第三人称上帝视角 / first=第一人称沉浸 / second=第二人称吐槽互动 */
  narrativePerspective: 'third' | 'first' | 'second';
  /** 信息层次：plot=剧情复述 / deep=深度解读 / roast=吐槽点评 */
  informationLevel: 'plot' | 'deep' | 'roast';
  /** 解说密度：full=满配(95%+填充) / standard=标准(65%填充) / sparse=留白(50%填充) */
  narrationDensity: 'full' | 'standard' | 'sparse';
  /** 原声策略：cover=全量覆盖 / keep_key=关键台词保留 / original_main=原声为主 */
  originalAudioStrategy: 'cover' | 'keep_key' | 'original_main';
  /** 节奏模式：short_fast=短句快切 / mixed=长短交替 / slow_soothing=长句舒缓 */
  rhythmMode: 'short_fast' | 'mixed' | 'slow_soothing';
  /** 情绪基调：neutral=客观中立 / emotional=情感渲染 / suspense=悬疑营造 / epic=高燃热血 / comedy=搞笑吐槽 */
  emotionTone: 'neutral' | 'emotional' | 'suspense' | 'epic' | 'comedy';
  /** 钩子强度 0-1：控制前3秒开头悬念强度，0.2=平铺直叙(纪录片) / 0.9=极速冲突(短视频) */
  hookIntensity: number;
  /** 声画权重 0-1：0.2=偏向原声(依赖ASR) / 0.8=偏向视觉(依赖画面描述) */
  audioVisualWeight: number;
}

/** TTS 合成结果 */
export interface TtsResult { shotId: string; audioUrl?: string; _failed?: boolean; _error?: string; _synthesizing?: boolean; }

/** 镜头匹配结果 */
export interface MatchResult {
  shotId: string; mediaId: string; thumbnail?: string; score: number;
  confirmed: boolean; appliedSpeedFactor?: number; audioDurationMs?: number; chunkData?: Record<string, unknown>;
  /** 该段落对应的解说台词（用于卡片与预览展示，语义上即"这段台词匹配这个片段"） */
  text?: string;
  /** 原声段落标记：true 表示该段保留原片原声（不配 TTS 配音），匹配锁定在 ASR 原声所在的时间段 */
  keepOriginalAudio?: boolean;
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