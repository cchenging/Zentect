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
  testConnection(): Promise<boolean>;
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
