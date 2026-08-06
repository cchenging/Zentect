// 📁 路径：src/main/engine/TTSEngine.ts
// 从 AIEngine.ts 拆分：语音合成中枢（5引擎 + 单镜头 + 全局多角色调度）

import { TTSProvider } from '../../modules/pipeline/step4-tts/backend/Service';
import { ProviderManager } from './config/ProviderManager';
import { synthesizeEdgeTts } from './edgeTts';
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
  public async generateTTS(text: string, provider: 'doubao' | 'edge' | 'kokoro', saveDir?: string, voiceOverride?: string, rate?: number): Promise<string> {
    const config = ProviderManager.getTTSConfig(provider);
    const targetDir = saveDir || os.tmpdir();
    let ext = 'mp3'; let audioData: Buffer;
    // 语速倍率(0.5~2.0)，默认 1.0，各引擎参数名与取值范围不同，需归一化
    const speedRate = typeof rate === 'number' && rate > 0 ? rate : 1.0;

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
          const payload = { app: { appid: config.appId.trim(), token: config.token.trim(), cluster: "volcano_tts" }, user: { uid: "zentect_studio" }, audio: { voice_type: voiceType.trim(), encoding: "mp3", speed_ratio: speedRate }, request: { reqid: crypto.randomUUID(), text: cleanedText, text_type: "plain", operation: "query" } };
          const res = await fetch('https://openspeech.bytedance.com/api/v1/tts', { method: 'POST', headers: { 'Authorization': `Bearer ${config.token.trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const json = await res.json();
          if (json.code !== 3000) throw new Error(`火山报错: ${json.message}`);
          audioData = Buffer.from(json.data, 'base64');
          break;
        }
        case 'edge': {
          const voiceType = voiceOverride || (/^[a-zA-Z0-9\s.,!?'-]+$/.test(cleanedText) ? 'en-US-JennyNeural' : 'zh-CN-XiaoxiaoNeural');
          // 微软官方 Edge TTS（免费、无需 key），替代已失效的第三方代理 api.tts.quest（实测返回 404）
          audioData = await synthesizeEdgeTts({ text: cleanedText, voice: voiceType, rate: speedRate });
          break;
        }
        case 'kokoro': {
          // 本地 Kokoro-82M 推理（ai_daemon Python 进程直接写 WAV 文件，不经 Node Buffer）
          const daemon = (await import('../core/AIDaemon')).AIDaemon.getInstance();
          if (!daemon.isOnline()) throw new Error('AI 运行时未启动，请先等待运行时就绪或检查 设置 → 健康检查');
          const port = daemon.getPort();
          const ext = 'wav';
          const filePath = path.join(targetDir, `${!saveDir ? 'tts_preview_' : 'tts_'}kokoro_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`);
          const res = await fetch(`http://127.0.0.1:${port}/api/tts/kokoro/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: cleanedText,
              voice: voiceOverride || 'zf_xiaobei',
              speed: speedRate,
              out_path: filePath,
            }),
          });
          const json = await res.json();
          if (!json?.success || !json?.audioPath) throw new Error(json?.error || 'Kokoro 合成失败');
          return json.audioPath;
        }
        default: throw new Error(`未知的 TTS: ${provider}`);
      }
      // 试听文件（saveDir 为空，保存到 os.tmpdir()）用 tts_preview_ 前缀，与合成文件 tts_ 区分，便于辨识和清理
      const filePrefix = !saveDir ? 'tts_preview_' : 'tts_';
      const fileName = `${filePrefix}${provider}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const filePath = path.join(targetDir, fileName);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(filePath, audioData);
      return filePath;
    } catch (err: any) {
      const msg = err?.message || '';
      const hint = provider === 'doubao' ? '（请在 设置 → AI → 语音合成 中检查火山引擎配置）'
        : provider === 'kokoro' ? '（请到 设置 → 健康检查 → AI 运行时依赖 安装 Kokoro 依赖）' : '';
      throw new Error(`${msg || '语音合成失败'}${hint}`);
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
    const rate = typeof shot.speechRate === 'number' && shot.speechRate > 0 ? shot.speechRate : undefined;
    // 前端透传的用户引擎选择（如 kokoro/doubao）；未指定时 synthesizeWithFallback 内部兜底 edge
    const preferredProvider: 'doubao' | 'edge' | 'kokoro' | undefined =
      shot.provider === 'doubao' || shot.provider === 'edge' || shot.provider === 'kokoro' ? shot.provider : undefined;

    try {
      const { path: audioPath, provider } = await ttsProvider.synthesizeWithFallback(text, saveDir, voiceId, rate, preferredProvider);
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
