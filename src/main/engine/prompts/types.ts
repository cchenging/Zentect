// 📁 路径：src/main/engine/prompts/types.ts

/**
 * AI 意图枚举：明确 AI 能干什么活
 */
export enum PromptIntent {
  AGENT_CHAT = 'agent_chat',         // 侧边栏与导演智能体的自由对话
  SCRIPT_REWRITE = 'script_rewrite', // 全局剧本重写
  VISION_ANALYZE = 'vision_analyze'  // 单帧画面视觉打标
}

/**
 * Prompt 上下文接口：定义需要什么参数
 */
export interface PromptContext {
  timelineData?: string;   // 时间轴 JSON 状态
  targetLanguage?: string; // 目标语种 (如 zh-CN)
  rolesInfo?: string;      // 角色列表
  [key: string]: any;      // 扩展预留
}
