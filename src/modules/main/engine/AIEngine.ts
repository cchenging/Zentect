// 📁 路径：src/main/engine/AIEngine.ts

import { WebContents } from 'electron';
import { FrameExtractor } from './capabilities/FrameExtractor';
import { TTSProvider } from '../../modules/pipeline/step4-tts/backend/Service';
import { NetworkPipeline } from '../core/NetworkPipeline';
import { ProcessManager } from '../utils/processManager';
import { PathManager } from '../utils/pathManager';
import { SQLiteConnection } from '../database/core/SQLiteConnection';
import { AIDaemon } from '../core/AIDaemon';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { PromptBuilder } from './prompts/PromptBuilder';
import { LLMFactory } from './adapters/LLMFactory'; 
import { ProviderManager } from './config/ProviderManager'; // 💥 唯一合法的配置出处
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { Shot } from '../../shared/types';
import { ENGINE_STATUS } from '../../infra/i18n/dictionary';
import { ChatHistoryRepository } from '../database/repositories/ChatHistoryRepository';
import { MediaRepository } from '../database/repositories/MediaRepository';

export type AITaskType = 'visual' | 'script' | 'translate' | 'helper';

export interface ServiceCheck {
  name: string;
  available: boolean;
  type: 'local' | 'cloud';
  hint: string;
}

export class AIEngine {

