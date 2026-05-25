import { AppLogger } from './AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'

interface HttpClientConfig {
  baseURL?: string
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

export class HttpClient {
  private config: Required<HttpClientConfig>

  constructor(config: HttpClientConfig = {}) {
    this.config = {
      baseURL: config.baseURL || '',
      timeoutMs: config.timeoutMs || 60000,
      maxRetries: config.maxRetries || 2,
      retryDelayMs: config.retryDelayMs || 1000
    }
  }

  /** 带超时/重试/AgorController 的 POST 请求 */
  async post<T = any>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path)
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        })

        clearTimeout(timer)
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}: ${text}`)
        }
        return (await res.json()) as T
      } catch (err: any) {
        clearTimeout(timer)
        lastError = err
        if (err.name === 'AbortError') {
          lastError = new Error(`请求超时 (${this.config.timeoutMs}ms): ${path}`)
        }
        if (attempt < this.config.maxRetries) {
          AppLogger.warn(
            LOG_TAGS.SYSTEM,
            `HttpClient 重试 ${attempt + 1}/${this.config.maxRetries}: ${path}`
          )
          await new Promise((r) => setTimeout(r, this.config.retryDelayMs * (attempt + 1)))
        }
      }
    }

    throw lastError || new Error(`HTTP 请求完全失败: ${path}`)
  }

  /** 带超时/重试的 GET 请求 */
  async get<T = any>(path: string): Promise<T> {
    const url = this.buildUrl(path)
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)

      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal
        })

        clearTimeout(timer)
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}: ${text}`)
        }
        return (await res.json()) as T
      } catch (err: any) {
        clearTimeout(timer)
        lastError = err
        if (err.name === 'AbortError') {
          lastError = new Error(`请求超时 (${this.config.timeoutMs}ms): ${path}`)
        }
        if (attempt < this.config.maxRetries) {
          AppLogger.warn(
            LOG_TAGS.SYSTEM,
            `HttpClient 重试 ${attempt + 1}/${this.config.maxRetries}: ${path}`
          )
          await new Promise((r) => setTimeout(r, this.config.retryDelayMs * (attempt + 1)))
        }
      }
    }

    throw lastError || new Error(`HTTP GET 请求完全失败: ${path}`)
  }

  private buildUrl(path: string): string {
    if (path.startsWith('http')) return path
    const base = this.config.baseURL.replace(/\/$/, '')
    return `${base}${path.startsWith('/') ? path : '/' + path}`
  }
}
