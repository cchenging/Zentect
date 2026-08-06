// Module: pipeline/step2-vision - VlmAdapter 单元测试
// 验证通用 VLM 适配器的统一调用契约、response_format 三级降级、鲁棒 JSON 提取

import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mock 依赖链 ===

/** Mock AppLogger */
vi.mock('../../../../main/core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/** Mock LogConstants（VlmAdapter 通过 @modules 别名导入） */
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', MEDIA_ENGINE: 'MEDIA_ENGINE' },
}));

/** Mock LLMFactory — 返回带 spy 的 adapter，用于断言调用参数 */
const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock('../../../../main/engine/adapters/LLMFactory', () => ({
  LLMFactory: {
    createAdapter: vi.fn(() => ({
      adapter: { chat: mockChat },
      modelName: 'qwen-vl-test',
    })),
  },
}));

import { VlmAdapter } from '../backend/VlmAdapter';

describe('VlmAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('modelName 应返回 LLMFactory 解析出的模型名', () => {
    const adapter = new VlmAdapter();
    expect(adapter.modelName).toBe('qwen-vl-test');
  });

  it('传入 modelName 时应覆盖 LLMFactory 解析结果', () => {
    const adapter = new VlmAdapter('my-custom-vlm');
    expect(adapter.modelName).toBe('my-custom-vlm');
  });

  it('analyzeJson 应返回解析后的 JSON 对象', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: '{"frames":[{"action":"走"}]}',
    });
    const adapter = new VlmAdapter();
    const result = await adapter.analyzeJson<any>([{ role: 'user', content: 'x' }], 0.2, {});
    expect(result).toEqual({ frames: [{ action: '走' }] });
  });

  it('应剥离 Markdown 代码块包裹的 JSON 响应', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: '```json\n{"frames":[{"action":"跑"}]}\n```',
    });
    const adapter = new VlmAdapter();
    const result = await adapter.analyzeJson<any>([], 0.2, {});
    expect(result).toEqual({ frames: [{ action: '跑' }] });
  });

  it('JSON 解析失败时应抛错（错就错，不静默降级）', async () => {
    mockChat.mockResolvedValue({ success: true, text: '这不是合法 JSON' });
    const adapter = new VlmAdapter();
    await expect(adapter.analyzeJson<any>([], 0.2, {})).rejects.toThrow('未按规范返回合法 JSON');
  });

  it('chat 返回 success=false 时应抛错暴露失败原因', async () => {
    mockChat.mockResolvedValue({ success: false, error: '视觉模型超时' });
    const adapter = new VlmAdapter();
    await expect(adapter.analyzeJson<any>([], 0.2, {})).rejects.toThrow('视觉模型超时');
  });

  it('response_format 不兼容时应降级重试（json_schema → json_object）', async () => {
    // 第一次调用（Level 1 带 json_schema）抛格式错误，第二次（Level 2）成功
    mockChat
      .mockRejectedValueOnce(new Error('Unknown parameter: response_format'))
      .mockResolvedValueOnce({ success: true, text: '{"frames":[{"action":"笑"}]}' });

    const adapter = new VlmAdapter();
    const result = await adapter.analyzeJson<any>([], 0.2, { type: 'json_object', json_schema: {} });

    // 应调用 chat 两次
    expect(mockChat).toHaveBeenCalledTimes(2);
    // 第二次调用应使用 json_object 降级格式
    const secondOpts = mockChat.mock.calls[1][3];
    expect(secondOpts.response_format.type).toBe('json_object');
    expect(result).toEqual({ frames: [{ action: '笑' }] });
  });

  it('非格式错误应直接抛出，不做降级', async () => {
    mockChat.mockRejectedValueOnce(new Error('网络连接失败'));
    const adapter = new VlmAdapter();
    await expect(adapter.analyzeJson<any>([], 0.2, {})).rejects.toThrow('网络连接失败');
    // 只调用一次，不重试
    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});