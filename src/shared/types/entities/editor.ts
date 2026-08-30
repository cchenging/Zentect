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

/**
 * 公共基座：解说旁白段 / 原声穿插段共享的时间轴与语义元数据。
 * 判别联合（Discriminated Union）：下游一律以 `p.type === 'narration'` 完成类型收窄，
 * 编译期杜绝「原声段误读 text」「解说段缺时间轴」两类静默错误。
 */
export interface BaseScriptParagraph {
  id: string;
  shotId?: string;
  /** 判别字段：AI 旁白 vs 原片原声；下游按 p.type 收窄的唯一依据 */
  type: 'narration' | 'original_audio';
  /** 该段落/原声在正片中的基准时间戳（源绝对起点，ms）；步骤4 试听定位、步骤5 时间锚定、前端渲染共用 */
  startMs: number;
  /** 刚性占有时长（毫秒）；与 startMs 同为契约硬约束，经 Normalizer 工厂保证入库非空 */
  durationMs: number;
  /** 情绪标签；步骤4 音色/停顿选择、步骤5 情绪维度匹配共用 */
  emotion?: string;
  /**
   * ⏱️ 秒级时长遗留兼容字段（≈ durationMs/1000，历史 TTS/字幕链路仍按秒读取）
   * @deprecated 新代码一律以 durationMs 为准；兼容期结束随 keepOriginalAudio 一并移除
   */
  duration?: number;
  /**
   * 🔁 兼容迁移期遗留标记（@deprecated，保留一个版本周期）：判别联合落地前旧数据的原声布尔标记。
   * 读取端临时以 `type ?? keepOriginalAudio` 回退判定；所有持久化入口已经
   * normalizeScriptParagraph（§4.1 Normalizer 工厂）统一净化补齐 type，期满整体删除本字段。
   */
  keepOriginalAudio?: boolean;
}

/** 解说旁白段：正文 text 必填（编译期即杜绝空引用风险，取代散落的 `p.text || ""` 运行时兜底链） */
export interface NarrationParagraph extends BaseScriptParagraph {
  type: 'narration';
  /** 解说词正文（严格 ≤ maxSentenceChars 上限，由爆破器二次兜底） */
  text: string;
  /** UI 行内编辑态 */
  editing?: boolean;
  /** TTS 净化副本（剥离特殊符号后送合成） */
  audioSafeText?: string;
  /** 计费/缓存用规范化文本 */
  cleanText?: string;
  /**
   * 🎯 P3 画面意图：本段解说词"应配什么画面"的画面语言描述（主体/动作/场景/景别/氛围），
   * 步骤5 以此为匹配查询依据，与切片描述做文本↔文本语义匹配
   */
  visualIntent?: string;
  /**
   * 🎭 P1 角色组合匹配：本段解说词所对应的视频片段中出现的人物名集合。
   * 来源：步骤2 VLM 角色锚定（downstream.characters），经步骤3 按 chunk 透传、前端持久化到本字段。
   * 步骤5 以此为 Query 端角色名单，与切片（Chunk 端）角色集合做契合度匹配（软加成，未命中不惩罚）。
   * 用户手动修改本段解说后，前端更新此字段，步骤5 重新匹配即可实时感知。
   */
  characters?: string[];
}

/** 原声穿插段：播放以原片切片硬绑定为准，正文概念由 audioSource.transcript 承载（不参与 TTS 合成） */
export interface OriginalAudioParagraph extends BaseScriptParagraph {
  type: 'original_audio';
  /**
   * 必填结构体：步骤4 据此在最外层跳过 TTS 请求，步骤5 据此 100% 硬绑定画面切片，
   * 导出层据此对 BGM 做 -12dB 自动闪避（ducking）。历史数据缺失时由 Normalizer 按源时间窗 fallback 重建。
   */
  audioSource: {
    /** 原片 ASR 真实绝对起始时间戳（ms） */
    sourceStartMs: number;
    /** 原片 ASR 真实绝对结束时间戳（ms） */
    sourceEndMs: number;
    /** 说话人姓名（如 "高启强"；历史数据缺失时由 Normalizer 标注占位） */
    speaker: string;
    /** 原声台词文本（替代旧原声段的 text 字段语义） */
    transcript: string;
    /** 导出时是否自动压低 BGM（-12dB ducking，突出台词） */
    duckingBgm: boolean;
  };
}

/** 步骤3 对外产出契约：调用方必须以 type 收窄处理，禁止直接访问联合独有字段 */
export type ScriptParagraph = NarrationParagraph | OriginalAudioParagraph;

