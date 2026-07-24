import { LexiconLoader, LexiconLevel } from './LexiconLoader';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

export interface LexiconScanResult {
  original: string;
  cleanText: string;
  flagged: boolean;
  replaced: boolean;
  matches: Array<{ word: string; level: LexiconLevel; replaced: boolean }>;
}

const REPLACEMENT = {
  high: '哔——',
  default: '***',
};

/** V1.1 敏感词过滤器 — 三级扫描 + 高危替换 + 中低危标记 */
export class LexiconFilter {
  /** 扫描文本并返回净化结果 */
  scan(text: string): LexiconScanResult {
    if (!text || text.trim().length === 0) {
      return { original: text, cleanText: text, flagged: false, replaced: false, matches: [] };
    }

    const highWords = LexiconLoader.load('high');
    const mediumWords = LexiconLoader.load('medium');
    const lowWords = LexiconLoader.load('low');

    const matches: LexiconScanResult['matches'] = [];
    let cleanText = text;
    let hasReplaced = false;

    for (const word of highWords) {
      if (cleanText.includes(word)) {
        const regex = this.buildRegex(word);
        cleanText = cleanText.replace(regex, REPLACEMENT.high);
        matches.push({ word, level: 'high', replaced: true });
        hasReplaced = true;
      }
    }

    for (const word of mediumWords) {
      if (cleanText.includes(word)) {
        matches.push({ word, level: 'medium', replaced: false });
      }
    }

    for (const word of lowWords) {
      if (cleanText.includes(word)) {
        matches.push({ word, level: 'low', replaced: false });
      }
    }

    if (matches.length > 0) {
      AppLogger.info(LOG_TAGS.SYSTEM, `敏感词扫描: ${matches.length} 命中 (高危替换: ${hasReplaced})`);
    }

    return {
      original: text,
      cleanText,
      flagged: matches.length > 0,
      replaced: hasReplaced,
      matches,
    };
  }

  /** Audio-Safe Bypass: TTS 配音时返回原文 (不做敏感词替换) */
  getAudioSafeText(_cleanText: string, original: string): string {
    return original;
  }

  /** 为字幕/显示版本返回净化后文本 (高危词已替换) */
  getDisplayText(cleanText: string): string {
    return cleanText;
  }

  private buildRegex(word: string): RegExp {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'g');
  }
}
