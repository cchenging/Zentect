// 📁 路径: src/main/engine/media/MediaLanguageDetector.ts
// ASR 结果分析：检测是否外语/无台词，用于阻断 Pipeline 并友好提示

export interface LanguageCheckResult {
  status: 'zh' | 'foreign' | 'silent';
  textSample: string;
  message: string;
}

/**
 * 检测 ASR 转录文本的语言类型。
 * 规则：
 *   1. 文本为空或只有空白 → silent（无台词）
 *   2. 文本中中文字符占比 < 20% → foreign（外语）
 *   3. 否则 → zh（正常）
 */
export function detectMediaLanguage(transcriptText: string, detectedLanguage?: string): LanguageCheckResult {
  const cleaned = (transcriptText || '').trim();

  // 无台词
  if (!cleaned || cleaned.length < 2) {
    return {
      status: 'silent',
      textSample: cleaned,
      message: '未检测到台词。Beta 版暂不支持无台词影片（如纯音乐、默片）的自动解说。'
    };
  }

  // 统计中文字符占比
  const chineseChars = cleaned.match(/[\u4e00-\u9fff]/g);
  const chineseRatio = chineseChars ? chineseChars.length / cleaned.length : 0;

  // 如果 SenseVoice 返回的语言标签明确不是 zh
  const isForeignLang = detectedLanguage && detectedLanguage !== 'zh' && detectedLanguage !== 'auto';

  if (isForeignLang || chineseRatio < 0.2) {
    const langName = detectedLanguage || (chineseRatio < 0.2 ? '非中文' : '其他语言');
    return {
      status: 'foreign',
      textSample: cleaned.slice(0, 100),
      message: `检测到语言为「${langName}」。Beta 版暂不支持外语影片的自动中文解说，请期待后续版本。`
    };
  }

  return {
    status: 'zh',
    textSample: cleaned.slice(0, 100),
    message: ''
  };
}

/**
 * 检测 ASR 输出的 JSON 结果
 */
export function detectFromASRJson(asrOutput: any): LanguageCheckResult {
  if (!asrOutput) {
    return detectMediaLanguage('');
  }

  const language = asrOutput.language || '';
  const transcription = asrOutput.transcription || [];

  // 合并所有文本
  const fullText = transcription
    .map((t: any) => t.text || t.content || '')
    .filter(Boolean)
    .join('');

  return detectMediaLanguage(fullText, language);
}
