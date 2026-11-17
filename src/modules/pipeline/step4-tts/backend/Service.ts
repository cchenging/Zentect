// Module: pipeline/step4-tts - TTS Service

import { ProviderManager } from '../../../../main/engine/config/ProviderManager'
import { PathManager } from '../../../../main/utils/pathManager'
import { synthesizeEdgeTts } from '../../../../main/engine/edgeTts'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { AppError, ErrorCode } from '@modules/infra/error/AppError'
import { clampPauseMs } from '../../../../shared/types/entities/stylePack'
import { AudioProcessor } from '../../../../main/engine/media/AudioProcessor'

export type TTSVendor = 'doubao' | 'edge' | 'kokoro'

/** 情绪韵律 / 响度统一扩展参数（两条合成路径共用，保证缓存键与产物口径一致） */
export interface TtsSynthesizeExtras {
  /** 情绪音高偏移（Hz，仅 Edge 生效） */
  pitchHz?: number
  /** 是否对终态音频做 loudnorm 响度统一（解说段 TTS） */
  loudnessNorm?: boolean
}

/**
 * 判断错误消息是否为"网络/连接中断"类错误。
 *
 * 这类错误（如 fetch failed、连接被重置、守护进程重启导致连接断开）是因为
 * AI 运行时进程被中断/重启，而非依赖缺失。将其与"依赖未安装"区分开，
 * 避免在错误提示中误导用户去安装 Kokoro 依赖。
 */
export function isConnectionInterruptedError(msg: string | undefined): boolean {
  const m = msg || '';
  return (
    m.includes('fetch failed') ||
    m.includes('Failed to fetch') ||
    m.includes('Network Error') ||
    m.includes('ECONNRESET') ||
    m.includes('ECONNREFUSED') ||
    m.includes('ETIMEDOUT') ||
    m.includes('连接被重置') ||
    m.includes('连接被拒绝') ||
    m.includes('远程主机强迫关闭') ||
    m.includes('socket hang up') ||
    m.includes('守护进程')
  )
}

