// 📁 路径：src/modules/settings/ai-config/types.ts
// 接口契约：AI 服务配置（§3.7.1）

/** 供应商配置定义 */
export interface ProviderConfig {
  /** 供应商唯一标识 */
  id: string;
  /** 供应商显示名称 */
  name: string;
  /** 配置中 API Key 对应的字段名 */
  keyField: string;
  /** 配置中模型列表对应的字段名 */
  modelsField: string;
  /** 默认 API Base URL */
  baseURL: string;
  /** 获取 API Key 的链接 */
  link: string;
  /** 供应商品牌色 */
  color: string;
  /** 是否允许自定义 Base URL（OpenAI 兼容中转站） */
  hasBaseUrl: boolean;
}

/** API 配置档案 */
export interface ApiProfile {
  /** 唯一标识 */
  id: string;
  /** 配置名称（用户自定义） */
  name: string;
  /** 供应商 ID */
  provider: string;
  /** API Key（加密存储） */
  apiKey: string;
  /** API Base URL */
  baseUrl: string;
  /** 可用模型列表 */
  models: string[];
  /** 是否为该供应商的当前生效配置 */
  isActive: boolean;
}

/** AI 配置输入 */
export interface AiConfigInput {
  /** 供应商配置列表 */
  providers: ProviderConfig[];
  /** 用户 API 配置档案列表 */
  apiProfiles: ApiProfile[];
}
