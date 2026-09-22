/**
 * Shot Spec（分镜师工单）共享契约——S2 分镜师 Agent 输出 / S3 剪辑改道输入的**唯一同源 schema**（§24.2）。
 *
 * 责任边界：
 * - 本文件是 C0 契约的 TS 唯一真源，字段严格对齐方案 §24.2；
 * - Python 端 `resources/scripts/shot_spec.py` 由本文件字段清单同步维护（后改为生成式，见 TODO C0-3）；
 * - 任何新增字段必须先改这里，再同步 Python，保证「一个完整句 = 一条工单」的双端同构。
 */

/* ==================== 枚举常量（与 Python 端逐项一一对应） ==================== */

/** 工单模式：有实体句开新镜；评论/过渡/抒情句顺延上一镜（不检索） */
export const ShotSpecMode = {
  NEW_SHOT: 'NEW_SHOT',
  CONTINUE_PREV: 'CONTINUE_PREV',
} as const;
export type ShotSpecModeValue = typeof ShotSpecMode[keyof typeof ShotSpecMode];

/** 空间类型（门禁枚举，词表来自 S1 场记单的 20 个地点类；不引第二套空间枚举） */
export const SpatialType = {
  INDOOR_RESIDENCE: 'INDOOR_RESIDENCE', // 室内·住宅
  INDOOR_PUBLIC: 'INDOOR_PUBLIC',       // 室内·公共场所
  OUTDOOR_STREET: 'OUTDOOR_STREET',     // 室外·街道
  OUTDOOR_NATURE: 'OUTDOOR_NATURE',     // 室外·自然景
  VEHICLE: 'VEHICLE',                   // 载具内部
  TRANSIT_HUB: 'TRANSIT_HUB',           // 交通枢纽
  UNKNOWN: 'UNKNOWN',                   // 泛化/未知类（S1 泛化类 6.8%）
} as const;
export type SpatialTypeValue = typeof SpatialType[keyof typeof SpatialType];

/** 景别（软排，只能取自该段实际存在的景别） */
export const PreferredShot = {
  EXTREME_LONG: 'EXTREME_LONG', // 全景·大全景
  LONG_SHOT: 'LONG_SHOT',       // 全景
  FULL_SHOT: 'FULL_SHOT',       // 中全景
  MEDIUM_SHOT: 'MEDIUM_SHOT',   // 中景
  MEDIUM_CLOSE: 'MEDIUM_CLOSE', // 中近景
  CLOSE_SHOT: 'CLOSE_SHOT',     // 近景
  EXTREME_CLOSE: 'EXTREME_CLOSE', // 特写
} as const;
export type PreferredShotValue = typeof PreferredShot[keyof typeof PreferredShot];

/** 运镜（软排） */
export const CameraDynamic = {
  STATIC: 'STATIC', // 固定
  PAN: 'PAN',       // 横摇
  TILT: 'TILT',     // 竖摇
  PUSH: 'PUSH',     // 推
  PULL: 'PULL',     // 拉
  FOLLOW: 'FOLLOW', // 跟
} as const;
export type CameraDynamicValue = typeof CameraDynamic[keyof typeof CameraDynamic];

/** 情绪（软排；链条无情绪字段时跳过，不罚） */
export const ShotEmotion = {
  WARM: 'WARM',         // 温馨
  TENSE: 'TENSE',       // 紧张
  JOYFUL: 'JOYFUL',     // 欢快
  SAD: 'SAD',           // 悲伤
  NEUTRAL: 'NEUTRAL',   // 中性
} as const;
export type ShotEmotionValue = typeof ShotEmotion[keyof typeof ShotEmotion];

/** 音频模式：narration=解说合成；original=原声段（须锁说话人、且不参与变速） */
export const AudioMode = {
  NARRATION: 'narration',
  ORIGINAL: 'original',
} as const;
export type AudioModeValue = typeof AudioMode[keyof typeof AudioMode];

/**
 * 降级链 Level（值越小越严）：L0-L5 全集见 §24.4。
 * - L0 硬门禁全命中（最严）
 * - L1..L4 逐级放宽（同段环境/空镜/同段任意未用等）
 * - L5 段内复用（额度 ≤2）
 * 实指句末级**不用** CONTINUE_PREV（防画面死锁）。
 */
export const FallbackLevel = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
} as const;
export type FallbackLevelValue = typeof FallbackLevel[keyof typeof FallbackLevel];

/* ==================== 工单本体 ==================== */

/**
 * Shot Spec 工单：@24.2-2154 逐字段对齐。
 * 一份工单对应「一个完整句」（sentence 档 matchUnitId），由 S2 分镜师 Agent 产出。
 */
export interface ShotSpec {
  /** 唯一主键：来源完整句的 matchUnitId（与步骤3/步骤5 同源），便于溯源 */
  matchUnitId: string;
  /** 每母句一句，若某句不需要开新镜则为 CONTINUE_PREV */
  mode: ShotSpecModeValue;
  /** 剧情场次段号（来自场记单 §24.10），圈定局部候选池 */
  segmentId: number;
  /** 空间类型（门禁）；高纯度段 locPurity≥0.6 时硬卡，<0.6 转软排 */
  spatialType: SpatialTypeValue;
  /** 主体（只能取自该段的 characters 白名单） */
  targetSubjects: string[];
  /** 动作类别（可空：纯环境句） */
  actionType?: string;
  /** 关键道具类别（可空） */
  keyProp?: string;
  /** 首选景别（软排；只能取自该段实际存在景别） */
  preferredShot: PreferredShotValue;
  /** 运镜（软排） */
  cameraDynamic: CameraDynamicValue;
  /** 情绪（软排） */
  emotion: ShotEmotionValue;
  /** 音频模式 */
  audioMode: AudioModeValue;
  /** 允许降到第几级（§24.4 降级链） */
  fallbackLevel: FallbackLevelValue;
  /** 散文备注：仅作软排序微调/兜底，不参与硬门禁 */
  atmosphereNote?: string;
  /** 🎬 展示透传（非开单依据，不开给 LLM）：本工单对应完整句的文案原文 */
  text?: string;
  /** 🎬 展示透传（非开单依据，不开给 LLM）：本工单对应完整句的画面意图描述 */
  visualIntent?: string;
}

/** 校验时合法枚举的集合（供结构校验 ① 与 JSON schema 共用） */
export const SHOT_SPEC_ENUMS = {
  mode: Object.values(ShotSpecMode),
  spatialType: Object.values(SpatialType),
  preferredShot: Object.values(PreferredShot),
  cameraDynamic: Object.values(CameraDynamic),
  emotion: Object.values(ShotEmotion),
  audioMode: Object.values(AudioMode),
  fallbackLevel: Object.values(FallbackLevel),
} as const;