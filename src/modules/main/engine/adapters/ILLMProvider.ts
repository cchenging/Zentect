// 📁 路径：src/main/engine/adapters/ILLMProvider.ts
import { WebContents } from 'electron';

export interface LLMResponse {
  success: boolean;
  text?: string;
  error?: string;
}

export interface ILLMProvider {
  readonly providerName: string;
  testConnection(): Promise<boolean>;
  chat(messages: any[], model: string, temperature: number): Promise<LLMResponse>;
  
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
