// Module: settings/general - Service 单元测试

import { describe, it, expect } from 'vitest';
import { DEFAULT_GENERAL_SETTINGS, toGeneralSettings } from '../backend/GeneralSettingsService';
import type { GeneralSettings } from '../types';

describe('GeneralSettingsService', () => {
  describe('DEFAULT_GENERAL_SETTINGS', () => {
    it('应包含所有默认字段', () => {
      expect(DEFAULT_GENERAL_SETTINGS.projectPath).toBe('');
      expect(DEFAULT_GENERAL_SETTINGS.exportPath).toBe('');
      expect(DEFAULT_GENERAL_SETTINGS.jianyingPath).toBe('');
      expect(DEFAULT_GENERAL_SETTINGS.theme).toBe('dark');
      expect(DEFAULT_GENERAL_SETTINGS.language).toBe('zh-CN');
      expect(DEFAULT_GENERAL_SETTINGS.gpuAcceleration).toBe(true);
      expect(DEFAULT_GENERAL_SETTINGS.autoSaveInterval).toBe(30);
      expect(DEFAULT_GENERAL_SETTINGS.pythonPath).toBe('');
      expect(DEFAULT_GENERAL_SETTINGS.mossModelDir).toBe('');
    });

    it('应是一个完整的 GeneralSettings 对象', () => {
      const keys: (keyof GeneralSettings)[] = [
        'projectPath', 'exportPath', 'jianyingPath',
        'theme', 'language', 'gpuAcceleration', 'autoSaveInterval',
        'pythonPath', 'mossModelDir',
      ];
      for (const key of keys) {
        expect(DEFAULT_GENERAL_SETTINGS[key]).toBeDefined();
      }
    });
  });

  describe('toGeneralSettings', () => {
    it('应正确映射所有字段', () => {
      const raw: Record<string, string> = {
        projectPath: 'D:/Projects',
        exportPath: 'D:/Exports',
        jianyingPath: 'C:/Jianying/Drafts',
        theme: 'light',
        language: 'en',
        gpuAcceleration: 'true',
        autoSaveInterval: '60',
        pythonPath: 'C:/Python/python.exe',
        mossModelDir: 'D:/Models/MOSS',
      };

      const result = toGeneralSettings(raw);

      expect(result.projectPath).toBe('D:/Projects');
      expect(result.exportPath).toBe('D:/Exports');
      expect(result.jianyingPath).toBe('C:/Jianying/Drafts');
      expect(result.theme).toBe('light');
      expect(result.language).toBe('en');
      expect(result.gpuAcceleration).toBe(true);
      expect(result.autoSaveInterval).toBe(60);
      expect(result.pythonPath).toBe('C:/Python/python.exe');
      expect(result.mossModelDir).toBe('D:/Models/MOSS');
    });

    it('空对象应返回默认值', () => {
      const result = toGeneralSettings({});

      expect(result.projectPath).toBe('');
      expect(result.exportPath).toBe('');
      expect(result.jianyingPath).toBe('');
      expect(result.theme).toBe('dark');
      expect(result.language).toBe('zh-CN');
      expect(result.gpuAcceleration).toBe(true);
      expect(result.autoSaveInterval).toBe(30);
    });

    it('gpuAcceleration 为 "false" 时应返回 false', () => {
      const result = toGeneralSettings({ gpuAcceleration: 'false' });
      expect(result.gpuAcceleration).toBe(false);
    });

    it('gpuAcceleration 缺失时应返回 true（默认）', () => {
      const result = toGeneralSettings({});
      expect(result.gpuAcceleration).toBe(true);
    });

    it('autoSaveInterval 应正确解析整数', () => {
      expect(toGeneralSettings({ autoSaveInterval: '120' }).autoSaveInterval).toBe(120);
      expect(toGeneralSettings({ autoSaveInterval: '45' }).autoSaveInterval).toBe(45);
    });

    it('autoSaveInterval 为 "0" 时会回退到默认值 30（|| 语义）', () => {
      // parseInt('0', 10) → 0，0 || 30 → 30
      expect(toGeneralSettings({ autoSaveInterval: '0' }).autoSaveInterval).toBe(30);
    });

    it('autoSaveInterval 非数字时应回退到默认值 30', () => {
      expect(toGeneralSettings({ autoSaveInterval: 'abc' }).autoSaveInterval).toBe(30);
    });

    it('theme 为空字符串时应回退到 dark（|| 语义）', () => {
      const result = toGeneralSettings({ theme: '' });
      expect(result.theme).toBe('dark');
    });

    it('language 为空字符串时应回退到 zh-CN（|| 语义）', () => {
      const result = toGeneralSettings({ language: '' });
      expect(result.language).toBe('zh-CN');
    });

    it('theme 和 language 的 truthy 非标准值会透传（|| 不做枚举校验）', () => {
      const result = toGeneralSettings({ theme: 'unknown', language: 'fr' });
      expect(result.theme).toBe('unknown');
      expect(result.language).toBe('fr');
    });

    it('projectPath 应支持 projectStoragePath 别名', () => {
      expect(toGeneralSettings({ projectStoragePath: 'E:/Alt' }).projectPath).toBe('E:/Alt');
      expect(toGeneralSettings({ projectPath: 'E:/Primary', projectStoragePath: 'E:/Alt' }).projectPath).toBe('E:/Primary');
    });

    it('exportPath 应支持 videoExportPath 别名', () => {
      expect(toGeneralSettings({ videoExportPath: 'F:/Videos' }).exportPath).toBe('F:/Videos');
    });

    it('jianyingPath 应支持 jianyingDraftPath 别名', () => {
      expect(toGeneralSettings({ jianyingDraftPath: 'G:/Drafts' }).jianyingPath).toBe('G:/Drafts');
    });

    it('gpuAcceleration 应支持其他真值字符串', () => {
      expect(toGeneralSettings({ gpuAcceleration: 'true' }).gpuAcceleration).toBe(true);
      expect(toGeneralSettings({ gpuAcceleration: '1' }).gpuAcceleration).toBe(true);
    });
  });
});
