// 📁 路径：src/shared/utils/jsonUtils.ts
// 🚀 鲁棒 JSON 解析工具（通用 VLM 适配器的核心依赖）

/**
 * 鲁棒解析 VLM 返回的 JSON 文本
 *
 * 不同视觉大模型（Qwen-VL / Claude / 豆包 / OpenAI 兼容 / 本地开源模型）的返回格式差异巨大：
 * - 可能用 Markdown 代码块包裹（```json ... ```）
 * - 可能在 JSON 前后输出解释性废话
 * - 可能返回对象 { frames: [...] } 或裸数组 [ ... ]
 *
 * 本函数统一剥离 Markdown 标记、截取最外层 JSON 结构，再交给 JSON.parse。
 * 若最终仍解析失败，则【直接抛错】（错就错原则），绝不静默降级，
 * 将"模型未按规范返回"这一真实问题暴露给上层调用方。
 *
 * @param rawText VLM 返回的原始文本
 * @returns 解析后的结构化数据
 * @throws 当文本为空或不是合法 JSON 时抛错
 */
export function safeParseVlmJson<T>(rawText: string): T {
  if (!rawText || !rawText.trim()) {
    throw new Error('VLM 返回内容为空，无法解析 JSON');
  }

  // 1. 剥离 Markdown 代码块标记（```json ... ``` 或 ``` ... ```）
  let cleaned = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // 2. 定位最外层 JSON 结构：优先对象 { }，其次数组 [ ]，截断前后废话
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  const hasBrace = firstBrace !== -1;
  const hasBracket = firstBracket !== -1;
  let start = -1;
  let end = -1;
  if (hasBrace && (!hasBracket || firstBrace < firstBracket)) {
    start = firstBrace;
    end = cleaned.lastIndexOf('}');
  } else if (hasBracket) {
    start = firstBracket;
    end = cleaned.lastIndexOf(']');
  }

  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.substring(start, end + 1);
  }

  // 3. 解析；失败则抛错暴露真实问题（错就错，不降级为占位/空值）
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(
      `视觉模型未按规范返回合法 JSON 数据，原始内容片段: ${rawText.substring(0, 200)}`,
    );
  }
}