  // ---------------------------------------------------------------------------
  // V1.2: 内容安全拦截 — HTTP 状态码 → 用户友好中文提示
  // ---------------------------------------------------------------------------
  /** 将 LLM 请求失败的原始错误翻译为用户可理解的提示 */
  private static translateHttpError(rawError: any): string {
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
  public static preflightCheck(pipelineSteps: string[]): ServiceCheck[] {
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
  public static formatCheckResult(checks: ServiceCheck[]): { ok: boolean; message: string } {
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
  // 🧠 1. 基础对话推流 (纯净调用 Adapter)
  // ---------------------------------------------------------------------------
  public static async streamChat(webContents: WebContents, taskType: AITaskType, systemPrompt: string, userMessage: string, replyChannel: string) {
    try {
      // 👑 严格执宪：拿配置 -> 找工厂 -> 让适配器去干活
      const config = ProviderManager.getLLMConfig(taskType);
      const adapter = LLMFactory.createFromConfig(config);
      
      webContents.send(`${replyChannel}:start`, { model: config.model, task: taskType });
      
      const messages = [
        { role: 'system', content: systemPrompt }, 
        { role: 'user', content: userMessage }
      ];

      // 假设底层 Adapter 已实现 webContents 推流，否则也可在此调用 adapter.chat
      await adapter.streamChatToBrowser(webContents, messages, config.model, config.temperature, replyChannel);

    } catch (error: any) {
      const friendlyMsg = this.translateHttpError(error);
      AppLogger.error(LOG_TAGS.AI_ENGINE, `streamChat HTTP 错误: ${error.message}`);
      webContents.send(`${replyChannel}:error`, friendlyMsg);
    }
  }

  // ---------------------------------------------------------------------------
  // 📡 2. 网络连通性测试 (完美隔离表单与持久化数据)
  // ---------------------------------------------------------------------------
  public static async testNetwork(type: 'doubao_tts' | 'openai_like', data: any): Promise<string> {
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

  // ---------------------------------------------------------------------------
  // 🔊 3. 语音合成中枢 (彻底消灭 SettingsRepository)
  // ---------------------------------------------------------------------------
  public static async generateTTS(text: string, provider: 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss', saveDir?: string, voiceOverride?: string): Promise<string> {
    const config = ProviderManager.getTTSConfig(provider);
    const targetDir = saveDir || os.tmpdir();
    let ext = 'mp3'; let audioData: Buffer;

    // 提权：对所有引擎统一清洗文本，去除 LLM 生成的舞台指示标记
    const cleanedText = text
      .replace(/[【】\[\]\(\)（）「」『』]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    try {
      switch (provider) {
        case 'doubao': {
          if (!config.appId || !config.token) throw new Error('火山 TTS 未配置。请在 设置 → AI → 语音合成 中选择其他引擎，或填写火山引擎的 AppID 和 Token。');
          const voiceType = voiceOverride || config.voice || 'zh_female_meilinvyou_saturn_bigtts';
          const payload = { app: { appid: config.appId.trim(), token: config.token.trim(), cluster: "volcano_tts" }, user: { uid: "zentect_studio" }, audio: { voice_type: voiceType.trim(), encoding: "mp3" }, request: { reqid: crypto.randomUUID(), text: cleanedText, text_type: "plain", operation: "query" } };
          const res = await fetch('https://openspeech.bytedance.com/api/v1/tts', { method: 'POST', headers: { 'Authorization': `Bearer ${config.token.trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const json = await res.json();
          if (json.code !== 3000) throw new Error(`火山报错: ${json.message}`);
          audioData = Buffer.from(json.data, 'base64');
          break;
        }
        case 'edge': {
          let voiceType = voiceOverride || (/^[a-zA-Z0-9\s.,!?'-]+$/.test(cleanedText) ? 'en-US-JennyNeural' : 'zh-CN-XiaoxiaoNeural');
          const res = await fetch('https://api.tts.quest/v3/voicemaker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: cleanedText, voice: voiceType, format: 'mp3' }) });
          const data = await res.json();
          if (!data.data || !data.data.audio_url) throw new Error('Edge TTS 繁忙');
          const audioRes = await fetch(data.data.audio_url); audioData = Buffer.from(await audioRes.arrayBuffer());
          break;
        }
        case 'fish': {
          if (!config.apiKey) throw new Error('未配置 Fish Audio Key');
          const payload: any = { text: cleanedText }; if (voiceOverride) payload.reference_id = voiceOverride;
          const res = await fetch('https://api.fish.audio/v1/tts', { method: 'POST', headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          if (!res.ok) throw new Error(`Fish Audio 异常: ${await res.text()}`);
          audioData = Buffer.from(await res.arrayBuffer());
          break;
        }
        case 'sovits': {
          const url = new URL(config.url || 'http://127.0.0.1:9880');
          url.searchParams.append('text', cleanedText); url.searchParams.append('text_language', 'zh');
          if (voiceOverride) url.searchParams.append('character', voiceOverride);
          const res = await fetch(url.toString());
          if (!res.ok) throw new Error(`SoVITS 异常: ${res.statusText}`);
          audioData = Buffer.from(await res.arrayBuffer()); ext = 'wav';
          break;
        }
        case 'moss': {
          const mossUrl = config.mossUrl || 'http://127.0.0.1:9881';
          const voiceType = voiceOverride || 'Junhao';
          const res = await fetch(`${mossUrl}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleanedText, voice: voiceType, speed: 1.0 })
          });
          if (!res.ok) throw new Error(`MOSS-TTS 异常: ${await res.text()}`);
          const json = await res.json();
          if (json.code !== 0) throw new Error(`MOSS-TTS 错误: ${json.message}`);
          const audioStr = json.audio || ''; const isBase64 = /[^0-9a-fA-F]/.test(audioStr); audioData = isBase64 ? Buffer.from(audioStr, 'base64') : Buffer.from(audioStr, 'hex'); ext = 'wav';
          break;
        }
        default: throw new Error(`未知的 TTS: ${provider}`);
      }
      const fileName = `tts_${provider}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const filePath = path.join(targetDir, fileName);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(filePath, audioData);
      return filePath;
    } catch (err: any) {
      const hint = provider === 'doubao' ? '（请在 设置 → AI → 语音合成 中检查火山引擎配置）'
        : provider === 'fish' ? '（请在 设置 → AI → 语音合成 中检查 Fish Audio Key）'
        : provider === 'sovits' ? '（请确认本地 GPT-SoVITS 服务已启动，默认端口 9880）'
        : provider === 'moss' ? '（请确认 MOSS-TTS-Nano 模型已下载，或切换到 Edge 免费引擎）'
        : '';
      throw new Error(`${err.message || '语音合成失败'}${hint}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 🎬 4. 核心业务流水线 (纯净 Prompt 调用)
  // ---------------------------------------------------------------------------
  static async runAIRecreatePipeline(_projectId: string, _mediaPath: string, originalShots: any[], _mediaId: string, roles: any[], targetLanguage: string = 'zh-CN'): Promise<any[]> {
    const config = ProviderManager.getLLMConfig('script');
    const systemPrompt = PromptBuilder.buildScriptPrompt(targetLanguage);
    const multimodalContext = originalShots.map(s => ({ shotId: s.id, originalText: s.originalText || '', visionText: s.visionText || '' }));
    const userPrompt = (PromptBuilder as any).buildUserPrompt ? (PromptBuilder as any).buildUserPrompt(roles, multimodalContext) : JSON.stringify({ roles, context: multimodalContext });

    const adapter = LLMFactory.createFromConfig(config);
    const response = await adapter.chat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], config.model, config.temperature);
    
    if (!response.success) throw new Error(this.translateHttpError(new Error(response.error)));

    // 💥 Layer 4: 强制流经数据清洗防线，阻断脏资产向状态层渗透
    let aiSentences: any[] = [];
    try {
      aiSentences = NetworkPipeline.strictParseJson(response.text || '');
    } catch(e) {
      throw new Error('模型返回数据格式破坏！');
    }

    const finalShots: any[] = [];
    let idx = 0;
    aiSentences.forEach((item: any) => {
      const cleanPhrase = (item.aiText || '').trim();
      if (!cleanPhrase) return;
      const sourceShot = originalShots.find(s => s.id === item.sourceShotId) || originalShots[0];
      finalShots.push({ 
        id: `ai_shot_${Date.now()}_${idx++}`, mediaId: _mediaId, start: sourceShot?.start || 0, end: sourceShot ? sourceShot.start + 1.5 : 1.5, 
        aiText: cleanPhrase, coverPath: sourceShot?.coverPath || '', roleId: item.roleId || '' 
      });
    });
    return finalShots;
  }

  static async analyzeVision(imagePath: string): Promise<string> {
    const config = ProviderManager.getLLMConfig('visual');
    if (config.baseURL.includes('deepseek.com')) throw new Error('拦截：DeepSeek 暂不支持识图！');
    
    let cleanPath = imagePath.replace(/^file:\/{2,3}/, '');
    if (!fs.existsSync(cleanPath)) throw new Error(`找不到物理图片: ${cleanPath}`);
    
    const base64Image = fs.readFileSync(cleanPath).toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;
    
    const systemPrompt = PromptBuilder.buildVisionPrompt(); // 统一交由 Builder

    const adapter = LLMFactory.createFromConfig(config);
    // 假设底层 adapter 支持 VLM 多模态
    const response = await adapter.chat([{ role: "user", content: [ { type: "text", text: systemPrompt }, { type: "image_url", image_url: { url: dataUrl } } ] }], config.model, config.temperature);
    
    return response.success ? (response.text || '') : `视觉分析失败: ${this.translateHttpError(new Error(response.error))}`;
  }

  // ---------------------------------------------------------------------------
  // 🤖 5. Agent 终极形态 (完美接住前端配置参数)
  // ---------------------------------------------------------------------------
  public static async agentStreamChat(webContents: WebContents, projectId: string, prompt: string, context: any, history: any[] = [], provider?: string) {
    const chatRepo = new ChatHistoryRepository();
    try {
      webContents.send(IPC_CHANNELS.AGENT_STREAM_START);
      try {
        chatRepo.saveMessage(projectId, 'user', prompt);
      } catch(e: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `写入用户对话历史失败: ${e.message}`);
      }

      const config = ProviderManager.getLLMConfig('helper', provider);
      
      // =====================================================================
      // 💥 宪法级重构：代码极致整洁。数据从 Repository 拿，文案找 Builder 组装！
      // =====================================================================
      const mediaRepo = new MediaRepository();
      const agentData = mediaRepo.getAgentContextData(projectId);
      
      // 生成纯净的、已注入所有上下文的 System Prompt
      const systemPrompt = PromptBuilder.buildAgentPrompt(context, agentData);
      // =====================================================================

      const adapter = LLMFactory.createFromConfig(config);

      const tools = [
        { type: "function", function: { name: "update_shot_text", description: "修改台词", parameters: { type: "object", properties: { shotId: { type: "string" }, newText: { type: "string" } }, required: ["shotId", "newText"] } } },
        { type: "function", function: { name: "delete_shot", description: "删除镜头", parameters: { type: "object", properties: { shotId: { type: "string" } }, required: ["shotId"] } } },
        { type: "function", function: { name: "search_broll", description: "搜索素材库", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
        { type: "function", function: { name: "isolate_vocals", description: "人声提取", parameters: { type: "object", properties: { shotId: { type: "string" } }, required: ["shotId"] } } },
        {
          type: "function",
          function: {
            name: "extract_video_frames",
            description: "视频抽帧工具。警告：当调用此工具时，你必须在你的文本回复中向用户解释这三种策略（keyframe 关键帧、uniform 均匀采样、fps 固定帧率）的区别，并提醒用户可以在界面生成的卡片上修改策略。",
            parameters: {
              type: "object",
              properties: {
                mediaId: { type: "string" },
                strategy: { type: "string", enum: ["keyframe", "fps", "uniform"], description: "抽帧物理策略" },
                fps: { type: "number", description: "仅当策略为 fps 时有效，表示每秒抽取几帧，默认为 1" }
              },
              required: ["mediaId", "strategy"]
            }
          }
        }
      ];

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: prompt }
      ];

      const result = await adapter.streamChatToBrowser(webContents, messages, config.model, 0.5, IPC_CHANNELS.AGENT_STREAM_CHUNK, tools);

      if (result.toolCall) {
        webContents.send(IPC_CHANNELS.AGENT_TOOL_CALL, result.toolCall);
      }

      try {
        chatRepo.saveMessage(projectId, 'assistant', result.text, result.toolCall);
      } catch(e: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `写入Agent回复历史失败: ${e.message}`);
      }
      webContents.send(IPC_CHANNELS.AGENT_STREAM_DONE);

    } catch (error: any) {
      const friendlyMsg = this.translateHttpError(error);
      AppLogger.error(LOG_TAGS.AI_ENGINE, `Agent HTTP 异常`, error);
      webContents.send(IPC_CHANNELS.AGENT_STREAM_ERROR, friendlyMsg);
    }
  }

  // ---------------------------------------------------------------------------
  // 🛠️ 6. 本地 Python 微服务互联 (无关 LLM，保持不变)
  // ---------------------------------------------------------------------------
  static async getMediaDuration(filePath: string): Promise<number> {
    return new Promise((resolve) => {
      const ffprobeExe = PathManager.getBinPath(PathManager.getExeName('ffprobe'));
      if (!fs.existsSync(ffprobeExe)) return resolve(0);
      const child = spawn(ffprobeExe, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', filePath
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      child.on('close', () => {
        const secs = parseFloat(output.trim());
        resolve(isNaN(secs) ? 0 : secs);
      });
      child.on('error', () => resolve(0));
      ProcessManager.register(child, 'ffprobe-duration');
    });
  }

  public static async recognizeAudio(audioPath: string): Promise<string> {
    try {
      const ffmpegExe = PathManager.getBinPath(PathManager.getExeName('ffmpeg'));
      const whisperExe = PathManager.getBinPath(PathManager.getExeName('whisper-cli'));
      const modelPath = PathManager.getModelPath('whisper', 'ggml-base.bin');
      if (!fs.existsSync(whisperExe) || !fs.existsSync(modelPath)) return ENGINE_STATUS.AI_MODEL_UNDEPLOYED;
      
      const wavPath = audioPath.replace(/\.[^/.]+$/, "_16k.wav");
      let converted = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const process = spawn(ffmpegExe, ['-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath, '-y']);
          process.stderr.on('data', () => {});
          process.on('error', (err) => reject(new Error(`FFmpeg 转换失败: ${err.message}`)));
          process.on('close', (code: number) => code !== 0 ? reject(new Error(`FFmpeg退出码: ${code}`)) : resolve());
        });
        converted = true;
      } catch (err: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `音频转换失败: ${err.message}`);
        return `异常: ${err.message}`;
      }

      let stdout = '';
      try {
        stdout = await new Promise<string>((resolve, reject) => {
          let output = '';
          const process = spawn(whisperExe, ['-m', modelPath, '-f', wavPath, '-l', 'zh']);
          process.stdout.on('data', (data: Buffer) => { output += data.toString(); });
          process.stderr.on('data', () => {});
          process.on('error', (err) => reject(new Error(`Whisper 执行失败: ${err.message}`)));
          process.on('close', (code: number) => code !== 0 ? reject(new Error(`Whisper退出码: ${code}`)) : resolve(output));
        });
      } catch (err: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `Whisper 识别失败: ${err.message}`);
        return `异常: ${err.message}`;
      }

      if (converted && fs.existsSync(wavPath)) { try { fs.unlinkSync(wavPath); } catch {} }
      const lines = stdout.split('\n'); const resultLines: string[] = []; 
      for (const line of lines) {
        const match = line.match(/\[(\d{2}:\d{2}:\d{2})\.\d{3}\s*-->.*\]\s*(.*)/);
        if (match && match[2].trim() && !match[2].trim().startsWith('[')) resultLines.push(`[${match[1]}] ${match[2].trim()}`);
      }
      return resultLines.length > 0 ? resultLines.join('\n') : ENGINE_STATUS.NO_LINES_DETECTED;
    } catch (err: any) { return `异常: ${err.message}`; }
  }

