// 📁 路径：src/main/engine/adapters/__tests__/LLMFactory.preflight.test.ts
// 🔧 ADR-004 G3 回归锁定：AI 服务客户端构造点出站前 preflight
//
// 事故形态（2026-09-25）：凭据解不开被静默置空 ⇒ 空 Key 进批次循环 ⇒ 401 ⇒ 连打 665 帧 ⇒ 429 封禁。
// 本测试锁死三条口径：
//   ① 绑定 profile 凭据 decrypt_failed ⇒ 立即抛 AIAuthError，**不静默换通道**；
//   ② settings 回退路径的空 Key（原 deepseek/qwen/tencent/proxy 无校验）⇒ 抛 AIAuthError；
//   ③ createFromConfig 凭据非 ok ⇒ 抛，绝不构造 adapter。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIAuthError } from '../../../../shared/utils/credentialFormat';

const h = vi.hoisted(() => ({
  settingsStore: {} as Record<string, unknown>,
  getAll: vi.fn(),
  getActive: vi.fn(),
  getByTaskType: vi.fn(),
}));

vi.mock('../../../database/repositories/SettingsRepository', () => ({
  SettingsRepository: class {
    get(key: string, def: unknown) {
      return key in h.settingsStore ? h.settingsStore[key] : def;
    }
  },
}));

vi.mock('../../../database/repositories/ApiProfileRepository', () => ({
  ApiProfileRepository: {
    getAll: (...args: unknown[]) => h.getAll(...args),
    getActive: (...args: unknown[]) => h.getActive(...args),
  },
}));

vi.mock('../../../database/repositories/ProfileBindingRepository', () => ({
  ProfileBindingRepository: {
    getByTaskType: (...args: unknown[]) => h.getByTaskType(...args),
  },
}));

import { LLMFactory } from '../LLMFactory';

const brokenProfile = {
  id: 'p1', provider: 'deepseek', apiKey: '', apiKeyStatus: 'decrypt_failed' as const,
  baseUrl: '', models: [], enabled: 1, name: 'p1', isActive: false, sortOrder: 0,
  createdAt: '', updatedAt: '',
};

const okProfile = {
  ...brokenProfile, apiKey: 'sk-real-key', apiKeyStatus: 'ok' as const,
};

describe('LLMFactory G3 出站前 preflight', () => {
  beforeEach(() => {
    for (const k of Object.keys(h.settingsStore)) delete h.settingsStore[k];
    h.getAll.mockReset();
    h.getActive.mockReset();
    h.getByTaskType.mockReset();
  });

  it('绑定 profile 凭据已失效 ⇒ 抛 AIAuthError（不静默落到换通道）', () => {
    h.getByTaskType.mockReturnValue({ profileId: 'p1', modelName: 'deepseek-chat' });
    h.getAll.mockReturnValue([brokenProfile]);

    try {
      LLMFactory.getEffectiveConfig('script');
      expect.unreachable('应当抛 AIAuthError');
    } catch (err) {
      const e = err as AIAuthError;
      expect(e).toBeInstanceOf(AIAuthError);
      expect(e.status).toBe('decrypt_failed');
      expect(e.provider).toBe('deepseek');
      // 关键：没有走 ② settings 回退（那会读到空 Key 继续外发）
      expect(h.getActive).not.toHaveBeenCalled();
    }
  });

  it('无绑定 + 激活 profile 已失效 ⇒ settings 路径也拦截', () => {
    h.getByTaskType.mockReturnValue(null);
    h.settingsStore.taskScriptModel = 'deepseek-chat';
    h.getActive.mockReturnValue(brokenProfile);

    expect(() => LLMFactory.getEffectiveConfig('script')).toThrow(AIAuthError);
  });

  it('无绑定 + 无激活 profile + 设置里 Key 为空 ⇒ 抛 AIAuthError（原 qwen 分支无校验）', () => {
    h.getByTaskType.mockReturnValue(null);
    h.settingsStore.taskScriptModel = 'qwen-plus';
    h.getActive.mockReturnValue(null);
    h.settingsStore.qwenKey = '';

    try {
      LLMFactory.getEffectiveConfig('script');
      expect.unreachable('应当抛 AIAuthError');
    } catch (err) {
      const e = err as AIAuthError;
      expect(e).toBeInstanceOf(AIAuthError);
      expect(e.status).toBe('missing');
      expect(e.provider).toBe('qwen');
    }
  });

  it('凭据正常 ⇒ 返回配置并带上 apiKeyStatus=ok', () => {
    h.getByTaskType.mockReturnValue({ profileId: 'p1', modelName: 'deepseek-chat' });
    h.getAll.mockReturnValue([okProfile]);

    const config = LLMFactory.getEffectiveConfig('script');
    expect(config.provider).toBe('deepseek');
    expect(config.apiKey).toBe('sk-real-key');
    expect(config.apiKeyStatus).toBe('ok');
    expect(config.model).toBe('deepseek-chat');
  });

  it('createFromConfig 凭据非 ok ⇒ 抛，且不构造 adapter', () => {
    expect(() => LLMFactory.createFromConfig({
      provider: 'deepseek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1',
      apiKey: '', apiKeyStatus: 'decrypt_failed', temperature: 0.8,
    })).toThrow(AIAuthError);
  });

  it('createFromConfig 凭据 ok ⇒ 正常构造 adapter', () => {
    const adapter = LLMFactory.createFromConfig({
      provider: 'deepseek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-real-key', apiKeyStatus: 'ok', temperature: 0.8,
    });
    expect(adapter).toBeTruthy();
  });
});