// 📁 路径：src/main/engine/TTSEngine.ts
// 从 AIEngine.ts 拆分：语音合成中枢（5引擎 + 单镜头 + 全局多角色调度）

import { TTSProvider } from '../../modules/pipeline/step4-tts/backend/Service';
import { ProviderManager } from './config/ProviderManager';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export class TTSEngine {

  // ---------------------------------------------------------------------------
  // 🔊 语音合成中枢 (彻底消灭 SettingsRepository)
  // ---------------------------------------------------------------------------
  public async generateTTS(text: string, provider: 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss', saveDir?: string, voiceOverride?: string): Promise<string> {
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

  public async runSingleTTS(projectId: string, shot: any): Promise<any> {
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
  public async runGlobalTTS(projectId: string, shots: any[], roles?: any[]): Promise<any[]> {
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
}

export const ttsEngine = new TTSEngine();