  public static async searchBrollLocally(payload: { query: string, projectId: string }) {
    try {
      const res = await AIDaemon.getInstance().post('/api/clip_search', { project_id: payload.projectId, query: payload.query, top_k: 1 });
      return (res && res.success && res.data?.length > 0) ? { success: true, mediaId: res.data[0].media_id } : { success: false, error: '未检索到高匹配度画面' };
    } catch (error: any) { return { success: false, error: error.message }; }
  }

  public static async isolateVocalsLocally(_projectId: string, shotId: string) {
    try {
      const db = SQLiteConnection.getInstance().getDB();
      const shot = db.prepare('SELECT media_id, audio_path FROM shots WHERE id = ?').get(shotId) as any;
      if (!shot) throw new Error('未找到镜头');
      
      let sourcePath = shot.audio_path;
      if (!sourcePath) {
        const media = db.prepare('SELECT file_path FROM media_assets WHERE id = ?').get(shot.media_id) as any;
        if (!media) throw new Error('未找到物理素材');
        sourcePath = media.file_path;
      }
      
      const cleanPath = sourcePath.replace(/^file:{2,3}/, '');
      const res = await AIDaemon.getInstance().post('/api/isolate_vocals', { audio_path: cleanPath });
      if (!res.success) throw new Error(res.error || '提取失败');
      
      const audioPath = res.vocal_path || res.vocals_path || '';
      const newAudioUrl = audioPath ? `file://${audioPath.split('\\').join('/')}` : '';
      db.prepare('UPDATE shots SET audio_path = ? WHERE id = ?').run(newAudioUrl, shotId);
      return { success: true, audioPath: newAudioUrl };
    } catch (error: any) { return { success: false, error: error.message }; }
  }