export class TTSProvider {
  /**
   * 按引擎优先级合成（支持首选引擎）
   * @param preferredProvider 用户明确选择的引擎；指定时只走该引擎（错就错，不静默回退掩盖失败），未指定时兜底默认引擎 edge
   */
  async synthesizeWithFallback(
    text: string,
    saveDir?: string,
    voiceOverride?: string,
    rate?: number,
    preferredProvider?: TTSVendor,
    pauseMs?: number,
    extras?: TtsSynthesizeExtras
  ): Promise<{ path: string; provider: TTSVendor }> {
    // 用户指定引擎 → 只用该引擎（失败即抛错暴露）；未指定 → edge 兜底（历史默认，免费无需配置）
    const fallbackChain: TTSVendor[] = preferredProvider ? [preferredProvider] : ['edge'];
    let lastError: Error | null = null;

    for (const provider of fallbackChain) {
      try {
        const audioPath = await this.synthesize(text, provider, saveDir, voiceOverride, rate, pauseMs, extras);
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
   * @param pauseMs 句尾停顿（ms），仅 Edge 生效；参与缓存键，改停顿不会命中旧音频
   * @returns 音频文件绝对路径
   */
  async synthesize(
    text: string,
    provider: TTSVendor,
    saveDir?: string,
    voiceOverride?: string,
    rate?: number,
    pauseMs?: number,
    extras?: TtsSynthesizeExtras
  ): Promise<string> {
    const config = ProviderManager.getTTSConfig(provider)
    const targetDir = saveDir || PathManager.getTTSOutputDir()
    // 语速倍率归一化，默认 1.0
    const speedRate = typeof rate === 'number' && rate > 0 ? rate : 1.0
    // 句尾停顿归一化（0~400ms 整数），仅 Edge 消费
    const pause = typeof pauseMs === 'number' ? clampPauseMs(pauseMs) : 0
    // 🎭 情绪音高（Hz，仅 Edge 消费）与响度统一开关
    const pitchHz = Math.round(typeof extras?.pitchHz === 'number' ? extras.pitchHz : 0)
    const loudnessNorm = extras?.loudnessNorm === true

    // 统一清洗文本，去除 LLM 生成的舞台指示标记
    const cleanedText = text
      .replace(/[【】\[\]\(\)（）「」『』]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    /** 缓存查找：相同清洗后文本+引擎+音色+语速+停顿+音高+响度口径 的合成结果直接复用 */
    const voiceKey = voiceOverride || config.voice || 'default'
    const cacheHash = crypto
      .createHash('md5')
      .update(`${cleanedText}|${provider}|${voiceKey}|${speedRate}|p${pause}|hz${pitchHz}|${loudnessNorm ? 'ln16' : 'raw'}`)
      .digest('hex')
      .substring(0, 12)
    // 引擎扩展名：本地 Kokoro 输出 24kHz WAV，在线引擎输出 MP3
    const ext = provider === 'kokoro' ? 'wav' : 'mp3'
    const cachedFile = path.join(targetDir, `tts_${provider}_${voiceKey}_${cacheHash}.${ext}`)
    if (fs.existsSync(cachedFile)) {
      return cachedFile
    }

    let audioData: Buffer
    // 响度统一开启时：原始合成音频先落 raw 临时文件，loudnorm 后再写终态缓存文件
    const rawTarget = loudnessNorm ? path.join(targetDir, `tts_raw_${cacheHash}.${ext}`) : cachedFile
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })

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
          // 注意：句尾停顿不走 SSML（微软会掐断），由 Strategy 的 trimAudioEdges(tailPadMs) 在音频层补
          // 🎭 情绪音高：仅 Edge 支持 prosody pitch（火山/Kokoro 本轮不传，见设计方案 D3）
          audioData = await synthesizeEdgeTts({ text: cleanedText, voice: voiceType, rate: speedRate, pitchHz })
          break
        }
        case 'kokoro': {
          // 本地 Kokoro-82M 推理：ai_daemon Python 进程直接写 WAV 到缓存路径
          const daemon = (await import('../../../../main/core/AIDaemon')).AIDaemon.getInstance()
          if (!daemon.isOnline()) {
            throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, 'AI 运行时未启动，请先等待运行时就绪或检查 设置 → 健康检查')
          }
          const port = daemon.getPort()
          const res = await fetch(`http://127.0.0.1:${port}/api/tts/kokoro/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: cleanedText,
              voice: voiceOverride || 'zf_xiaobei',
              speed: speedRate,
              out_path: rawTarget,
            }),
          })
          const json: any = await res.json()
          if (!json?.success || !json?.audioPath) {
            throw new AppError(ErrorCode.AI_PROCESS_FAILED, json?.error || 'Kokoro 合成失败')
          }
          // Python 端已写盘；未开响度统一时 rawTarget 即终态缓存文件
          if (!loudnessNorm) return cachedFile
          return await TTSProvider._applyLoudness(rawTarget, cachedFile)
        }
        default:
          throw new AppError(ErrorCode.SYS_ENV_ERROR, `未知的 TTS 引擎: ${provider}`)
      }

      if (!loudnessNorm) {
        fs.writeFileSync(cachedFile, audioData)
        return cachedFile
      }
      // 响度统一：原始音频落 raw → loudnorm → 终态缓存文件（保持源采样率/声道）
      fs.writeFileSync(rawTarget, audioData)
      return await TTSProvider._applyLoudness(rawTarget, cachedFile)
    } catch (err: any) {
      const msg = err?.message || '';
      // 网络/连接中断类错误（如守护进程被重启导致 fetch failed）≠ 依赖缺失，不能误提示装依赖
      if (isConnectionInterruptedError(msg)) {
        throw new AppError(ErrorCode.AI_PROCESS_FAILED, `${msg || '语音合成失败'}（语音服务连接中断或服务端拒绝连接，请检查网络后重试）`)
      }
      const hints: Record<string, string> = {
        doubao: '（请在 设置 → AI → 语音合成 中检查火山引擎配置）',
        edge: '',
        kokoro: '（请到 设置 → 健康检查 → AI 运行时依赖 安装 Kokoro 依赖）',
      }
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, `${msg || '语音合成失败'}${hints[provider] || ''}`)
    }
  }

  /**
   * 响度统一：raw 合成音频 → loudnorm → 终态缓存文件，随后清理 raw 临时文件。
   * 失败直接抛错（错就错），不返回未标准化的 raw 掩盖 ffmpeg 异常。
   */
  private static async _applyLoudness(rawPath: string, outputPath: string): Promise<string> {
    try {
      await AudioProcessor.normalizeLoudness(rawPath, outputPath)
      return outputPath
    } finally {
      try { fs.unlinkSync(rawPath) } catch { /* raw 临时文件清理失败不影响终态产物 */ }
    }
  }
}
