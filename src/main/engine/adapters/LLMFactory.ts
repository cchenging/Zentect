import { SettingsRepository } from '../../database/repositories/SettingsRepository';
import { ApiProfileRepository, type ApiProfile } from '../../database/repositories/ApiProfileRepository';
import { ProfileBindingRepository } from '../../database/repositories/ProfileBindingRepository';
import { OpenAICompatibleAdapter } from './OpenAICompatibleAdapter';
import { VolcengineAdapter } from './VolcengineAdapter';
import type { ILLMProvider } from './ILLMProvider';
// 🔧 修复 TS2339：导入 LLMConfig 类型供 createFromConfig 使用
import type { LLMConfig } from '../config/ProviderManager';
// ADR-004 G3：出站前 preflight —— 凭据非 ok 立即抛 AIAuthError，绝不带空 Key 进批次循环
import {
  AIAuthError,
  assertOutboundCredential,
  type CredentialStatus,
} from '../../../shared/utils/credentialFormat';

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

  // 🔧 修复 TS2339：新增 createFromConfig 方法（AIEngine.ts 调用但原代码缺失）
  // 从 LLMConfig 直接构造 adapter，避免重复查表
  // ADR-004 G3：构造 adapter **之前**做 preflight（凭据非 ok 立即抛 AIAuthError）
  static createFromConfig(config: LLMConfig): ILLMProvider {
    assertOutboundCredential({
      provider: config.provider,
      taskLabel: 'config',
      apiKey: config.apiKey,
      status: config.apiKeyStatus,
    });
    return this.create(config.provider, config.apiKey, config.baseURL);
  }

  /**
   * 解析某通道的凭据（ADR-004 G3：返回 key + 状态，不再只返回裸字符串）
   *
   * ⚠️ 激活 profile 存在但凭据 `decrypt_failed` ⇒ **立即抛 AIAuthError**，
   *    绝不静默落到 settings 兜底 —— 那会造成「已失效的 Key 被换成一个空/旧值继续外发」。
   */
  private static resolveApiKey(
    provider: string,
    settings: SettingsRepository,
    oldKey: string,
    taskLabel: AITaskType,
  ): { key: string; status: CredentialStatus } {
    try {
      const active = ApiProfileRepository.getActive(provider);
      if (active?.apiKeyStatus === 'decrypt_failed') {
        throw new AIAuthError({ provider, taskLabel, status: 'decrypt_failed' });
      }
      if (active?.apiKey) return { key: active.apiKey, status: 'ok' };
    } catch (err) {
      if (err instanceof AIAuthError) throw err; // 拦截异常不可被下面的兜底吞掉
      // 其余（查询异常等）保持原语义：回退到 settings
    }
    const key = settings.get(oldKey, '') as string;
    return { key, status: key ? 'ok' : 'missing' };
  }

  /**
   * 👑 项目唯一的"任务 → LLM 配置"权威解析入口（单一数据源）
   * 解析顺序：①「模型映射」绑定表(ProfileBindingRepository) 优先
   *          ② 回退 settings 任务模型名，再按模型名路由到对应 provider
   * 返回完整 LLMConfig（含 baseURL/apiKey/model/temperature），供 createAdapter 与各调用点复用。
   * 注意：不要用 ProviderManager.getLLMConfig——它读的是 api_profiles 激活的 proxy 通道，
   *       与脚本生成实际使用的绑定表不同，会造成"脚本能用、别处却 403"。
   */
  static getEffectiveConfig(taskType: AITaskType): LLMConfig {
    // === ① 绑定表优先：用户「模型映射」里给该任务绑定的 profile + 模型 ===
    const binding = ProfileBindingRepository.getByTaskType(taskType);
    if (binding && binding.profileId) {
      let matchedProfile: ApiProfile | undefined;
      try {
        matchedProfile = ApiProfileRepository.getAll().find((p) => p.id === binding.profileId);
      } catch { /* 查询异常 ⇒ 回退到模型路由 */ }
      if (matchedProfile && matchedProfile.enabled !== 0) {
        // ADR-004 G3：绑定的 profile 存在但凭据已失效 ⇒ 立即拦截，
        // 绝不因 apiKey 被置空而静默落到 ② 换通道（429 事故形态）
        if (matchedProfile.apiKeyStatus === 'decrypt_failed') {
          throw new AIAuthError({ provider: matchedProfile.provider, taskLabel: taskType, status: 'decrypt_failed' });
        }
        if (matchedProfile.apiKey) {
          let baseURL = matchedProfile.baseUrl || 'https://api.openai.com/v1';
          baseURL = baseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
          const temperature = taskType === 'visual' ? 0.1 : taskType === 'script' ? 0.8 : 0.7;
          return { provider: matchedProfile.provider, model: binding.modelName, baseURL, apiKey: matchedProfile.apiKey, apiKeyStatus: 'ok', temperature };
        }
      }
    }

    // === ② 回退：settings 任务模型名 → 按模型名路由 provider ===
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
    if (!modelName) throw new Error('未配置模型，请在设置中为此任务选择模型');

    const deepseekModels = settings.get('deepseekModels', []) as string[];
    const qwenModels = settings.get('qwenModels', []) as string[];
    const tencentModels = settings.get('tencentModels', []) as string[];
    const doubaoModels = settings.get('doubaoModels', []) as string[];

    let provider: string;
    let baseURL = '';
    let apiKey = '';
    let apiKeyStatus: CredentialStatus = 'missing';
    const applyKey = (r: { key: string; status: CredentialStatus }) => { apiKey = r.key; apiKeyStatus = r.status; };
    if (doubaoModels.includes(modelName) || modelName.startsWith('ep-')) {
      provider = 'doubao';
      baseURL = 'https://ark.cn-beijing.volces.com/api/v3';
      applyKey(this.resolveApiKey('doubao', settings, 'doubaoKey', taskType));
    } else if (deepseekModels.includes(modelName) || modelName.toLowerCase().includes('deepseek')) {
      provider = 'deepseek';
      baseURL = 'https://api.deepseek.com/v1';
      applyKey(this.resolveApiKey('deepseek', settings, 'deepseekKey', taskType));
    } else if (qwenModels.includes(modelName) || modelName.toLowerCase().includes('qwen')) {
      provider = 'qwen';
      baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      applyKey(this.resolveApiKey('qwen', settings, 'qwenKey', taskType));
    } else if (tencentModels.includes(modelName) || modelName.toLowerCase().includes('hunyuan')) {
      provider = 'tencent';
      baseURL = 'https://api.hunyuan.cloud.tencent.com/v1';
      applyKey(this.resolveApiKey('tencent', settings, 'tencentKey', taskType));
    } else {
      try {
        const active = ApiProfileRepository.getActive('proxy');
        if (active?.baseUrl) { baseURL = active.baseUrl; }
        else { baseURL = settings.get('openaiBaseUrl', 'https://api.openai.com/v1') as string; }
      } catch {
        baseURL = settings.get('openaiBaseUrl', 'https://api.openai.com/v1') as string;
      }
      baseURL = baseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
      provider = 'proxy';
      applyKey(this.resolveApiKey('proxy', settings, 'openaiKey', taskType));
    }

    // ADR-004 G3：出站前统一 preflight —— 补齐 deepseek/qwen/tencent/proxy 原先缺失的空 Key 校验，
    // 并把 doubao 原有的裸 Error 一并统一为 AIAuthError（保证 ExceptionHub 可归类为 AI_AUTH_FAILED）
    assertOutboundCredential({ provider, taskLabel: taskType, apiKey, status: apiKeyStatus });

    return { provider, model: modelName, baseURL, apiKey, apiKeyStatus, temperature };
  }

  static createAdapter(taskType: AITaskType): FactoryResult {
    // 复用权威配置解析，单一数据源
    const config = this.getEffectiveConfig(taskType);
    const adapter = this.create(config.provider, config.apiKey, config.baseURL);
    return { adapter, modelName: config.model, temperature: config.temperature };
  }
}
