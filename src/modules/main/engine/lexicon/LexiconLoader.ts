import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../../utils/pathManager';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../infra/logger/LogConstants';

export type LexiconLevel = 'high' | 'medium' | 'low';

/** V1.1 三级词库加载器 — 从 resources/lexicon/ 加载高危/中危/低危词库 */
export class LexiconLoader {
  private static cache = new Map<LexiconLevel, Set<string>>();

  /** 加载指定级别的词库 (带内存缓存) */
  static load(level: LexiconLevel): Set<string> {
    if (this.cache.has(level)) return this.cache.get(level)!;

    const words = new Set<string>();
    const lexiconDir = path.join(PathManager.getResourcesPath(), 'lexicon');

    try {
      const filePath = path.join(lexiconDir, `${level}.txt`);
      if (!fs.existsSync(filePath)) {
        AppLogger.warn(LOG_TAGS.SYSTEM, `词库文件不存在: ${filePath}`);
        this.cache.set(level, words);
        return words;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          words.add(trimmed);
        }
      }

      AppLogger.info(LOG_TAGS.SYSTEM, `词库 [${level}] 加载完成: ${words.size} 词`);
      this.cache.set(level, words);
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.SYSTEM, `词库 [${level}] 加载失败`, err);
      this.cache.set(level, words);
    }

    return words;
  }

  /** 重新加载所有词库 (清除缓存) */
  static reload(): void {
    this.cache.clear();
    this.load('high');
    this.load('medium');
    this.load('low');
  }
}
