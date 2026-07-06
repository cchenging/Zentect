// 📁 路径：src/main/engine/prompts/constraints.ts

/**
 * 强制约束字典 (Constraints)
 * 用于防止大模型"越狱"、格式错乱或合并长句
 */
export const CONSTRAINTS = {
  JSON_ONLY: `【致命约束】：请只输出合法的 JSON 格式数据，不要包含任何 Markdown 标记（如 \`\`\`json ）、不要包含任何解释性文本、前言或后语。`,
  NO_MERGE_SENTENCES: `【高颗粒度警告】：绝不允许把多句话合并成一个长句子！你必须像真正的剪辑师一样，主动将台词按自然的"断句"、"标点符号"或"呼吸口"进行物理拆分。每一句短句必须是一个独立的 JSON 对象！`,
  PRESERVE_ID: `【溯源协议】：必须严格保留并返回输入的 sourceShotId，绝不允许篡改或丢失，否则系统将无法对齐画面。`
};
