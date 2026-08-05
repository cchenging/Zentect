// Module: pipeline/step4-tts - TTS Service

import { ProviderManager } from '../../../../main/engine/config/ProviderManager'
import { PathManager } from '../../../../main/utils/pathManager'
import { synthesizeEdgeTts } from '../../../../main/engine/edgeTts'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { AppError, ErrorCode } from '@modules/infra/error/AppError'

export type TTSVendor = 'doubao' | 'edge'

export class TTSProvider {
  /** fallback 链 — 当前仅保留默认引擎 Edge */
  async synthesizeWithFallback(
    text: string,
    saveDir?: string,
    voiceOverride?: string,
    rate?: number
  ): Promise<{ path: string; provider: TTSVendor }> {
    const fallbackChain: TTSVendor[] = ['edge'];
    let lastError: Error | null = null;

    for (const provider of fallbackChain) {
      try {
        const audioPath = await this.synthesize(text, provider, saveDir, voiceOverride, rate);
        return { path: audioPath, provider };
      } catch (err: any) {
        lastError = err;
        continue;
      }
    }

    throw new AppError(ErrorCode.AI_PROCESS_FAILED, `所有 TTS 引擎均失败，最后错误: ${lastError?.message}`);
  }

  /**
   * 语音合成 — 从 AIEngine.generateTTS 拆出独立能力
   * @param text          合成文本
   * @param provider      合成引擎
   * @param saveDir       保存目录 (默认项目目录下的 tts_output)
   * @param voiceOverride 覆写音色 (角色/voice type)
   * @param rate 语速倍率 (0.5~2.0)，默认 1.0
   * @returns 音频文件绝对路径
   */
  async synthesize(
    text: string,
    provider: TTSVendor,
    saveDir?: string,
    voiceOverride?: string,
    rate?: number
  ): Promise<string> {
    const config = ProviderManager.getTTSConfig(provider)
    const targetDir = saveDir || PathManager.getTTSOutputDir()
    // 语速倍率归一化，默认 1.0
    const speedRate = typeof rate === 'number' && rate > 0 ? rate : 1.0

    // 统一清洗文本，去除 LLM 生成的舞台指示标记
    const cleanedText = text
      .replace(/[【】\[\]\(\)（）「」『』]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    /** 缓存查找：相同清洗后文本+引擎+音色+语速 的合成结果直接复用 */
    const voiceKey = voiceOverride || config.voice || 'default'
    const cacheHash = crypto.createHash('md5').update(`${cleanedText}|${provider}|${voiceKey}|${speedRate}`).digest('hex').substring(0, 12)
    const ext = 'mp3'
    const cachedFile = path.join(targetDir, `tts_${provider}_${voiceKey}_${cacheHash}.${ext}`)
    if (fs.existsSync(cachedFile)) {
      return cachedFile
    }

    let audioData: Buffer

    try {
      switch (provider) {
        case 'doubao': {
          if (!config.appId || !config.token) {
            throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, '火山 TTS 未配置。请在 设置 → AI → 语音合成 中填写 AppID 和 Token。')
          }
          const voiceType = voiceOverride || config.voice || 'zh_female_meilinvyou_saturn_bigtts'
          const payload = {
            app: { appid: config.appId.trim(), token: config.token.trim(), cluster: 'volcano_tts' },
            user: { uid: 'zentect_studio' },
            audio: { voice_type: voiceType.trim(), encoding: 'mp3', speed_ratio: speedRate },
            request: { reqid: crypto.randomUUID(), text: cleanedText, text_type: 'plain', operation: 'query' }
          }
          const res = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.token.trim()}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          })
          const json: any = await res.json()
          if (json.code !== 3000) throw new AppError(ErrorCode.AI_PROCESS_FAILED, `火山报错: ${json.message}`)
          audioData = Buffer.from(json.data, 'base64')
          break
        }
        case 'edge': {
          const voiceType =
            voiceOverride ||
            (/^[a-zA-Z0-9\s.,!?'-]+$/.test(cleanedText) ? 'en-US-JennyNeural' : 'zh-CN-XiaoxiaoNeural')
          // 微软官方 Edge TTS（免费、无需 key），替代已失效的第三方代理 api.tts.quest（实测返回 404）
          audioData = await synthesizeEdgeTts({ text: cleanedText, voice: voiceType, rate: speedRate })
          break
        }
        default:
          throw new AppError(ErrorCode.SYS_ENV_ERROR, `未知的 TTS 引擎: ${provider}`)
      }

      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(cachedFile, audioData)
      return cachedFile
    } catch (err: any) {
      const msg = err?.message || '';
      const hints: Record<string, string> = {
        doubao: '（请在 设置 → AI → 语音合成 中检查火山引擎配置）',
        edge: ''
      }
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, `${msg || '语音合成失败'}${hints[provider] || ''}`)
    }
  }
}
