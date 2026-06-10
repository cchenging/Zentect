/**
 * 文案与视觉双向条件概率检索机制
 * 提取文案中的核心实体与动作，与视觉特征库执行余弦相似度匹配，
 * 实现"文案驱动画面自动重组"
 */

/** 匹配候选结果 */
export interface MatchCandidate {
  /** 帧画面 ID */
  frameId: string;
  /** 帧画面 URL */
  frameUrl: string;
  /** 匹配置信度 (0-1) */
  score: number;
  /** 匹配命中的关键词 */
  matchedKeywords: string[];
}

/**
 * 从文案文本中提取核心关键词（实体+动作）
 * 使用轻量级启发式规则，无需 NLP 依赖
 * @param text 文案文本
 * @returns 关键词数组
 */
export function extractScriptKeywords(text: string): string[] {
  if (!text || !text.trim()) return [];

  const keywords: string[] = [];

  // 1. 提取中文名词短语（2-4字组合，排除停用词）
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
    '看', '好', '自己', '这', '他', '她', '它', '们', '那', '被', '从', '把',
    '让', '给', '对', '向', '为', '以', '但', '而', '却', '又', '与', '或',
  ]);

  // 提取 2-4 字中文词组
  const chinesePhrases = text.match(/[\u4e00-\u9fff]{2,4}/g) || [];
  for (const phrase of chinesePhrases) {
    if (!stopWords.has(phrase)) {
      keywords.push(phrase);
    }
  }

  // 2. 提取动词（简单启发式：以"了/着/过"结尾的词的前缀）
  const verbPatterns = text.match(/[\u4e00-\u9fff]{1,3}(?:了|着|过)/g) || [];
  for (const vp of verbPatterns) {
    const verb = vp.replace(/[了着过]$/, '');
    if (verb.length >= 1 && !stopWords.has(verb)) {
      keywords.push(verb);
    }
  }

  // 3. 提取英文关键词（3+字母的单词，排除停用词）
  const enStopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
    'too', 'very', 'just', 'because', 'as', 'until', 'while', 'of',
    'at', 'by', 'for', 'with', 'about', 'against', 'between', 'through',
    'during', 'before', 'after', 'above', 'below', 'to', 'from', 'in',
    'on', 'it', 'its', 'this', 'that', 'these', 'those', 'he', 'she',
    'they', 'we', 'you', 'i', 'me', 'him', 'her', 'us', 'them', 'my',
  ]);
  const enWords = text.match(/[a-zA-Z]{3,}/g) || [];
  for (const w of enWords) {
    if (!enStopWords.has(w.toLowerCase())) {
      keywords.push(w.toLowerCase());
    }
  }

  // 去重并返回
  return [...new Set(keywords)];
}

/**
 * 计算文案关键词与画面描述的匹配分数
 * 基于关键词命中率的简化余弦相似度
 * @param scriptKeywords 文案关键词
 * @param visionDescription 画面描述文本
 * @returns 匹配分数 (0-1) 和命中的关键词
 */
export function computeMatchScore(
  scriptKeywords: string[],
  visionDescription: string
): { score: number; matchedKeywords: string[] } {
  if (!scriptKeywords.length || !visionDescription) {
    return { score: 0, matchedKeywords: [] };
  }

  const descLower = visionDescription.toLowerCase();
  const matched: string[] = [];

  for (const kw of scriptKeywords) {
    if (descLower.includes(kw.toLowerCase())) {
      matched.push(kw);
    }
  }

  // 匹配分数 = 命中关键词数 / 总关键词数（归一化到 0-1）
  const score = matched.length / scriptKeywords.length;
  return { score: Math.min(score, 1), matchedKeywords: matched };
}

/**
 * 为一段文案在视觉帧库中查找最佳匹配
 * @param scriptText 文案文本
 * @param vlmFrames 视觉帧数组 [{url, description, ...}]
 * @param topK 返回前 K 个候选
 * @returns 匹配候选列表（按分数降序）
 */
export function findBestVisionMatches(
  scriptText: string,
  vlmFrames: Array<{ url?: string; description?: string; framePath?: string; id?: string }>,
  topK: number = 3
): MatchCandidate[] {
  const keywords = extractScriptKeywords(scriptText);
  if (!keywords.length || !vlmFrames.length) return [];

  const candidates: MatchCandidate[] = vlmFrames
    .map((frame, idx) => {
      const desc = frame.description || '';
      const { score, matchedKeywords } = computeMatchScore(keywords, desc);
      return {
        frameId: frame.id || `frame_${idx}`,
        frameUrl: frame.url || frame.framePath || '',
        score,
        matchedKeywords,
      };
    })
    .filter(c => c.score > 0)  // 过滤零分
    .sort((a, b) => b.score - a.score)  // 降序排列
    .slice(0, topK);

  return candidates;
}
