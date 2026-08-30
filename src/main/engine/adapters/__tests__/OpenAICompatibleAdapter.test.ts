// 📁 路径: src/main/engine/adapters/__tests__/OpenAICompatibleAdapter.test.ts
// OpenAICompatibleAdapter 单元测试
// 重点验证：
//   ① DeepSeek V4 思考模式默认开启 → 请求体自动注入 thinking:{type:'disabled'} 关闭思考
//   ② content 为空但含 reasoning_content → 明确报"思考截断"而非被误判为后端空返回

import { describe, it, expect, vi, afterEach } from 'vitest';

// === Mock 依赖链（避免日志模块在测试环境产生副作用） ===

/** Mock AppLogger */
vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/** Mock LogConstants */
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER', AI_ENGINE: 'AI_ENGINE' },
}));

import { OpenAICompatibleAdapter } from '../OpenAICompatibleAdapter';

/** 构造一个 HTTP 200 的 JSON 响应（模拟服务端返回） */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 捕获最后一次 fetch 的请求体，便于断言 payload 内容 */
function captureFetchBody(): { getBody: () => string } {
  let capturedBody = '';
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    capturedBody = init?.body ?? '';
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  }));
  return { getBody: () => capturedBody };
}

describe('OpenAICompatibleAdapter - DeepSeek 思考模式适配', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deepseek 模型：请求体自动注入 thinking:{type:disabled} 关闭思考', async () => {
    const { getBody } = captureFetchBody();
    const adapter = new OpenAICompatibleAdapter('https://api.deepseek.com/v1', 'sk-test');
    const res = await adapter.chat([{ role: 'user', content: 'hi' }], 'deepseek-v4-flash', 0.8);
    expect(res.success).toBe(true);
    const payload = JSON.parse(getBody());
    expect(payload.model).toBe('deepseek-v4-flash');
    expect(payload.thinking).toEqual({ type: 'disabled' });
  });

  it('非 deepseek 模型：不注入 thinking 字段', async () => {
    const { getBody } = captureFetchBody();
    const adapter = new OpenAICompatibleAdapter('https://api.openai.com/v1', 'sk-test');
    const res = await adapter.chat([{ role: 'user', content: 'hi' }], 'gpt-4o-mini', 0.8);
    expect(res.success).toBe(true);
    const payload = JSON.parse(getBody());
    expect(payload.thinking).toBeUndefined();
  });

  it('content 为空但含 reasoning_content：明确报"思考截断"而非误判为空返回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { content: null, reasoning_content: '这是很长的思考过程…' } }],
    })));
    const adapter = new OpenAICompatibleAdapter('https://api.deepseek.com/v1', 'sk-test');
    const res = await adapter.chat([{ role: 'user', content: 'hi' }], 'deepseek-v4-flash', 0.8);
    expect(res.success).toBe(false);
    expect(res.error).toContain('思考');
    expect(res.error).toContain('max_tokens');
  });

  it('content 正常返回：success=true 且 text 透传', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { content: '{"ok":1}' } }],
    })));
    const adapter = new OpenAICompatibleAdapter('https://api.deepseek.com/v1', 'sk-test');
    const res = await adapter.chat([{ role: 'user', content: 'hi' }], 'deepseek-v4-flash', 0.8);
    expect(res.success).toBe(true);
    expect(res.text).toBe('{"ok":1}');
  });
});
