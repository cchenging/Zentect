// 📁 路径：src/main/engine/ttsEmotion.ts
// 🎭 步骤4 TTS 情绪语气：把步骤3 的自由情绪词收敛为「语速乘子 + 音高偏移」。
//
// 设计口径（docs/designs/2026-11-16-步骤4-TTS情绪与响度设计方案.md §4）：
//  - 7 桶关键词表决，命中数最高者胜；同分取表序靠前者；无命中 = 中性（不传任何参数，保持现行为）
//  - 强度档对「(乘子-1)」与「音高偏移」同比例插值
//  - 最终 rate 夹取 [0.8, 1.25]，pitch 夹取 ±4Hz
//  - 只改语速/音高，不改音量（响度由 loudnorm 统一）
//
// 纯函数、无 IO，供 Strategy（批量）与 TTSEngine.runSingleTTS（单段重合成）共用，保证两条路径口径一致。

export type TtsEmotionStrength = 'weak' | 'normal' | 'strong';

/** 强度档 → 插值系数：weak/normal/strong = 0.5 / 1.0 / 1.5 */
export const EMOTION_STRENGTH_FACTOR: Record<TtsEmotionStrength, number> = {
  weak: 0.5,
  normal: 1.0,
  strong: 1.5,
};

/** 最终语速倍率夹取区间（避免情绪叠加全局语速后夸张失真） */
const RATE_MIN = 0.8;
const RATE_MAX = 1.25;
/** 音高偏移上限（Hz） */
const PITCH_LIMIT_HZ = 4;

interface EmotionBucket {
  key: string;
  label: string;
  keywords: readonly string[];
  /** 语速乘子（强度 normal 时的原始值） */
  rateMul: number;
  /** 音高偏移（Hz，强度 normal 时的原始值） */
  pitchHz: number;
}

/** 关键词表：数组顺序即同分优先级 */
const EMOTION_BUCKETS: readonly EmotionBucket[] = [
  { key: 'tense', label: '紧张·悬疑', keywords: ['紧张', '悬疑', '不安', '警觉', '压迫', '窒息', '惊惧'], rateMul: 1.04, pitchHz: 1 },
  { key: 'angry', label: '愤怒·冲突', keywords: ['愤怒', '怒', '爆发', '吼', '对峙', '冲突', '狠'], rateMul: 1.06, pitchHz: -1 },
  { key: 'sad', label: '悲伤·压抑', keywords: ['悲', '哭', '落泪', '绝望', '压抑', '沉重', '心碎'], rateMul: 0.94, pitchHz: -2 },
  { key: 'warm', label: '温情·治愈', keywords: ['温暖', '温情', '治愈', '柔和', '安心', '甜蜜', '怀旧'], rateMul: 0.96, pitchHz: 0 },
  { key: 'surprise', label: '惊讶·反转', keywords: ['惊讶', '震惊', '错愕', '反转', '意外'], rateMul: 1.08, pitchHz: 3 },
  { key: 'passion', label: '高燃·热血', keywords: ['燃', '热血', '激昂', '振奋', '燃爆', '决战'], rateMul: 1.05, pitchHz: 2 },
];

export interface EmotionProsody {
  /** 命中的桶 key；中性或为空时 'neutral' */
  bucket: string;
  /** 桶中文名（日志用） */
  label: string;
  /** 是否命中情绪词：false = 中性（不产生任何韵律参数） */
  hit: boolean;
  /** 最终语速倍率（已按强度插值并夹取；中性 = 全局语速原值） */
  rate: number;
  /** 最终音高偏移 Hz（整数，已夹取；中性 = 0） */
  pitchHz: number;
}

/** 归一化情绪词：去空白与常见标点（保留中文语义字符） */
function normalizeEmotion(emotion: unknown): string {
  if (typeof emotion !== 'string') return '';
  return emotion.replace(/[\s，,。.;；:：!！?？、【】[\]()（）「」『』"'“”]/g, '');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 情绪 → 逐段韵律参数。
 *
 * @param emotion     步骤3 写入的自由情绪短词（可空）
 * @param globalRate  全局/风格包语速倍率（中性时原样返回，绝不夹取改变用户设定）
 * @param strength    强度档，默认 normal；非法值按 normal 处理
 */
export function resolveEmotionProsody(
  emotion: unknown,
  globalRate: number,
  strength: TtsEmotionStrength = 'normal'
): EmotionProsody {
  const baseRate = typeof globalRate === 'number' && globalRate > 0 ? globalRate : 1.0;
  const neutral: EmotionProsody = { bucket: 'neutral', label: '中性', hit: false, rate: baseRate, pitchHz: 0 };

  const text = normalizeEmotion(emotion);
  // 「空 / 无 / 中性」显式归中性，避免关键字表误判
  if (!text || text === '无' || text === '中性') return neutral;

  let best: { bucket: EmotionBucket; hits: number } | null = null;
  for (const bucket of EMOTION_BUCKETS) {
    let hits = 0;
    for (const kw of bucket.keywords) {
      // 出现次数累加（如「燃爆」同时命中「燃」与「燃爆」，视为更强证据）
      hits += text.split(kw).length - 1;
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { bucket, hits };
  }
  if (!best) return neutral;

  const factor = EMOTION_STRENGTH_FACTOR[strength] ?? EMOTION_STRENGTH_FACTOR.normal;
  const rateMul = 1 + (best.bucket.rateMul - 1) * factor;
  const pitchRaw = Math.round(best.bucket.pitchHz * factor);

  return {
    bucket: best.bucket.key,
    label: best.bucket.label,
    hit: true,
    rate: clamp(baseRate * rateMul, RATE_MIN, RATE_MAX),
    pitchHz: clamp(pitchRaw, -PITCH_LIMIT_HZ, PITCH_LIMIT_HZ),
  };
}
