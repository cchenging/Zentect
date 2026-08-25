// 📁 路径：src/main/engine/adapters/ILLMProvider.ts
import type { WebContents } from 'electron';

export interface LLMResponse {
  success: boolean;
  text?: string;
  error?: string;
}

/** chat 调用扩展选项（P0-1：JSON Schema 强制结构化输出） */
export interface ChatOptions {
  /** OpenAI 兼容的 response_format，强制 JSON 输出 */
  response_format?: {
    type: 'json_object' | 'json_schema';
    json_schema?: {
      name: string;
      schema: object;
      strict?: boolean;
    };
  };
  /** 单次最大输出 token */
  max_tokens?: number;
}

export interface ILLMProvider {
  readonly providerName: string;
  /**
   * 测试模型/中转站连通性与鉴权
   * @param model 可选：传入要验证的真实模型名（如 gpt-4o / ep-xxx / qwen-vl-max 等）。
   *              - 传入时：真实发 POST /chat/completions 最小文字推理请求，验证"该模型是否有权限/有余额/有推理能力"（强烈推荐，避免测试用小模型蒙混过关）。
   *              - 不传时：回退为 GET /models（只校验 baseURL 是否可达 + Authorization 是否合法，不涉及具体模型），适用于不知道可用模型名的兜底场景。
   */
  testConnection(model?: string): Promise<boolean>;
  chat(messages: any[], model: string, temperature: number, options?: ChatOptions): Promise<LLMResponse>;
  
  // 💥 新增：强制要求底层实现向前端原生推流，并支持 Agent 工具调用
  streamChatToBrowser(
    webContents: WebContents, 
    messages: any[], 
    model: string, 
    temperature: number,
    chunkChannel: string,
    tools?: any[] 
  ): Promise<{ text: string, toolCall?: any }>;
}
