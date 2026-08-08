// Module: settings/ai-config - Service 单元测试

import { describe, it, expect } from 'vitest';
import { PROVIDER_CONFIGS } from '../backend/AiConfigService';

describe('AiConfigService', () => {
  describe('PROVIDER_CONFIGS', () => {
    // PROVIDER_CONFIGS 为 Record<id, ProviderConfig>，转数组便于断言
    const providers = Object.values(PROVIDER_CONFIGS) as Array<{
      id: string; name: string; fullName: string;
      baseUrl: string; models: string[]; keyUrl: string;
    }>;

    it('应包含 5 个预设供应商', () => {
      expect(providers).toHaveLength(5);
    });

    it('每个供应商应有唯一 ID', () => {
      const ids = providers.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('每个供应商应包含所有必填字段', () => {
      const requiredFields: Array<'id' | 'name' | 'fullName' | 'baseUrl' | 'models' | 'keyUrl'> = [
        'id', 'name', 'fullName', 'baseUrl', 'models', 'keyUrl',
      ];

      for (const provider of providers) {
        for (const field of requiredFields) {
          expect(provider[field], `${provider.id} 缺少字段 ${field}`).toBeDefined();
        }
      }
    });

    it('每个供应商应至少提供一个模型', () => {
      for (const provider of providers) {
        expect(provider.models.length).toBeGreaterThan(0);
      }
    });

    it('非 custom 供应商应有有效的 baseUrl', () => {
      const nonCustom = providers.filter((p) => p.id !== 'custom');
      for (const provider of nonCustom) {
        expect(provider.baseUrl.length).toBeGreaterThan(0);
        expect(provider.baseUrl).toMatch(/^https?:\/\//);
      }
    });

    it('custom（OpenAI 兼容）供应商应允许空 baseUrl', () => {
      const custom = providers.find((p) => p.id === 'custom');
      expect(custom).toBeDefined();
      expect(custom!.baseUrl).toBe('');
    });

    it('应包含 doubao、deepseek、qwen、hunyuan、custom', () => {
      const expectedIds = ['doubao', 'deepseek', 'qwen', 'hunyuan', 'custom'];
      const actualIds = providers.map((p) => p.id).sort();
      expect(actualIds.sort()).toEqual(expectedIds.sort());
    });
  });
});
