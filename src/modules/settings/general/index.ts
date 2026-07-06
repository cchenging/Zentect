// 📁 路径：src/modules/settings/general/index.ts
// 模块入口：通用设置（§3.7.4）

export type { GeneralSettings, HealthCheckItem, HealthCheckResult, HealthStatus } from './types';
export { DEFAULT_GENERAL_SETTINGS, toGeneralSettings, SettingsService, SettingsRepository } from './backend/GeneralSettingsService';
