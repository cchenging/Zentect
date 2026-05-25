import { HttpClient } from '../core/HttpClient'
import { AppLogger } from '../core/AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'

interface VoiceItem {
  id: string
  name: string
}

export class LocalAiGateway {
  private static instance: LocalAiGateway
  private http: HttpClient

  private constructor() {
    this.http = new HttpClient({
      baseURL: 'http://127.0.0.1:9882',
      timeoutMs: 5000,
      maxRetries: 1
    })
  }

  static getInstance(): LocalAiGateway {
    if (!LocalAiGateway.instance) {
      LocalAiGateway.instance = new LocalAiGateway()
    }
    return LocalAiGateway.instance
  }

  /** 获取已克隆的音色列表 — 原 renderer fetch(127.0.0.1:9882/voices) */
  async getClonedVoices(): Promise<{ code: number; voices: VoiceItem[] }> {
    try {
      const result = await this.http.get<{ code: number; voices: VoiceItem[] }>('/voices')
      AppLogger.info(LOG_TAGS.AI_ENGINE, `获取克隆音色列表: ${result?.voices?.length || 0} 条`)
      return result
    } catch (err) {
      AppLogger.error(LOG_TAGS.AI_ENGINE, '获取克隆音色失败', err)
      return { code: -1, voices: [] }
    }
  }

  /** 删除克隆音色 — 原 renderer fetch(127.0.0.1:9882/delete) */
  async deleteClonedVoice(cloneId: string): Promise<{ code: number; message?: string }> {
    try {
      const result = await this.http.post<{ code: number; message?: string }>('/delete', {
        clone_id: cloneId
      })
      AppLogger.info(LOG_TAGS.AI_ENGINE, `删除克隆音色: ${cloneId}`)
      return result
    } catch (err) {
      AppLogger.error(LOG_TAGS.AI_ENGINE, '删除克隆音色失败', err)
      return { code: -1, message: '删除失败' }
    }
  }

  /** 代理 TTS 调用 — 避免多 baseURL 散落 */
  async ttsRequest<T = any>(url: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    try {
      const client = new HttpClient({ timeoutMs: 30000, maxRetries: 1 })
      if (method === 'POST') {
        return client.post<T>(url, body || {})
      }
      return client.get<T>(url)
    } catch (err) {
      AppLogger.error(LOG_TAGS.AI_ENGINE, `TTS 请求失败 [${method} ${url}]`, err)
      throw err
    }
  }
}
