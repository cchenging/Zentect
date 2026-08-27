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
  /** 💬 该帧时间区间内匹配到的 ASR 台词（顶层冗余，来自 VisionExtractStrategy，供 step2 UI 直接展示） */
  asrText?: string;
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
    /** 🎥 运镜方式（固定/推/拉/摇/移），VLM 结构化输出 */
    cameraMovement?: string;
    /** ⚡ 剧情张力/看点，供 step3 提炼解说钩子 */
    dramaticConflict?: string;
    /** 👤 画面核心主体（优先使用已知角色真实姓名） */
    subject?: string;
    /** 👥 多人物主焦点：画面中核心叙事人物（优先角色名，如"张三"） */
    primarySubject?: string;
    /** 👥 多人物陪体列表：辅助/次要人物（如 ["李四"]），背景路人不入此列 */
    secondarySubjects?: string[];
    /** 🤝 人物间交互动作：谁对谁做了什么（15字内动词主导，如"张三举枪质问角落里的李四"） */
    interaction?: string;
    /** 🎬 多人物场景分类：单人/双人对峙/过肩镜头/群戏/主角+背景人群 */
    shotStyle?: string;
    /** 🎭 该帧出现的角色名集合（primary + secondary + 可辨识路人），供 step3/step5 角色组合过滤 */
    characters?: string[];
    /** 💬 该帧时间区间内匹配到的 ASR 台词，供 step3 直接消费无需重新匹配 */
    asrText?: string;
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
  /**
   * 🎭 P1 角色组合匹配：本段解说词所对应的视频片段中出现的人物名集合。
   * 来源：步骤2 VLM 角色锚定（downstream.characters），经步骤3 按 chunk 透传、前端持久化到本字段。
   * 步骤5 以此为 Query 端角色名单，与切片（Chunk 端）角色集合做契合度匹配（软加成，未命中不惩罚）。
   * 用户手动修改本段解说后，前端更新此字段，步骤5 重新匹配即可实时感知。
   */
  characters?: string[];
  /** 🎯 P3 画面意图：本段解说词"应配什么画面"的画面语言描述（主体/动作/场景/景别/氛围），
   *  步骤5 以此为匹配查询依据，与切片描述做文本↔文本语义匹配 */
  visualIntent?: string;
  /** 🎯 P3 时间轴锚定：本段解说词对应的画面时间起点/时长（ms），供步骤5 锚定切片 */
  startMs?: number;
  durationMs?: number;
}

/**
 * 解说文案生成参数（融合方案：枚举按钮组 + 连续值协同）
 * 替代旧版 R/S/T/P 滑块，改为专业解说维度的枚举参数
 */
export interface PipelineParams {
  /** 叙事视角：third=第三人称上帝视角 / first=第一人称沉浸 / second=第二人称吐槽互动 */
  narrativePerspective: 'third' | 'first' | 'second';
  /**
   * 解说占比 0~1（0=无解说全原声 / 1=全解说不留原声，可自由取值）
   * 与保留原声互斥一体：保留原声比例 = 1 - narrationRatio，二者合并为一个滑杆，不再分两个参数相乘。
   * 派生规则（SSOT，与 ScriptGenStrategy/Service/前端一致）：
   * - 字数填充系数 densityFillRate = narrationRatio（解说占时间轴的比例，即"解说密度"）
   * - 允许标记原声段落 allowOriginalMark = narrationRatio < 1（留了原声空间才允许标记）
   */
  narrationRatio: number;
  /** 节奏模式：short_fast=短句快切 / mixed=长短交替 / slow_soothing=长句舒缓 */
  rhythmMode: 'short_fast' | 'mixed' | 'slow_soothing';
  /** 情绪基调：neutral=客观中立 / emotional=情感渲染 / suspense=悬疑营造 / epic=高燃热血 / comedy=搞笑吐槽 */
  emotionTone: 'neutral' | 'emotional' | 'suspense' | 'epic' | 'comedy';
  /** 钩子强度 0-1：控制前3秒开头悬念强度，0.2=平铺直叙(纪录片) / 0.9=极速冲突(短视频) */
  hookIntensity: number;
  /**
   * 目标解说时长（秒）：>0 时生效，覆盖 narrationRatio 的填充率（等效填充率 = 目标时长 / 视频总时长）
   * 0 / undefined = 不限制，按 narrationRatio 自动计算。用于直接控制解说总时长。
   */
  targetNarrationDurationSec?: number;
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
  /** 该镜头在最终合成时间线上的绝对起点（ms），用于预览定位画面 */
  videoTimelineStartMs?: number;
  /** 该镜头在最终合成时间线上的绝对终点（ms），用于预览定位画面 */
  videoTimelineEndMs?: number;
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
  /**
   * 🎬 阶段 A 父子语义：所属物理镜头 ID（Python 场景切片的原始镜头边界 / Node 超长拆分父段）。
   * 同一物理镜头内被细分/拆分出的多个连续子段共享同一 parentChunkId，
   * 导出层据此识别"假转场"（同镜头兄弟段被当独立镜头硬切）并合并为单个 clip。
   */
  parentChunkId?: string;
  /** 所属物理镜头起始时间（ms） */
  parentStartMs?: number;
  /** 在物理镜头内的子段序号（0 起） */
  segmentIndexInParent?: number;
}

/** 背景音乐 */
export interface BgmInfo {
  id: string;
  filePath: string;
  /** BGM 名称（用于界面展示） */
  name?: string;
  /** 曲目 BPM，供卡点对齐 */
  bpm?: number;
  /** 时长（毫秒） */
  durationMs?: number;
  /** 曲库来源 URL（P1 引入） */
  sourceUrl?: string;
  /** 试听 URL（P1 引入） */
  previewUrl?: string;
}

/** 角色的人脸元数据（单张脸） */
export interface FaceFeature {
  /** 人脸图片路径（项目内相对路径或绝对路径，由调用方决定） */
  facePath?: string;
  /** 性别（male/female） */
  gender?: string;
  /** 年龄估计 */
  age?: number;
  /** 人脸框坐标 [x1, y1, x2, y2] */
  bbox?: number[];
  /** 所属帧索引（用于帧级角色锚定） */
  frameIndex?: number;
  /** 所属帧路径 */
  frame?: string;
  /**
   * 🎭 四重质量门禁的原始值（Python 端 /api/vision 返回，供下游聚类/角色分级/UI 质检展示）
   * 运行时数据已存在，此处补齐类型契约，让 TS 静态层面可见可消费。
   * 统一约定：数字字段缺省时视为"未采集"（undefined），不设默认值。
   */

  /** 姿态角 [pitch, yaw, roll]（度），大侧脸/低头抬头脸在提取前已被 30° 门禁过滤 */
  pose?: number[];
  /** InsightFace 检测置信度（0~1，运行时字段名 det_score），低于 0.85 的低置信检测已被过滤 */
  det_score?: number;
  /** ROI 拉普拉斯方差（清晰度），低于 100 的运动模糊脸已被过滤 */
  clarity?: number;
  /** 512 维 ArcFace 归一化特征向量，用于聚类与跨项目人物匹配 */
  embedding?: number[];
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
  /** 🎭 角色主次分级：main 主角 / supporting 配角 / extra 背景路人（服务端自动标注，前端按此分组展示） */
  tier?: 'main' | 'supporting' | 'extra';
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
  /**
   * 性别（1=男/0=女/unknown=未知）
   * 兼容 role.gender 直接访问（与 representative.gender 二选一，前端取并集）
   */
  gender?: number | string;
  /** 年龄估计（前端展示用，与 representative.age 二选一） */
  age?: number;
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