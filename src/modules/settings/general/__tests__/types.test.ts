// Module: settings/general - Types 单元测试

import { describe, it, expect } from 'vitest';
import type { GeneralSettings, HealthCheckItem, HealthCheckResult } from '../types';
import type { HealthStatus } from '../types';

describe('Settings General Types', () => {
  describe('GeneralSettings', () => {
    it('应包含所有必填字段', () => {
      const settings: GeneralSettings = {
        projectPath: 'D:/Projects',
        exportPath: 'D:/Exports',
        jianyingPath: 'C:/Jianying/Drafts',
        theme: 'dark',
        language: 'zh-CN',
        gpuAcceleration: true,
        autoSaveInterval: 30,
      };

      expect(settings.projectPath).toBe('D:/Projects');
      expect(settings.exportPath).toBe('D:/Exports');
      expect(settings.jianyingPath).toBe('C:/Jianying/Drafts');
      expect(settings.theme).toBe('dark');
      expect(settings.language).toBe('zh-CN');
      expect(settings.gpuAcceleration).toBe(true);
      expect(settings.autoSaveInterval).toBe(30);
    });

    it('theme 仅支持 dark / light / system', () => {
      const themes: Array<'dark' | 'light' | 'system'> = ['dark', 'light', 'system'];

      for (const theme of themes) {
        const settings: GeneralSettings = {
          projectPath: '', exportPath: '', jianyingPath: '',
          theme,
          language: 'zh-CN',
          gpuAcceleration: false,
          autoSaveInterval: 0,
        };
        expect(settings.theme).toBe(theme);
      }
    });

    it('language 仅支持 zh-CN / en', () => {
      const languages: Array<'zh-CN' | 'en'> = ['zh-CN', 'en'];

      for (const language of languages) {
        const settings: GeneralSettings = {
          projectPath: '', exportPath: '', jianyingPath: '',
          theme: 'system',
          language,
          gpuAcceleration: false,
          autoSaveInterval: 0,
        };
        expect(settings.language).toBe(language);
      }
    });

    it('pythonPath 和 mossModelDir 为可选字段', () => {
      const withOptional: GeneralSettings = {
        projectPath: '', exportPath: '', jianyingPath: '',
        theme: 'dark', language: 'zh-CN',
        gpuAcceleration: true, autoSaveInterval: 30,
        pythonPath: 'C:/Python/python.exe',
        mossModelDir: 'D:/Models/MOSS-TTS',
      };
      expect(withOptional.pythonPath).toBe('C:/Python/python.exe');
      expect(withOptional.mossModelDir).toBe('D:/Models/MOSS-TTS');

      const withoutOptional: GeneralSettings = {
        projectPath: '', exportPath: '', jianyingPath: '',
        theme: 'dark', language: 'zh-CN',
        gpuAcceleration: true, autoSaveInterval: 30,
      };
      expect(withoutOptional.pythonPath).toBeUndefined();
      expect(withoutOptional.mossModelDir).toBeUndefined();
    });

    it('autoSaveInterval 为 0 表示禁用', () => {
      const settings: GeneralSettings = {
        projectPath: '', exportPath: '', jianyingPath: '',
        theme: 'dark', language: 'zh-CN',
        gpuAcceleration: true, autoSaveInterval: 0,
      };

      expect(settings.autoSaveInterval).toBe(0);
    });
  });

  describe('HealthCheckItem', () => {
    it('应包含 key、label、status、detail', () => {
      const item: HealthCheckItem = {
        key: 'python',
        label: 'Python 环境',
        status: 'ok',
        detail: 'Python 3.11.5',
      };

      expect(item.key).toBe('python');
      expect(item.label).toBe('Python 环境');
      expect(item.status).toBe('ok');
      expect(item.detail).toBe('Python 3.11.5');
    });

    it('status 仅支持 ok / warn / error', () => {
      const statuses: HealthStatus[] = ['ok', 'warn', 'error'];

      for (const status of statuses) {
        const item: HealthCheckItem = {
          key: 'test', label: 'Test', status, detail: '',
        };
        expect(item.status).toBe(status);
      }
    });
  });

  describe('HealthCheckResult', () => {
    it('应包含 items 和 hardware', () => {
      const result: HealthCheckResult = {
        items: [
          { key: 'python', label: 'Python', status: 'ok', detail: '3.11' },
        ],
        hardware: {
          cpu: { percent: 25, model: 'Intel i7', cores: 8 },
          memory: { percent: 60, freeMB: 4096, totalMB: 16384 },
          disk: { freeGB: 100, totalGB: 500 },
        },
      };

      expect(result.items).toHaveLength(1);
      expect(result.hardware.cpu).toBeDefined();
      expect(result.hardware.memory).toBeDefined();
      expect(result.hardware.disk).toBeDefined();
    });

    it('items 可为空数组', () => {
      const result: HealthCheckResult = {
        items: [],
        hardware: {},
      };

      expect(result.items).toEqual([]);
    });

    it('hardware 字段可选', () => {
      const result: HealthCheckResult = {
        items: [],
        hardware: {},
      };

      expect(result.hardware.cpu).toBeUndefined();
      expect(result.hardware.memory).toBeUndefined();
      expect(result.hardware.disk).toBeUndefined();
    });
  });
});