  /**
   * 💥 工业级 L2 改造：彻底剥离数据库，纯函数化抽帧引擎
   * @param sourcePath 源视频绝对物理路径
   * @param outputDir 输出帧绝对物理目录 (由 PipelineEngine 的 Hash 机制指定)
   * @param strategy 抽帧策略
   * @param fps 帧率
   * @param threshold 场景阈值
   */
  public static async extractFramesLocally(
    sourcePath: string, 
    outputDir: string, 
    strategy: string = 'uniform', 
    fps: number = 1,
    threshold: number = 0.3
  ): Promise<{ frames: string[] }> {
    try {
      const extractor = new FrameExtractor();
      return await extractor.extract(sourcePath, outputDir, strategy, fps, threshold);
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.AI_ENGINE, `本地抽帧物理熔断: ${error.message}`, { sourcePath });
      throw error;
    }
  }

  static async enrichShotsWithAI(shots: Shot[], _audioPath: string | undefined): Promise<Shot[]> {
    AppLogger.warn(LOG_TAGS.AI_ENGINE, 'enrichShotsWithAI 被调用但未实现');
    return shots;
  }
  static async generateAiScript(_data: any): Promise<any> {
    AppLogger.warn(LOG_TAGS.AI_ENGINE, 'generateAiScript 被调用但未实现');
    return {};
  }
  static async runSingleTTS(projectId: string, shot: any): Promise<any> {
    const ttsProvider = new TTSProvider();
    const stateHash = crypto.randomBytes(4).toString('hex');
    const saveDir = PathManager.getNodeL2CacheDir(projectId, `tts-${shot.id || 'single'}`, 'audio', stateHash);

    const text = shot.text || shot.aiText || shot.narration || '';
    if (!text.trim()) {
      AppLogger.warn(LOG_TAGS.AI_ENGINE, `runSingleTTS: shot ${shot.id} 没有可合成的文本`);
      return { shotId: shot.id, audioPath: null, skipped: true };
    }

    const voiceId = shot.voiceId || undefined;

    try {
      const { path: audioPath, provider } = await ttsProvider.synthesizeWithFallback(text, saveDir, voiceId);
      AppLogger.info(LOG_TAGS.AI_ENGINE, `TTS 合成完成: shot=${shot.id}, provider=${provider}`);
      return { shotId: shot.id, audioPath, provider };
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.AI_ENGINE, `TTS 合成失败: shot=${shot.id}`, err);
      return { shotId: shot.id, audioPath: null, error: err.message };
    }
  }

  /** V1.1: 全局多角色 TTS 调度 — 按 Shot.voiceId 分配音色，支持 fallback 链 */
  static async runGlobalTTS(projectId: string, shots: any[], roles?: any[]): Promise<any[]> {
    const ttsProvider = new TTSProvider();
    const stateHash = crypto.randomBytes(4).toString('hex');
    const saveDir = PathManager.getNodeL2CacheDir(projectId, 'global-tts', 'audio', stateHash);

    const roleMap = new Map<string, any>();
    if (roles) roles.forEach(r => roleMap.set(r.id, r));

    const globalDefaultVoice = await (async () => {
      try {
        const settingsRepo = new (await import('../database/repositories/SettingsRepository')).SettingsRepository();
        return settingsRepo.get('tts.defaultVoiceId', null);
      } catch { return null; }
    })();

    const results: any[] = [];

    for (const shot of shots) {
      const text = shot.text || shot.aiText || shot.narration || '';
      if (!text.trim()) {
        results.push({ shotId: shot.id, audioPath: null, skipped: true });
        continue;
      }

      let voiceId: string | undefined = shot.voiceId || undefined;

      if (!voiceId && shot.roleId) {
        const role = roleMap.get(shot.roleId);
        if (role?.voiceId) voiceId = role.voiceId;
      }

      if (!voiceId) voiceId = globalDefaultVoice || undefined;

      try {
        const { path: audioPath, provider } = await ttsProvider.synthesizeWithFallback(text, saveDir, voiceId);
        results.push({ shotId: shot.id, audioPath, provider, voiceId });
        AppLogger.info(LOG_TAGS.AI_ENGINE, `TTS: shot=${shot.id} voice=${voiceId} provider=${provider}`);
      } catch (err: any) {
        AppLogger.error(LOG_TAGS.AI_ENGINE, `TTS 失败: shot=${shot.id}`, err);
        results.push({ shotId: shot.id, audioPath: null, error: err.message });
      }
    }

    return results;
  }
  static async chatRequest(_prompt: string, _context: any): Promise<string> {
    AppLogger.warn(LOG_TAGS.AI_ENGINE, 'chatRequest 被调用但未实现');
    return '';
  }
}
