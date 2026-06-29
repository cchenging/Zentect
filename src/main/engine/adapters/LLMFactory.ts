// 📁 路径：src/main/engine/adapters/LLMFactory.ts
import { ILLMProvider } from './ILLMProvider';
import { OpenAICompatibleAdapter } from './OpenAICompatibleAdapter';
import { VolcengineAdapter } from './VolcengineAdapter';
import { LLMConfig } from '../config/ProviderManager';
import { SettingsRepository } from '../../database/repositories/SettingsRepository';
import { ApiProfileRepository } from '../../database/repositories/ApiProfileRepository';

export type AITaskType = 'visual' | 'script' | 'translate' | 'helper';

/**
 * 工厂返回结果：适配器实例 + 模型名 + 温度参数
 */
export interface FactoryResult {
  adapter: ILLMProvider;
  modelName: string;
  temperature: number;
}

/**
 * 模型工厂：根据任务类型动态生成对应的大模型适配器实例
 */
export class LLMFactory {
  /**
   * Resolve API key: check api_profiles (multi-API) first, fall back to old settings.
   */
  private static resolveApiKey(provider: string, settings: SettingsRepository, oldKey: string): string {
    try {
      const active = ApiProfileRepository.getActive(provider);
      if (active?.apiKey) return active.apiKey;
    } catch {}
    return settings.get(oldKey, '') as string;
  }

  
  /**
   * 💥 修复核心：补回被遗漏的系统级 create 方法！
   * 专门用于前端【全局设置】中的网络连通性与 API Key 有效性检测
   * @param provider 厂商标识 (如 deepseek, qwen, doubao 等)
   * @param apiKey 用户的 API Key
   * @param baseURL API 请求基地址
   */
  static create(provider: string, apiKey: string, baseURL?: string): ILLMProvider {
    // 💥 修复：彻底清洗中转地址的冗余后缀，防止 404
    let cleanBaseURL = baseURL || '';
    cleanBaseURL = cleanBaseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/models\/?$/, '').replace(/\/$/, '');

    // 1. 字节跳动火山引擎走专门的接入适配器
    if (provider === 'doubao' || provider === 'volcengine') {
      return new VolcengineAdapter(cleanBaseURL || 'https://ark.cn-beijing.volces.com/api/v3', apiKey);
    }
    
