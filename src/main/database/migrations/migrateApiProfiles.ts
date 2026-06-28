/**
 * 旧 API 配置自动迁移到 api_profiles 表
 * 在应用启动时调用，幂等执行（已有数据则跳过）
 */
import { ApiProfileRepository } from '../repositories/ApiProfileRepository';
import { SettingsRepository } from '../repositories/SettingsRepository';
import { decryptData } from '../../utils/crypto';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';

const PROVIDER_MIGRATION_MAP = [
  { provider: 'deepseek', keyField: 'deepseekKey', modelsField: 'deepseekModels', defaultBaseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { provider: 'qwen', keyField: 'qwenKey', modelsField: 'qwenModels', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-turbo' },
  { provider: 'tencent', keyField: 'tencentKey', modelsField: 'tencentModels', defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', defaultModel: 'hunyuan-turbo' },
  { provider: 'doubao', keyField: 'doubaoKey', modelsField: 'doubaoModels', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-pro-32k' },
  { provider: 'proxy', keyField: 'openaiKey', modelsField: 'openaiModels', defaultBaseUrl: '', defaultModel: 'gpt-4o-mini', baseUrlField: 'openaiBaseUrl' },
];

export function migrateOldApiConfig(): void {
  try {
    const existing = ApiProfileRepository.getAll();
    if (existing.length > 0) {
      AppLogger.info(LOG_TAGS.SYSTEM, 'api_profiles 已有数据，跳过迁移');
      return;
    }

    const settings = new SettingsRepository();
    let migrated = 0;

    for (const mapping of PROVIDER_MIGRATION_MAP) {
      const apiKey = settings.get<string>(mapping.keyField, '');
      if (!apiKey || apiKey.trim() === '') continue;

      const models = settings.get<string>(mapping.modelsField, '');
      const modelList = models ? models.split(',').map(s => s.trim()).filter(Boolean) : [mapping.defaultModel];
      const baseUrl = mapping.baseUrlField 
        ? settings.get<string>(mapping.baseUrlField, '') || mapping.defaultBaseUrl
        : mapping.defaultBaseUrl;

      const profileName = mapping.provider === 'proxy' ? 'OpenAI 兼容 (迁移)' : mapping.provider.charAt(0).toUpperCase() + mapping.provider.slice(1) + ' (迁移)';

      ApiProfileRepository.create({
        name: profileName,
        provider: mapping.provider,
        apiKey: apiKey,
        baseUrl: baseUrl,
        models: modelList,
        isActive: true,
        sortOrder: migrated,
      });
      migrated++;
    }

    if (migrated > 0) {
      AppLogger.info(LOG_TAGS.SYSTEM, `已迁移 ${migrated} 个旧 API 配置到 api_profiles`);
    }
  } catch (err) {
    AppLogger.warn(LOG_TAGS.SYSTEM, '旧 API 配置迁移失败（非致命）', err);
  }
}