/** 🎚️ 原声策略三档取值元组（SSOT 单源：主进程密度折减系数映射与前端三选一按钮共用本联合，禁止在别处复写字面量） */
export const AUDIO_STRATEGY_VALUES = ['smart_keep', 'pure_narration', 'original_focus'] as const;
/** 原声策略三档联合类型别名 */
export type AudioStrategy = (typeof AUDIO_STRATEGY_VALUES)[number];

/**
 * SSOT 红线：三档原声策略 ⇔ 解说密度折减系数 DensityRatio 的唯一映射表
 * （定律一 N_total = ⌊T_target × v × DR × α⌋ 中 DR 的唯一来源，主进程 ScriptGenStrategy 与前端档位切换共用本表）。
 * 表内数值同时是前端切档时同步写回 narrationRatio 的同源值（smart_keep ⇔ 0.70 / pure_narration ⇔ 0.85 /
 * original_focus ⇔ 0.35），保证 legacy narrationRatio 口径与策略口径永不发散；修改任一档系数只动这里。
 */
export const DENSITY_RATIO_BY_AUDIO_STRATEGY: Record<AudioStrategy, number> = {
  smart_keep: 0.70,
  pure_narration: 0.85,
  original_focus: 0.35,
};

/** 🎨 风格氛围五档取值元组（前端预设联动载体的合法取值：仅持久化与回显，主进程不单独解析） */
export const VIBE_PRESET_VALUES = ['viral', 'deep_suspense', 'sharp_roast', 'immersive_first', 'documentary'] as const;
/** 风格氛围五档联合类型别名 */
export type VibePreset = (typeof VIBE_PRESET_VALUES)[number];

/** 🗣️ 解说人称三档取值元组（SSOT 单源：前端三选一按钮顺序与调性预设联动写入均用本联合，禁止在别处复写字面量） */
export const NARRATIVE_PERSPECTIVE_VALUES = ['third', 'first', 'second'] as const;
/** 解说人称三档联合类型别名 */
export type NarrativePerspective = (typeof NARRATIVE_PERSPECTIVE_VALUES)[number];

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
  /**
   * 🎚️ 原声策略三档预设（SSOT 红线：唯一映射解说密度折减系数 DensityRatio，
   * 与 ScriptGenStrategy 预算定律 N_total = ⌊T_target × v × DR × α⌋ 同口径）：
   * - smart_keep=智能保留（DR=0.70）/ pure_narration=纯解说（DR=0.85）/ original_focus=原声主打（DR=0.35）
   * ⛔ 与 narrationRatio 滑杆互斥并存：前端 UI 三选一按钮驱动，选中即同步写回 narrationRatio 整体提交；
   * legacy 兼容：老工程无此字段时，主进程退化为直接采用 narrationRatio（与旧口径一致）。
   */
  audioStrategy?: AudioStrategy;
  /**
   * 🎨 风格氛围预设五档（仅前端预设联动载体）：viral=爆款爽感 / deep_suspense=深度悬疑 /
   * sharp_roast=犀利吐槽 / immersive_first=第一人称沉浸 / documentary=纪录片质感。
   * 切换时由前端一次性同步写回叙事视角/情绪基调/钩子强度等离散参数并整体 setPipelineParams 提交；
   * 主进程不单独解析本字段，仅为持久化与回显保留。
   */
  vibePreset?: VibePreset;
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
  /**
   * 🎯 目标成片篇幅（秒）：定律一预算公式 N_total = ⌊T_target × v × DR × α⌋ 的 T_target 输入，
   * 其中 v=基准语速（vibePreset 联动）、DR=原声密度比（audioStrategy 三档打包）、α=0.85 标点停顿折损。
   * 预设档：180=3min 快剪 / 600=10min 精讲(推荐) / 1200=20min 深度大片。
   * 0 / undefined = 自动：沿用视频总长推导（T_target = totalDurationSec），避免老工程行为跳变。
   * ⛔ 语义区分：本字段为"成片总时长"口径，与 targetNarrationDurationSec（解说净时长软约束）不可混用；
   * 优先级：targetDurationSec >0 最高，targetNarrationDurationSec 次之（存量兼容），最后视频总长推导。
   */
  targetDurationSec?: number;
}

/** TTS 合成结果 */
export interface TtsResult {
  /** ✅ 身份键统一：id 为段落唯一主键（出生处全局唯一），消费端一律读 id；shotId 保留同值兼容 */
  id: string;
  shotId: string;
  audioUrl?: string; _failed?: boolean; _error?: string; _synthesizing?: boolean;
}

/** 镜头匹配结果 */
export interface MatchResult {
  /** ✅ 身份键统一：id 为段落唯一主键（出生处全局唯一），此即前端 React key，消费端一律读 id */
  id: string;
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