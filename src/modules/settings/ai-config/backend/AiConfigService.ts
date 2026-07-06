// 📁 路径：src/modules/settings/ai-config/backend/AiConfigService.ts
// AI 配置服务：封装 API Profile CRUD + 连接测试（§3.7.1）
// 委托层：现有 ApiProfileRepository 已完整实现，此处提供类型化封装

import type { ApiProfile, ProviderConfig } from '../types';

// 委托到原有实现
export { ApiProfileRepository } from '../../../../main/database/repositories/ApiProfileRepository';
export type { ApiProfile as ApiProfileRow } from '../../../../main/database/repositories/ApiProfileRepository';

/** 预设供应商配置（与规格 §3.7.1 对齐） */
export const PROVIDER_CONFIGS: ProviderConfig[] = [
  {
    id: 'deepseek', name: 'DeepSeek 深度求索',
    keyField: 'deepseekKey', modelsField: 'deepseekModels',
    baseURL: 'https://api.deepseek.com/v1',
    link: 'https://platform.deepseek.com/',
    color: '#6366f1', hasBaseUrl: false,
  },
  {
    id: 'qwen', name: '阿里云 通义千问',
    keyField: 'qwenKey', modelsField: 'qwenModels',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    link: 'https://dashscope.console.aliyun.com/api-key',
    color: '#8b5cf6', hasBaseUrl: false,
  },
  {
    id: 'tencent', name: '腾讯 混元大模型',
    keyField: 'tencentKey', modelsField: 'tencentModels',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    link: 'https://console.cloud.tencent.com/hunyuan/api-key',
    color: '#06b6d4', hasBaseUrl: false,
  },
  {
    id: 'doubao', name: '字节跳动 豆包大模型',
    keyField: 'doubaoKey', modelsField: 'doubaoModels',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    link: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    color: '#f59e0b', hasBaseUrl: false,
  },
  {
    id: 'openai', name: 'OpenAI 协议中转',
    keyField: 'openaiKey', modelsField: 'openaiModels',
    baseURL: '',
    link: 'https://cloud.siliconflow.cn/',
    color: '#22c55e', hasBaseUrl: true,
  },
];

// Re-export for convenience — consumers can import from this module
export { ApiProfileRepository as default } from '../../../../main/database/repositories/ApiProfileRepository';
