import { HttpClient } from '../core/HttpClient'
import { CredentialManager } from '../security/CredentialManager'
import { DynamicCredentialInterceptor } from '../security/DynamicCredentialInterceptor'
import { AppLogger } from '../core/AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'

interface GatewayResponse<T = unknown> {
  success: boolean
  data?: T
  errorCode?: string
  errorMessage?: string
  /** 是否需要挂起 Pipeline 等待用户修复凭证 */
  shouldSuspend?: boolean
  /** 凭证修复指引 */
  suspendInstruction?: string
}

interface ChatMessage {
  role: string
  content: string | Array<Record<string, unknown>>
}

interface ChatRequest {
  messages: ChatMessage[]
  model: string
  temperature?: number
  max_tokens?: number
}

/**
 * Provider 网关
 * 统一管理所有外部 AI Provider 的请求：
 *  - 凭证自动注入与脱敏
 *  - 超时 / 重试 / 错误码标准化
 *  - 401/402 自动拦截 → 触发 Pipeline 挂起修复流程
 */
export class ProviderGateway {
  private static instance: ProviderGateway
  private credentialManager: CredentialManager
  private interceptor: DynamicCredentialInterceptor

  private constructor() {
    this.credentialManager = CredentialManager.getInstance()
    this.interceptor = DynamicCredentialInterceptor.getInstance()
  }

  static getInstance(): ProviderGateway {
    if (!ProviderGateway.instance) {
      ProviderGateway.instance = new ProviderGateway()
    }
    return ProviderGateway.instance
  }

  /** 代理 Chat Completions 请求 */
  async chat(
    config: {
      baseURL: string
      apiKey: string
      model: string
      temperature?: number
      provider: string
    },
    messages: ChatMessage[]
  ): Promise<GatewayResponse> {
    const client = new HttpClient({
      baseURL: config.baseURL,
      timeoutMs: 120000,
      maxRetries: 1
    })

    const maskedKey = this.credentialManager.mask(config.apiKey)
    AppLogger.info(
      LOG_TAGS.AI_ENGINE,
      `[ProviderGateway] 请求 ${config.provider}/${config.model} (Key: ${maskedKey})`
    )

    try {
      const body: ChatRequest = {
        messages,
        model: config.model,
        temperature: config.temperature ?? 0.5
      }

      const response = await client.post<{
        choices?: Array<{ message?: { content?: string } }>
        error?: { message?: string; code?: string }
      }>('/chat/completions', body)

      if (response.error) {
        return {
          success: false,
          errorCode: response.error.code || 'PROVIDER_ERROR',
          errorMessage: response.error.message || 'Provider 返回错误'
        }
      }

      const content = response.choices?.[0]?.message?.content || ''
      return { success: true, data: { text: content } }
    } catch (err: any) {
      const statusCode = this.extractStatusCode(err.message)
      const body = err.message || ''

      const intercept = this.interceptor.intercept(statusCode, body, config.provider)

      if (intercept.shouldSuspend) {
        AppLogger.warn(
          LOG_TAGS.AI_ENGINE,
          `[ProviderGateway] ${config.provider} 凭证异常，请求挂起修复`
        )
        return {
          success: false,
          errorCode: 'CREDENTIAL_ERROR',
          errorMessage: intercept.reason,
          shouldSuspend: true,
          suspendInstruction: intercept.userInstruction
        }
      }

      AppLogger.error(LOG_TAGS.AI_ENGINE, `[ProviderGateway] ${config.provider} 请求失败`, err)
      return {
        success: false,
        errorCode: 'AI_GATEWAY_ERROR',
        errorMessage: err.message || '网关请求失败'
      }
    }
  }

  /** 代理非 Chat 类请求（如 embeddings、models 列表等） */
  async proxy<T = unknown>(
    baseURL: string,
    apiKey: string,
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown
  ): Promise<GatewayResponse<T>> {
    const client = new HttpClient({
      baseURL,
      timeoutMs: 60000,
      maxRetries: 1
    })

    const maskedKey = this.credentialManager.mask(apiKey)
    AppLogger.info(LOG_TAGS.AI_ENGINE, `[ProviderGateway] ${method} ${path} (Key: ${maskedKey})`)

    try {
      const data =
        method === 'POST' ? await client.post<T>(path, body || {}) : await client.get<T>(path)

      return { success: true, data }
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.AI_ENGINE, `[ProviderGateway] 代理请求失败: ${path}`, err)
      return {
        success: false,
        errorCode: 'AI_GATEWAY_ERROR',
        errorMessage: err.message || '代理请求失败'
      }
    }
  }

  /** 验证 Provider 连通性 */
  async healthCheck(baseURL: string): Promise<boolean> {
    try {
      const client = new HttpClient({ baseURL, timeoutMs: 10000, maxRetries: 0 })
      await client.get('/models')
      return true
    } catch {
      // provider may be unreachable
      return false
    }
  }

  /** 从错误消息中提取 HTTP 状态码 */
  private extractStatusCode(message: string): number {
    const match = message.match(/HTTP\s+(\d+)/)
    return match ? parseInt(match[1], 10) : 0
  }
}
