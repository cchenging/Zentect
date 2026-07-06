// Module: settings/ai-config - Types 单元测试

import { describe, it, expect } from 'vitest';
import type { ProviderConfig, ApiProfile, AiConfigInput } from '../types';

describe('Settings AI Config Types', () => {
  describe('ProviderConfig', () => {
    it('应包含所有必填字段', () => {
      const config: ProviderConfig = {
        id: 'deepseek',
        name: 'DeepSeek 深度求索',
        keyField: 'deepseekKey',
        modelsField: 'deepseekModels',
        baseURL: 'https://api.deepseek.com/v1',
        link: 'https://platform.deepseek.com/',
        color: '#6366f1',
        hasBaseUrl: false,
      };

      expect(config.id).toBe('deepseek');
      expect(config.name).toBe('DeepSeek 深度求索');
      expect(config.keyField).toBe('deepseekKey');
      expect(config.modelsField).toBe('deepseekModels');
      expect(config.baseURL).toBe('https://api.deepseek.com/v1');
      expect(config.link).toBe('https://platform.deepseek.com/');
      expect(config.color).toBe('#6366f1');
      expect(config.hasBaseUrl).toBe(false);
    });

    it('hasBaseUrl 为 true 时表示支持自定义 Base URL', () => {
      const config: ProviderConfig = {
        id: 'openai',
        name: 'OpenAI 协议中转',
        keyField: 'openaiKey',
        modelsField: 'openaiModels',
        baseURL: '',
        link: 'https://cloud.siliconflow.cn/',
        color: '#22c55e',
        hasBaseUrl: true,
      };

      expect(config.hasBaseUrl).toBe(true);
      expect(config.baseURL).toBe('');
    });
  });

  describe('ApiProfile', () => {
    it('应包含所有必填字段', () => {
      const profile: ApiProfile = {
        id: 'profile-001',
        name: '我的DeepSeek',
        provider: 'deepseek',
        apiKey: 'sk-encrypted',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat', 'deepseek-coder'],
        isActive: true,
      };

      expect(profile.id).toBe('profile-001');
      expect(profile.name).toBe('我的DeepSeek');
      expect(profile.provider).toBe('deepseek');
      expect(profile.apiKey).toBe('sk-encrypted');
      expect(profile.models).toHaveLength(2);
      expect(profile.isActive).toBe(true);
    });

    it('isActive 为 false 表示非活跃配置', () => {
      const profile: ApiProfile = {
        id: 'profile-002',
        name: '备用配置',
        provider: 'qwen',
        apiKey: '',
        baseUrl: '',
        models: [],
        isActive: false,
      };

      expect(profile.isActive).toBe(false);
      expect(profile.models).toHaveLength(0);
    });
  });

  describe('AiConfigInput', () => {
    it('应包含 providers 和 apiProfiles 两个列表', () => {
      const input: AiConfigInput = {
        providers: [
          {
            id: 'deepseek', name: 'DeepSeek',
            keyField: 'deepseekKey', modelsField: 'deepseekModels',
            baseURL: 'https://api.deepseek.com/v1',
            link: 'https://platform.deepseek.com/',
            color: '#6366f1', hasBaseUrl: false,
          },
        ],
        apiProfiles: [
          {
            id: 'p1', name: 'Default', provider: 'deepseek',
            apiKey: 'sk-xxx', baseUrl: '',
            models: ['deepseek-chat'], isActive: true,
          },
        ],
      };

      expect(input.providers).toHaveLength(1);
      expect(input.apiProfiles).toHaveLength(1);
    });

    it('providers 和 apiProfiles 可为空数组', () => {
      const input: AiConfigInput = {
        providers: [],
        apiProfiles: [],
      };

      expect(input.providers).toEqual([]);
      expect(input.apiProfiles).toEqual([]);
    });
  });
});
