/**
 * 语速-容量空间动态预测算子
 * 根据目标语种和语速系数，实时计算文案的预测音频时长，
 * 检测是否超出分镜时长容量，消除 TTS 物理越界隐患
 */

/** 语种默认语速配置（字符/秒） */
const SPEECH_RATE: Record<string, number> = {
  zh: 4.5,   // 中文每秒约 4-5 字
  en: 2.8,   // 英文每秒约 2-3 单词
  ja: 4.0,   // 日文每秒约 4 字
  ko: 3.5,   // 韩文每秒约 3.5 字
};

/** 容量溢出级别 */
export type OverflowLevel = 'safe' | 'warning' | 'overflow';

/** 语速预测结果 */
export interface SpeechPrediction {
  /** 预测音频时长（秒） */
  predictedDuration: number;
  /** 分镜时长（秒） */
  shotDuration: number;
  /** 溢出级别 */
  overflowLevel: OverflowLevel;
  /** 溢出秒数（正数表示超出，负数表示余量） */
  overflowSeconds: number;
  /** 建议删减字数（仅溢出时有值） */
  suggestCutChars: number;
}

/**
 * 检测文本语种（简单启发式：含中文字符则视为中文）
 * @param text 待检测文本
 * @returns 语种代码
 */
function detectLanguage(text: string): string {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  if (totalChars === 0) return 'zh';
  return chineseChars / totalChars > 0.3 ? 'zh' : 'en';
}

/**
 * 计算文本的有效字符数
 * 中文按字计数，英文按单词计数
 * @param text 文本内容
 * @param lang 语种
 * @returns 有效字符/单词数
 */
function countEffectiveChars(text: string, lang: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (lang === 'zh') {
    // 中文：统计汉字+标点
    return (trimmed.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
      + (trimmed.match(/[a-zA-Z]+/g) || []).length; // 英文单词按词计
  }
  // 英文：按单词计数
  return trimmed.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * 语速-容量空间动态预测
 * @param text 当前文案文本
 * @param shotDuration 分镜时长（秒）
 * @param speechRate 语速系数（1.0 为标准语速，>1 快速，<1 慢速）
 * @returns 预测结果
 */
export function predictSpeechCapacity(
  text: string,
  shotDuration: number,
  speechRate: number = 1.0
): SpeechPrediction {
  const lang = detectLanguage(text);
  const baseRate = SPEECH_RATE[lang] || SPEECH_RATE.zh;
  const effectiveRate = baseRate * speechRate;
  const charCount = countEffectiveChars(text, lang);

  // 预测音频时长 = 字符数 / 语速，加 0.5s 缓冲（停顿/呼吸）
  const predictedDuration = charCount > 0
    ? charCount / effectiveRate + 0.5
    : 0;

  const overflowSeconds = predictedDuration - shotDuration;

  // 溢出级别判定
  let overflowLevel: OverflowLevel = 'safe';
  if (overflowSeconds > 1.0) {
    overflowLevel = 'overflow';  // 超出 1 秒以上：严重溢出
  } else if (overflowSeconds > 0) {
    overflowLevel = 'warning';   // 超出但 1 秒以内：警告
  }

  // 计算建议删减字数
  const maxChars = Math.floor((shotDuration - 0.5) * effectiveRate);
  const suggestCutChars = charCount > maxChars ? charCount - maxChars : 0;

  return {
    predictedDuration: Math.round(predictedDuration * 10) / 10,
    shotDuration,
    overflowLevel,
    overflowSeconds: Math.round(overflowSeconds * 10) / 10,
    suggestCutChars,
  };
}
