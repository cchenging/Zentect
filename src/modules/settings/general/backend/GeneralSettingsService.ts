// 📁 路径：src/modules/settings/general/backend/GeneralSettingsService.ts
// 通用设置服务：封装通用设置 CRUD + 健康检查（§3.7.4）
// 委托层：委托 SettingsService + SettingsRepository 现有实现

import type { GeneralSettings, HealthCheckItem, HealthCheckResult } from '../types';

// 委托到原有实现
export { SettingsService } from '../../../../main/services/SettingsService';
export { SettingsRepository } from '../../../../main/database/repositories/SettingsRepository';

/** 默认通用设置 */
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  projectPath: '',
  exportPath: '',
  jianyingPath: '',
  mode: 'dark',
  language: 'zh-CN',
  gpuAcceleration: true,
  autoSaveInterval: 30,
  pythonPath: '',
  mossModelDir: '',
};

/**
 * 将 SettingsService.getAll() 返回的 K-V 字符串映射转为类型化 GeneralSettings
 */
export function toGeneralSettings(raw: Record<string, string>): GeneralSettings {
  return {
    projectPath: raw.projectPath || raw.projectStoragePath || '',
    exportPath: raw.exportPath || raw.videoExportPath || '',
    jianyingPath: raw.jianyingPath || raw.jianyingDraftPath || '',
    mode: (raw.mode as 'dark' | 'light' | 'system') || 'dark',
    language: (raw.language as 'zh-CN' | 'en') || 'zh-CN',
    gpuAcceleration: raw.gpuAcceleration !== 'false',
    autoSaveInterval: parseInt(raw.autoSaveInterval, 10) || 30,
    pythonPath: raw.pythonPath || '',
    mossModelDir: raw.mossModelDir || '',
  };
}

export { SettingsService as default } from '../../../../main/services/SettingsService';
