import { ProviderManager } from '../config/ProviderManager'
import { PathManager } from '../../utils/pathManager'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

export type TTSVendor = 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss'

export class TTSProvider {
  /** V1.1: TTS 男主角 fallback 链 — Edge → MOSS → Fish Audio 逐级降级 */
  async synthesizeWithFallback(
    text: string,
    saveDir?: string,
    voiceOverride?: string
  ): Promise<{ path: string; provider: TTSVendor }> {
    const fallbackChain: TTSVendor[] = ['edge', 'moss', 'fish'];
    let lastError: Error | null = null;

    for (const provider of fallbackChain) {
      try {
        const audioPath = await this.synthesize(text, provider, saveDir, voiceOverride);
        return { path: audioPath, provider };
      } catch (err: any) {
        lastError = err;
        continue;
      }
    }

    throw new Error(`所有 TTS 引擎均失败，最后错误: ${lastError?.message}`);
  }

  /**
   * 语音合成 — 从 AIEngine.generateTTS 拆出独立能力
   * @param text          合成文本
   * @param provider      合成引擎
   * @param saveDir       保存目录 (默认项目目录下的 tts_output)
   * @param voiceOverride 覆写音色 (角色/voice type)
   * @returns 音频文件绝对路径
   */
  async synthesize(
    text: string,
    provider: TTSVendor,
    saveDir?: string,
    voiceOverride?: string
  ): Promise<string> {
    const config = ProviderManager.getTTSConfig(provider)
    const targetDir = saveDir || PathManager.getTTSOutputDir()

    /** 缓存查找：相同文本+引擎+音色 的合成结果直接复用 */
    const voiceKey = voiceOverride || config.voice || 'default'
    const cacheHash = crypto.createHash('md5').update(`${text}|${provider}|${voiceKey}`).digest('hex').substring(0, 12)
    const ext = provider === 'moss' || provider === 'sovits' ? 'wav' : 'mp3'
    const cachedFile = path.join(targetDir, `tts_${provider}_${voiceKey}_${cacheHash}.${ext}`)
    if (fs.existsSync(cachedFile)) {
      return cachedFile
    }

    let audioData: Buffer

    try {
      switch (provider) {
        case 'doubao': {
          if (!config.appId || !config.token) {
            throw new Error('火山 TTS 未配置。请在 设置 → AI → 语音合成 中填写 AppID 和 Token。')
          }
          const voiceType = voiceOverride || config.voice || 'zh_female_meilinvyou_saturn_bigtts'
          const payload = {
            app: { appid: config.appId.trim(), token: config.token.trim(), cluster: 'volcano_tts' },
            user: { uid: 'zentect_studio' },
            audio: { voice_type: voiceType.trim(), encoding: 'mp3' },
            request: { reqid: crypto.randomUUID(), text, text_type: 'plain', operation: 'query' }
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
          if (json.code !== 3000) throw new Error(`火山报错: ${json.message}`)
          audioData = Buffer.from(json.data, 'base64')
          break
        }
        case 'edge': {
          const voiceType =
            voiceOverride ||
            (/^[a-zA-Z0-9\s.,!?'-]+$/.test(text) ? 'en-US-JennyNeural' : 'zh-CN-XiaoxiaoNeural')
          const res = await fetch('https://api.tts.quest/v3/voicemaker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: voiceType, format: 'mp3' })
          })
          const data: any = await res.json()
          if (!data.data?.audio_url) throw new Error('Edge TTS 繁忙')
          const audioRes = await fetch(data.data.audio_url)
          audioData = Buffer.from(await audioRes.arrayBuffer())
          break
        }
        case 'fish': {
          if (!config.apiKey) throw new Error('未配置 Fish Audio Key')
          const payload: any = { text }
          if (voiceOverride) payload.reference_id = voiceOverride
          const res = await fetch('https://api.fish.audio/v1/tts', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          })
          if (!res.ok) throw new Error(`Fish Audio 异常: ${await res.text()}`)
          audioData = Buffer.from(await res.arrayBuffer())
          break
        }
        case 'sovits': {
          const url = new URL(config.url || 'http://127.0.0.1:9880')
          url.searchParams.append('text', text)
          url.searchParams.append('text_language', 'zh')
          if (voiceOverride) url.searchParams.append('character', voiceOverride)
          const res = await fetch(url.toString())
          if (!res.ok) throw new Error(`SoVITS 异常: ${res.statusText}`)
          audioData = Buffer.from(await res.arrayBuffer())
          break
        }
        case 'moss': {
          const mossUrl = config.mossUrl || 'http://127.0.0.1:9881'
          const voiceType = voiceOverride || 'Junhao'
          const res = await fetch(`${mossUrl}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: voiceType, speed: 1.0 })
          })
          if (!res.ok) throw new Error(`MOSS-TTS 异常: ${await res.text()}`)
          const json: any = await res.json()
          if (json.code !== 0) throw new Error(`MOSS-TTS 错误: ${json.message}`)
          audioData = Buffer.from(json.audio, 'hex')
          break
        }
        default:
          throw new Error(`未知的 TTS 引擎: ${provider}`)
      }

      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(cachedFile, audioData)
      return cachedFile
    } catch (err: any) {
      const hints: Record<string, string> = {
        doubao: '（请在 设置 → AI → 语音合成 中检查火山引擎配置）',
        fish: '（请在 设置 → AI → 语音合成 中检查 Fish Audio Key）',
        sovits: '（请确认本地 GPT-SoVITS 服务已启动，默认端口 9880）',
        moss: '（请确认 MOSS-TTS-Nano 模型已下载，或切换到 Edge 免费引擎）',
        edge: ''
      }
      throw new Error(`${err.message || '语音合成失败'}${hints[provider] || ''}`)
    }
  }
}
