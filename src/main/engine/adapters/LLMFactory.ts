import { SettingsRepository } from '../../database/repositories/SettingsRepository';
import { ApiProfileRepository } from '../../database/repositories/ApiProfileRepository';
import { ProfileBindingRepository } from '../../database/repositories/ProfileBindingRepository';
import { OpenAICompatibleAdapter } from './OpenAICompatibleAdapter';
import { VolcengineAdapter } from './VolcengineAdapter';
import type { ILLMProvider } from './ILLMProvider';

export type AITaskType = 'visual' | 'script' | 'translate' | 'helper' | 'chat';

export interface FactoryResult {
  adapter: ILLMProvider;
  modelName: string;
  temperature: number;
}

export class LLMFactory {
  static create(provider: string, apiKey: string, baseURL?: string): ILLMProvider {
    let cleanBaseURL = baseURL || '';
    cleanBaseURL = cleanBaseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/models\/?$/, '').replace(/\/$/, '');
    if (provider === 'doubao' || provider === 'volc') {
      return new VolcengineAdapter(cleanBaseURL || 'https://ark.cn-beijing.volces.com/api/v3', apiKey);
    }
    return new OpenAICompatibleAdapter(cleanBaseURL || 'https://api.openai.com/v1', apiKey);
  }

  private static resolveApiKey(provider: string, settings: SettingsRepository, oldKey: string): string {
    try {
      const active = ApiProfileRepository.getActive(provider);
      if (active?.apiKey) return active.apiKey;
    } catch {}
    return settings.get(oldKey, '') as string;
  }

  static createAdapter(taskType: AITaskType): FactoryResult {
    // === NEW: Check bindings table first ===
    const binding = ProfileBindingRepository.getByTaskType(taskType);
    if (binding && binding.profileId) {
      try {
        const allProfiles = ApiProfileRepository.getAll();
        const matchedProfile = allProfiles.find((p) => p.id === binding.profileId);
        if (matchedProfile && matchedProfile.apiKey) {
          let baseURL = matchedProfile.baseUrl || 'https://api.openai.com/v1';
          baseURL = baseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
          const adapter = new OpenAICompatibleAdapter(baseURL, matchedProfile.apiKey);
          const temp = taskType === 'visual' ? 0.1 : taskType === 'script' ? 0.8 : 0.7;
          return { adapter, modelName: binding.modelName, temperature: temp };
        }
      } catch { /* fall through to old logic */ }
    }

    // === OLD LOGIC: fallback ===
    const settings = new SettingsRepository();
    let modelKey = 'taskHelperModel';
    let temperature = 0.7;
    switch (taskType) {
      case 'visual': modelKey = 'taskVisualModel'; temperature = 0.1; break;
      case 'script': modelKey = 'taskScriptModel'; temperature = 0.8; break;
      case 'translate': modelKey = 'taskTranslateModel'; temperature = 0.1; break;
      case 'helper': default: modelKey = 'taskHelperModel'; temperature = 0.7; break;
    }

    const modelName = (binding?.modelName) || (settings.get(modelKey, '') as string);
    if (!modelName) {
      throw new Error("未配置模型，请在设置中为此任务选择模型");
    }

    let baseURL = '';
    let apiKey = '';
    let adapter: ILLMProvider;

    const deepseekModels = settings.get('deepseekModels', []) as string[];
    const qwenModels = settings.get('qwenModels', []) as string[];
    const tencentModels = settings.get('tencentModels', []) as string[];
    const doubaoModels = settings.get('doubaoModels', []) as string[];

    if (doubaoModels.includes(modelName) || modelName.startsWith('ep-')) {
      baseURL = 'https://ark.cn-beijing.volces.com/api/v3';
      apiKey = this.resolveApiKey('doubao', settings, 'doubaoKey');
      if (!apiKey) throw new Error("未找到火山引擎的 API Key");
      adapter = new VolcengineAdapter(baseURL, apiKey);
    } else if (deepseekModels.includes(modelName) || modelName.toLowerCase().includes('deepseek')) {
      baseURL = 'https://api.deepseek.com/v1';
      apiKey = this.resolveApiKey('deepseek', settings, 'deepseekKey');
      adapter = new OpenAICompatibleAdapter(baseURL, apiKey);
    } else if (qwenModels.includes(modelName) || modelName.toLowerCase().includes('qwen')) {
      baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      apiKey = this.resolveApiKey('qwen', settings, 'qwenKey');
      adapter = new OpenAICompatibleAdapter(baseURL, apiKey);
    } else if (tencentModels.includes(modelName) || modelName.toLowerCase().includes('hunyuan')) {
      baseURL = 'https://api.hunyuan.cloud.tencent.com/v1';
      apiKey = this.resolveApiKey('tencent', settings, 'tencentKey');
      adapter = new OpenAICompatibleAdapter(baseURL, apiKey);
    } else {
      try {
        const active = ApiProfileRepository.getActive('proxy');
        if (active?.baseUrl) { baseURL = active.baseUrl; }
        else { baseURL = settings.get('openaiBaseUrl', 'https://api.openai.com/v1') as string; }
      } catch {
        baseURL = settings.get('openaiBaseUrl', 'https://api.openai.com/v1') as string;
      }
      baseURL = baseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
      apiKey = this.resolveApiKey('proxy', settings, 'openaiKey');
      adapter = new OpenAICompatibleAdapter(baseURL, apiKey);
    }

    return { adapter, modelName, temperature };
  }
}
