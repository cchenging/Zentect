// Module: settings/ai-config - Service 单元测试

import { describe, it, expect } from 'vitest';
import { PROVIDER_CONFIGS } from '../backend/AiConfigService';
import type { ProviderConfig } from '../types';

describe('AiConfigService', () => {
  describe('PROVIDER_CONFIGS', () => {
    it('应包含 5 个预设供应商', () => {
      expect(PROVIDER_CONFIGS).toHaveLength(5);
    });

    it('每个供应商应有唯一 ID', () => {
      const ids = PROVIDER_CONFIGS.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('每个供应商应包含所有必填字段', () => {
      const requiredFields: (keyof ProviderConfig)[] = [
        'id', 'name', 'keyField', 'modelsField',
        'baseURL', 'link', 'color', 'hasBaseUrl',
      ];

      for (const provider of PROVIDER_CONFIGS) {
        for (const field of requiredFields) {
          expect(provider[field], `${provider.id} 缺少字段 ${field}`).toBeDefined();
        }
      }
    });

    it('非 hasBaseUrl 的供应商应有有效的 baseURL', () => {
      const withoutBaseUrl = PROVIDER_CONFIGS.filter((p) => !p.hasBaseUrl);
      for (const provider of withoutBaseUrl) {
        expect(provider.baseURL.length).toBeGreaterThan(0);
        expect(provider.baseURL).toMatch(/^https?:\/\//);
      }
    });

    it('openai 供应商 hasBaseUrl 应为 true 且 baseURL 为空', () => {
      const openai = PROVIDER_CONFIGS.find((p) => p.id === 'openai');
      expect(openai).toBeDefined();
      expect(openai!.hasBaseUrl).toBe(true);
      expect(openai!.baseURL).toBe('');
    });

    it('所有供应商应有有效的 keyField 和 modelsField', () => {
      for (const provider of PROVIDER_CONFIGS) {
        expect(provider.keyField.length).toBeGreaterThan(0);
        expect(provider.modelsField.length).toBeGreaterThan(0);
      }
    });

    it('所有供应商应有有效的 color（HEX 格式）', () => {
      for (const provider of PROVIDER_CONFIGS) {
        expect(provider.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it('所有供应商应有有效的 link', () => {
      for (const provider of PROVIDER_CONFIGS) {
        expect(provider.link).toMatch(/^https?:\/\//);
      }
    });

    it('应包含 deepseek、qwen、tencent、doubao、openai', () => {
      const expectedIds = ['deepseek', 'qwen', 'tencent', 'doubao', 'openai'];
      const actualIds = PROVIDER_CONFIGS.map((p) => p.id).sort();
      expect(actualIds.sort()).toEqual(expectedIds.sort());
    });
  });
});
