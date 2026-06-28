import { SettingsRepository } from '../../database/repositories/SettingsRepository';
import { ApiProfileRepository } from '../../database/repositories/ApiProfileRepository';

export interface LLMConfig { provider: string; model: string; baseURL: string; apiKey: string; temperature: number; }
export interface TTSConfig { provider: string; appId?: string; token?: string; voice?: string; url?: string; apiKey?: string; mossUrl?: string; mossModelDir?: string; }

export class ProviderManager {
  private static settings = new SettingsRepository();

  public static getLLMConfig(_taskType: 'visual' | 'script' | 'translate' | 'helper' | 'chat', explicitProvider?: string): LLMConfig {
    
    // 1. 确定要使用哪个通道 (优先听 AgentConsole 传来的 explicitProvider)
    const provider = explicitProvider || 'proxy';
    
    let baseURL = '';
    let apiKey = '';
    let modelName = '';

    // 2. 纯粹的查表逻辑：你要哪个通道，我就去数据库拿哪个通道的钥匙！
    // Check api_profiles first (multi-API support)
    const activeProfile = ApiProfileRepository.getActive(provider);
    if (activeProfile && activeProfile.apiKey) {
      let profileBaseURL = activeProfile.baseUrl || '';
      if (provider === 'proxy' && profileBaseURL) {
        if (!profileBaseURL.startsWith('http://') && !profileBaseURL.startsWith('https://')) {
          profileBaseURL = /^(localhost|127\.|192\.168|10\.)/.test(profileBaseURL) ? 'http://' + profileBaseURL : 'https://' + profileBaseURL;
        }
        profileBaseURL = profileBaseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
      }
      if (!profileBaseURL) {
        switch (provider) {
          case 'deepseek': profileBaseURL = 'https://api.deepseek.com/v1'; break;
          case 'qwen': profileBaseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; break;
          case 'doubao': profileBaseURL = 'https://ark.cn-beijing.volces.com/api/v3'; break;
          case 'tencent': profileBaseURL = 'https://api.hunyuan.cloud.tencent.com/v1'; break;
        }
      }
      const profileModel = activeProfile.models?.[0] || '';
      return { provider, model: profileModel, baseURL: profileBaseURL, apiKey: activeProfile.apiKey, temperature: 0.5 };
    }
switch (provider) {
      case 'deepseek':
        baseURL = 'https://api.deepseek.com/v1';
        apiKey = this.settings.get<string>('deepseekKey', '');
        modelName = 'deepseek-chat';
        break;
      case 'qwen':
        baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        apiKey = this.settings.get<string>('qwenKey', '');
        modelName = 'qwen-plus';
        break;
      case 'doubao':
        baseURL = 'https://ark.cn-beijing.volces.com/api/v3';
        apiKey = this.settings.get<string>('doubaoKey', '');
        // 豆包必须从配置里读接入点 EP
        modelName = this.settings.get<string>('taskHelperModel', '');
        break;
      case 'proxy': // 国内中转代理通道
      case 'openai':
        // 直接从数据库拿前端设置好的代理 URL 和 Key
        let rawUrl = this.settings.get<string>('openaiBaseUrl', '') || this.settings.get<string>('proxyUrl', '');
        
        // 💥 终极防线：如果用户真的没填，或者读出来是官方默认值，必须拦截！
        if (!rawUrl || rawUrl.trim() === '') {
          throw new Error('【系统拦截】未读取到代理地址，请在全局设置的 [OpenAI 协议中转] 中填写您的 Base URL！');
        }
        
        // 如果读出来的是默认的官方地址，也强制报错提醒用户修改
        if (rawUrl.includes('api.openai.com')) {
          throw new Error('【系统拦截】当前使用的 Base URL 为官方默认地址，会导致物理断网。请前往 [全局设置] 修改为国内直连中转站地址！');
        }

        if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
          rawUrl = /^(localhost|127\.0|192\.168|10\.)/.test(rawUrl) ? 'http://' + rawUrl : 'https://' + rawUrl;
        }

        baseURL = rawUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
        apiKey = this.settings.get<string>('openaiKey', '') || this.settings.get<string>('proxyKey', '');
        modelName = this.settings.get<string>('taskHelperModel', '') || 'gpt-4o-mini';
        break;
      default:
        throw new Error(`不支持的引擎通道: ${provider}`);
    }

    // 3. 极其严酷的防呆校验：没配置直接拦截，绝不瞎撞！
    if (!apiKey || apiKey.trim() === '') {
      throw new Error(`【拦截】您选择了 [${provider}] 通道，但未在全局设置中配置 API Key！`);
    }
    
    if (provider === 'proxy') {
      if (!baseURL || baseURL.trim() === '') {
        throw new Error(`【拦截】您选择了代理通道，但未在全局设置中配置 [代理地址 Base URL]！`);
      }
      // 防呆：用户如果填了 http 开头的，保留；如果是纯域名，加上 https://
      if (!baseURL.startsWith('http://') && !baseURL.startsWith('https://')) {
        baseURL = /^(localhost|127\.0|192\.168|10\.)/.test(baseURL) ? 'http://' + baseURL : 'https://' + baseURL;
      }
    }

    // 4. 清洗 URL（防止用户在设置里多写了后缀）
    baseURL = baseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');

    return { provider, model: modelName, baseURL, apiKey, temperature: 0.5 };
  }

  // TTS 配置保持不变
  public static getTTSConfig(explicitProvider?: string): TTSConfig {
    const provider = explicitProvider || this.settings.get<string>('ttsProvider', 'edge');
    return {
      provider,
      appId: this.settings.get<string>('doubaoTtsAppId', ''),
      token: this.settings.get<string>('doubaoTtsToken', ''),
      voice: this.settings.get<string>('doubaoTtsVoice', 'zh_female_meilinvyou_saturn_bigtts'),
      url: this.settings.get<string>('sovitsUrl', 'http://127.0.0.1:9880'),
      apiKey: this.settings.get<string>('fishKey', ''),
      mossUrl: this.settings.get<string>('mossUrl', 'http://127.0.0.1:9881'),
      mossModelDir: this.settings.get<string>('mossModelDir', ''),
    };
  }

  private static getDefaultModel(provider: string): string {
    switch (provider) {
      case 'deepseek': return 'deepseek-chat';
      case 'qwen': return 'qwen-turbo';
      case 'doubao': return 'doubao-pro-32k';
      case 'tencent': return 'hunyuan-turbo';
      case 'proxy': return 'gpt-4o-mini';
      default: return '';
    }
  }}