    // 2. DeepSeek、通义千问、腾讯混元、OpenAI 及第三方中转，全系兼容 OpenAI 标准流式协议
    return new OpenAICompatibleAdapter(cleanBaseURL || 'https://api.openai.com/v1', apiKey);
  }

  /**
   * 🌟 极其纯净的工厂：只认 Config 对象，不认数据库。
   * 用于 ProviderManager 配置输出后的标准化组装
   */
  static createFromConfig(config: LLMConfig): ILLMProvider {
    if (!config.apiKey) {
      throw new Error(`[${config.provider}] 通道 API Key 未配置，请前往全局设置填写`);
    }

    if (config.provider === 'doubao' || config.provider === 'volcengine') {
      return new VolcengineAdapter(config.baseURL, config.apiKey);
    }
    
    return new OpenAICompatibleAdapter(config.baseURL, config.apiKey);
  }

  /**
   * 业务级路由：根据任务类型，动态生成对应的大模型适配器实例
   * 路由策略：优先按用户配置的各供应商模型列表精确匹配，其次按模型名关键字模糊匹配
   * @param taskType - 任务类型（visual/script/translate/helper）
   * @returns 适配器实例、模型名称和温度参数
   */
  static createAdapter(taskType: AITaskType): FactoryResult {
    const settings = new SettingsRepository();
    let modelKey = 'taskHelperModel';
    let temperature = 0.7;

    // 1. 确定任务所需读取的设置键值与标准温度
    switch (taskType) {
      case 'visual': modelKey = 'taskVisualModel'; temperature = 0.1; break;
      case 'script': modelKey = 'taskScriptModel'; temperature = 0.8; break;
      case 'translate': modelKey = 'taskTranslateModel'; temperature = 0.1; break;
      case 'helper': default: modelKey = 'taskHelperModel'; temperature = 0.7; break;
    }

    const modelName = settings.get(modelKey, '') as string;
    if (!modelName) {
      throw new Error(`系统拦截：请先在【全局偏好设置】中为 [${taskType}] 任务分配启用的模型。（设置键: ${modelKey}）`);
    }

    let baseURL = '';
    let apiKey = '';
    let adapter: ILLMProvider;

    // 2. 智能路由：优先按用户配置的模型列表精确匹配，其次按关键字模糊匹配
    const deepseekModels = settings.get('deepseekModels', []) as string[];
    const qwenModels = settings.get('qwenModels', []) as string[];
    const tencentModels = settings.get('tencentModels', []) as string[];
    const doubaoModels = settings.get('doubaoModels', []) as string[];
    const openaiModels = settings.get('openaiModels', []) as string[];

    if (doubaoModels.includes(modelName) || modelName.startsWith('ep-')) {
      // 命中字节跳动火山引擎
      baseURL = 'https://ark.cn-beijing.volces.com/api/v3';
      apiKey = this.resolveApiKey('doubao', settings, 'doubaoKey');
      if (!apiKey) throw new Error(`系统无法为火山引擎节点 [${modelName}] 匹配到有效的 API Key。`);
      adapter = new VolcengineAdapter(baseURL, apiKey);
    } else if (deepseekModels.includes(modelName) || modelName.toLowerCase().includes('deepseek')) {
      // 命中 DeepSeek：精确匹配用户配置列表 或 模型名包含 deepseek
      baseURL = 'https://api.deepseek.com/v1';
      apiKey = this.resolveApiKey('deepseek', settings, 'deepseekKey');
      adapter = new OpenAICompatibleAdapter(baseURL, apiKey);
    } else if (qwenModels.includes(modelName) || modelName.toLowerCase().includes('qwen')) {
      // 命中阿里云通义千问：精确匹配用户配置列表 或 模型名包含 qwen
      baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      apiKey = this.resolveApiKey('qwen', settings, 'qwenKey');
      adapter = new OpenAICompatibleAdapter(baseURL, apiKey);
    } else if (tencentModels.includes(modelName) || modelName.toLowerCase().includes('hunyuan')) {
      // 命中腾讯混元：精确匹配用户配置列表 或 模型名包含 hunyuan
      baseURL = 'https://api.hunyuan.cloud.tencent.com/v1';
      apiKey = this.resolveApiKey('tencent', settings, 'tencentKey');
      adapter = new OpenAICompatibleAdapter(baseURL, apiKey);
    } else if (openaiModels.includes(modelName) || modelName.toLowerCase().includes('gpt') || modelName.toLowerCase().includes('o1') || modelName.toLowerCase().includes('o3') || modelName.toLowerCase().includes('claude')) {
      // 命中 OpenAI 及兼容中转：精确匹配用户配置列表 或 模型名包含 gpt/o1/o3/claude
      try { const active = ApiProfileRepository.getActive('proxy'); if (active?.baseUrl) { baseURL = active.baseUrl; } else { baseURL = settings.get('openaiBaseUrl', 'https://api.openai.com/v1') as string; } } catch { baseURL = settings.get('openaiBaseUrl', 'https://api.openai.com/v1') as string; }
      baseURL = baseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
      apiKey = this.resolveApiKey('proxy', settings, 'openaiKey');
      adapter = new OpenAICompatibleAdapter(baseURL, apiKey);
    } else {
      // 降级兜底：使用 OpenAI 中转地址，让用户自定义的任意模型都能走通
      try { const active = ApiProfileRepository.getActive('proxy'); if (active?.baseUrl) { baseURL = active.baseUrl; } else { baseURL = settings.get('openaiBaseUrl', 'https://api.openai.com/v1') as string; } } catch { baseURL = settings.get('openaiBaseUrl', 'https://api.openai.com/v1') as string; }
      baseURL = baseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
      apiKey = this.resolveApiKey('proxy', settings, 'openaiKey');
      adapter = new OpenAICompatibleAdapter(baseURL, apiKey);
    }

    return { adapter, modelName, temperature };
  }
}
