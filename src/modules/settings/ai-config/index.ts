// 📁 路径：src/modules/settings/ai-config/index.ts
// 模块入口：AI 服务配置（§3.7.1）
// 只导出接口和公共服务，不导出 provider 内部实现

export type { ApiProfile, ProviderConfig, AiConfigInput } from './types';
export { PROVIDER_CONFIGS } from './backend/AiConfigService';
export { ApiProfileRepository } from './backend/AiConfigService';
export type { ApiProfileRow } from './backend/AiConfigService';
