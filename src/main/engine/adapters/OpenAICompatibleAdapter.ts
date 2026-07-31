// 📁 路径：src/main/engine/adapters/OpenAICompatibleAdapter.ts
import type { ILLMProvider, LLMResponse, ChatOptions } from './ILLMProvider';
import type { WebContents } from 'electron';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { StreamBufferGuard } from '../../core/StreamBufferGuard';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';

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
      // 🔧 修复：只有 HTTP 200 才算成功，不再把 404/400 当成功（会导致配置测试通过但实际调用失败）
      if (response.ok) return true;
      let detail = '';
      try { detail = (await response.text()).substring(0, 200); } catch {}
      throw new Error(`HTTP ${response.status}${detail ? '：' + detail : ''}`);
    } catch (error: any) { throw error; }
  }

  async chat(messages: any[], model: string, temperature: number, options?: ChatOptions): Promise<LLMResponse> {
    const endpoint = `${this.baseURL.replace(/\/$/, '')}/chat/completions`;
    try {
      // P0-1：组装请求体，按需注入 response_format / max_tokens（兼容 OpenAI / Qwen JSON Mode）
      const payload: any = { model, messages, temperature };
      if (options?.response_format) {
        payload.response_format = options.response_format;
      }
      if (options?.max_tokens) {
        payload.max_tokens = options.max_tokens;
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      // 🔧 修复：HTTP 错误时读取 body 详情，不再只抛 "HTTP 404"
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).substring(0, 300); } catch {}
        if (response.status === 401) throw new Error(`API Key 鉴权失败（401）${detail ? '：' + detail : ''}`);
        if (response.status === 404) throw new Error(`接口地址不存在（404），请检查 baseURL：${this.baseURL}${detail ? ' 详情：' + detail : ''}`);
        if (response.status === 429) throw new Error(`请求过于频繁被限流（429），请降低并发或稍后重试`);
        throw new Error(`HTTP ${response.status}${detail ? '：' + detail : ''}`);
      }
      // 🔧 修复：状态码 200 但返回 HTML 时给出明确提示（而非 "Unexpected token '<'"）
      const contentType = response.headers.get('content-type') || '';
      const rawText = await response.text();
      if (!contentType.includes('application/json') || rawText.trimStart().startsWith('<')) {
        throw new Error(`接口返回了 HTML 而非 JSON（baseURL=${this.baseURL}），请检查接口地址是否正确。响应片段：${rawText.substring(0, 200)}`);
      }
      const data = JSON.parse(rawText);
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

    // 💥 Layer 4 进阶：流式断点保护，网络熔断时验证完整性
    const bufferGuard = new StreamBufferGuard();

    // 💥 断层4修复：从 chunkChannel 中提取 nodeId 用于安全推流
    // chunkChannel 格式通常为 'agent:streamChunk' 或自定义频道
    let streamNodeId = 'unknown';
    if (chunkChannel.includes(':')) {
      streamNodeId = chunkChannel.split(':').pop() || 'unknown';
    }

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
              // 💥 追加到流式保护缓冲区
              bufferGuard.append(delta.content);

              // 💥 断层4修复：实时向前端推送 StreamBufferGuard 清洗后的安全数据
              const safeText = bufferGuard.rollbackOrResolve();
              if (safeText !== '[]') {
                try {
                  if (!webContents.isDestroyed()) {
                    webContents.send(IPC_CHANNELS.EVENT_STREAM_SAFE_CHUNK, {
                      nodeId: streamNodeId,
                      safeText: safeText,
                    });
                  }
                } catch { /* 推送失败静默 */ }
              }
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

    // 💥 Layer 4 进阶：流结束后验证完整性，破损则回滚为空契约
    const validatedText = bufferGuard.rollbackOrResolve();
    if (validatedText === '[]') {
      // 流式数据被截断，使用空契约替代残缺数据
      fullText = '[]';
    }

    return { text: fullText, toolCall: finalAction };
  }
}
