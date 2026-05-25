// 📁 路径：src/main/engine/adapters/OpenAICompatibleAdapter.ts
import { ILLMProvider, LLMResponse } from './ILLMProvider';
import { WebContents } from 'electron';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';

export class OpenAICompatibleAdapter implements ILLMProvider {
  public readonly providerName: string = 'openai_compatible';
  protected baseURL: string;
  protected apiKey: string;

  constructor(baseURL: string, apiKey: string) {
    this.baseURL = baseURL;
    this.apiKey = apiKey;
  }

  public async testConnection(): Promise<boolean> {
    const endpoint = this.baseURL.replace(/\/$/, '') + '/chat/completions';
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'test' }], max_tokens: 5 })
      });
      if (response.ok || response.status === 404 || response.status === 400) return true;
      throw new Error(`HTTP ${response.status}`);
    } catch (error: any) { throw error; }
  }

  async chat(messages: any[], model: string, temperature: number): Promise<LLMResponse> {
    const endpoint = `${this.baseURL.replace(/\/$/, '')}/chat/completions`;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return { success: true, text: data.choices[0].message.content };
    } catch (error: any) { return { success: false, error: error.message }; }
  }

  // 💥 真正干活的地方：拦截流、发给前端、解析动作
  async streamChatToBrowser(webContents: WebContents, messages: any[], model: string, temperature: number, chunkChannel: string, tools?: any[]): Promise<{ text: string, toolCall?: any }> {
    const endpoint = `${this.baseURL.replace(/\/$/, '')}/chat/completions`;
    const payload: any = { model, messages, temperature, stream: true };
    
    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    let response;
    try {
      // 💥 给 fetch 加上错误拦截
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (networkError: any) {
      // 拦截 Node.js 底层 10秒超时与连接拒绝
      if (networkError.message.includes('fetch failed')) {
         throw new Error(`【物理断网拦截】请求 [${this.baseURL}] 失败。可能原因：\n1. Node.js 后端默认不走系统 VPN，请尝试更换国内中转站或配置底层代理。\n2. 若使用本地代理(如 127.0.0.1)，请检查该端口是否真正开启。`);
      }
      throw networkError;
    }

    if (!response.ok) throw new Error(`模型响应异常：HTTP ${response.status}`);
    
    const reader = response.body?.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = ''; let currentToolCall: any = null;
    
    // 💥 修复核心：必须加上 buffer，绝不允许把 TCP 断包的半截 JSON 直接去 Parse！
    let buffer = ''; 

    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 将最后一行（可能被网络切断的半截）重新塞回 buffer，等下一个包来了再拼上
      buffer = lines.pop() || ''; 

      for (const line of lines) {
        if (line.trim() === '' || line.trim() === 'data: [DONE]') continue;
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6)); // 💥 解构，方便异常捕获
            const delta = parsed.choices[0]?.delta;
            if (delta?.content) { 
              fullText += delta.content; 
              webContents.send(chunkChannel, delta.content); 
            }
            if (delta?.tool_calls) {
              const tc = delta.tool_calls[0];
              if (tc.function?.name) currentToolCall = { name: tc.function.name, arguments: '' };
              if (tc.function?.arguments && currentToolCall) currentToolCall.arguments += tc.function.arguments;
            }
          } catch (e) {
            // 💥 修复：坚决不静默失败！打印截断数据，防止死锁
            AppLogger.error(LOG_TAGS.AI_ENGINE, `[SSE 解析异常] 大模型返回脏数据`, { 
              lineFragment: line.substring(0, 80) + '...', 
              error: String(e) 
            });
          }
        }
      }
    }

    let finalAction = null;
    if (currentToolCall) {
      try { finalAction = { type: currentToolCall.name.toUpperCase(), ...JSON.parse(currentToolCall.arguments) }; } catch (e) {
        AppLogger.debug(LOG_TAGS.AI_ENGINE, `工具调用参数解析失败: ${currentToolCall.name}`, e)
      }
    }
    return { text: fullText, toolCall: finalAction };
  }
}
