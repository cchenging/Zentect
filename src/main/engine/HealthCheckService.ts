// 📁 路径：src/main/engine/HealthCheckService.ts
// 从 AIEngine.ts 拆分：服务健康检查 / 网络连通性测试 / 错误翻译

import { PathManager } from '../utils/pathManager';
import { ProviderManager } from './config/ProviderManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface ServiceCheck {
  name: string;
  available: boolean;
  type: 'local' | 'cloud';
  hint: string;
}

export class HealthCheckService {

  // ---------------------------------------------------------------------------
  // V1.2: 内容安全拦截 — HTTP 状态码 → 用户友好中文提示
  // ---------------------------------------------------------------------------
  /** 将 LLM 请求失败的原始错误翻译为用户可理解的提示 */
  public translateHttpError(rawError: any): string {
    const msg = (rawError?.message || rawError?.toString?.() || String(rawError)).toLowerCase();

    // 401: API Key 无效或未配置
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')
      || msg.includes('incorrect api key') || msg.includes('auth')) {
      return 'AI 鉴权失败 — API Key 无效或已过期。请在 设置 → AI 中更新密钥。';
    }
    // 429 / 503: 速率限制或服务过载
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
      || msg.includes('quota') || msg.includes('503')) {
      return 'AI 服务繁忙 — 请求频率过高或额度已用尽，请稍后重试。\n💡 切换服务商可获得更多免费额度。';
    }
    // 400: 请求格式错误（模型不支持等）
    if (msg.includes('400') || msg.includes('bad request') || msg.includes('invalid')
      || msg.includes('context length') || msg.includes('token')) {
      return 'AI 请求被拒 — 可能原因：模型不支持该操作、输入过长超出上下文限制，或参数格式错误。';
    }
    // 402: 余额不足
    if (msg.includes('402') || msg.includes('payment') || msg.includes('balance')
      || msg.includes('insufficient')) {
      return 'AI 服务余额不足 — 请在服务商平台充值或切换到其他可用通道。';
    }
    // 超时
    if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('abort')) {
      return 'AI 请求超时 — 网络连接不稳定或服务端响应过慢，请检查网络后重试。';
    }
    // 其他错误 — 保留原始信息
    return `AI 服务异常: ${rawError?.message || rawError}`;
  }

  // ---------------------------------------------------------------------------
  // 🛡️ 0. 前置配置检查：Pipeline 开始前调用，缺什么直接告诉用户
  // ---------------------------------------------------------------------------
  public preflightCheck(pipelineSteps: string[]): ServiceCheck[] {
    const results: ServiceCheck[] = [];
    const steps = new Set(pipelineSteps);

    // FFmpeg — 始终需要
    const ffmpegPath = PathManager.getBinPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    results.push({
      name: 'FFmpeg',
      available: fs.existsSync(ffmpegPath),
      type: 'local',
      hint: fs.existsSync(ffmpegPath) ? '' : '系统缺失 FFmpeg，请重新安装软件'
    });

    // ASR（SenseVoice）— 打包在安装包中
    const sensevoicePath = path.join(PathManager.getModelsPath(), 'sensevoice_onnx');
    results.push({
      name: '语音识别 (ASR)',
      available: fs.existsSync(sensevoicePath),
      type: 'local',
      hint: fs.existsSync(sensevoicePath) ? '' : 'ASR 模型缺失，语音识别不可用'
    });

    // TTS — 检查当前配置的 TTS 引擎
    const ttsProvider = ProviderManager.getTTSConfig().provider;
    if (ttsProvider === 'edge') {
      results.push({
        name: 'TTS 配音 (Edge)',
        available: true,
        type: 'cloud',
        hint: ''
      });
    } else if (ttsProvider === 'doubao') {
      const cfg = ProviderManager.getTTSConfig('doubao');
      const ok = !!(cfg.appId && cfg.token);
      results.push({
        name: 'TTS 配音 (火山引擎)',
        available: ok,
        type: 'cloud',
        hint: ok ? '' : '火山 TTS 未配置，请在 设置 → AI → 语音合成 中填写 AppID 和 Token'
      });
    } else if (ttsProvider === 'fish') {
      const cfg = ProviderManager.getTTSConfig('fish');
      const ok = !!cfg.apiKey;
      results.push({
        name: 'TTS 配音 (Fish Audio)',
        available: ok,
        type: 'cloud',
        hint: ok ? '' : 'Fish Audio 未配置，请在 设置 → AI → 语音合成 中填写 API Key'
      });
    } else {
      // sovits / moss — 本地引擎
      results.push({
        name: `TTS 配音 (${ttsProvider})`,
        available: true,
        type: 'local',
        hint: ''
      });
    }

    // LLM — 脚本生成需要
    if (steps.has('script') || steps.has('translate')) {
      try {
        const cfg = ProviderManager.getLLMConfig('script');
        results.push({
          name: '解说稿生成 (LLM)',
          available: !!(cfg.apiKey && cfg.baseURL),
          type: 'cloud',
          hint: '未配置 AI 模型。请在 设置 → AI 中填写任意一个通道的 API Key\n' +
            '  可选通道：DeepSeek / 通义千问 / 火山豆包 / OpenAI 中转\n' +
            '  推荐：DeepSeek（便宜），注册获取 Key：https://platform.deepseek.com'
        });
      } catch (e: any) {
        results.push({
          name: '解说稿生成 (LLM)',
          available: false,
          type: 'cloud',
          hint: e.message + '\n  请在 设置 → AI 中配置 API Key'
        });
      }
    }

    return results;
  }

  /**
   * 将前置检查结果格式化为用户友好的提示文本
   * 返回 { ok: boolean, message: string }
   * ok = true → 所有服务可用
   * ok = false → 列出缺失的服务，告诉用户去哪里配置
   */
  public formatCheckResult(checks: ServiceCheck[]): { ok: boolean; message: string } {
    const failed = checks.filter(c => !c.available && c.hint);
    if (failed.length === 0) return { ok: true, message: '' };

    const lines = ['⚠️ 部分功能不可用，请在 设置 中配置后再试：', ''];
    for (const f of failed) {
      lines.push(`  ❌ ${f.name}`);
      lines.push(`     ${f.hint}`);
      lines.push('');
    }
    lines.push('💡 已配置的服务不受影响，其余步骤会继续执行。');
    return { ok: false, message: lines.join('\n') };
  }

  // ---------------------------------------------------------------------------
  // 📡 2. 网络连通性测试 (完美隔离表单与持久化数据)
  // ---------------------------------------------------------------------------
  public async testNetwork(type: 'doubao_tts' | 'openai_like', data: any): Promise<string> {
    if (type === 'doubao_tts') {
      const ttsConfig = ProviderManager.getTTSConfig('doubao');
      const appId = data.appId || data.appid || ttsConfig.appId;
      const token = data.token || ttsConfig.token;
      
      if (!appId || !token) throw new Error('AppID 或 Token 不能为空');
      
      const ttsCtrl = new AbortController();
      const ttsTimeout = setTimeout(() => ttsCtrl.abort(), 10000);
      const res = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
          method: 'POST', 
          headers: { 'Authorization': `Bearer; ${token.trim()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            app: { appid: appId.trim(), token: token.trim(), cluster: "volcano_tts" }, 
            user: { uid: "test_user" }, 
            audio: { voice_type: "zh_female_meilinvyou_saturn_bigtts", encoding: "mp3" }, 
            request: { reqid: crypto.randomUUID(), text: "1", text_type: "plain", operation: "query" } 
          }),
          signal: ttsCtrl.signal,
      });
      clearTimeout(ttsTimeout);
      const json = await res.json();
      if (json.code === 3000) return `TTS_AUTH_SUCCESS`;
      throw new Error(`TTS 鉴权失败：${json.message}`);
    }
    
    if (type === 'openai_like') {
      const provider = data.provider || 'unknown';
      const apiKey = data.apiKey || data.key;
      let baseURL = data.baseURL || data.url;
      
      if (!apiKey) throw new Error('API Key 不能为空');
      
      if (!baseURL) {
        try { baseURL = ProviderManager.getLLMConfig('chat', provider).baseURL; } catch(e) {
          AppLogger.warn(LOG_TAGS.AI_ENGINE, `getLLMConfig 失败 (${provider}), 使用默认 URL`, e);
        }
      }
      
      const cleanUrl = (baseURL || 'https://api.openai.com/v1').replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${cleanUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      
      if (res.ok) return 'LLM_AUTH_SUCCESS';
      if (res.status === 404 || res.status === 400) return 'LLM_AUTH_SUCCESS_PROXY_MODE';
      
      throw new Error(`鉴权失败，状态码：${res.status}`);
    }
    return 'TEST_FINISHED';
  }
}

export const healthCheckService = new HealthCheckService();
