import { AppLogger } from '../core/AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'

interface InterceptResult {
  /** 是否需要挂起 Pipeline 等待用户修复凭证 */
  shouldSuspend: boolean
  /** 凭证错误原因 */
  reason: string
  /** 面向用户的修复指引 */
  userInstruction: string
  /** 出问题的 Provider */
  provider: string
}

/**
 * 动态凭证拦截器
 * 拦截外部 AI Provider 的 401/402 等凭证错误，
 * 触发 Pipeline 挂起 + 引导用户修复，而不是直接失败
 */
export class DynamicCredentialInterceptor {
  private static instance: DynamicCredentialInterceptor

  private constructor() {
    // singleton
  }

  static getInstance(): DynamicCredentialInterceptor {
    if (!DynamicCredentialInterceptor.instance) {
      DynamicCredentialInterceptor.instance = new DynamicCredentialInterceptor()
    }
    return DynamicCredentialInterceptor.instance
  }

  /** 检测 HTTP 响应是否为凭证错误 */
  intercept(httpStatus: number, responseBody: string, provider: string): InterceptResult {
    const reason = this.detectCredentialError(httpStatus, responseBody, provider)
    const shouldSuspend = reason !== null

    if (shouldSuspend) {
      AppLogger.warn(
        LOG_TAGS.AI_ENGINE,
        `[CredentialInterceptor] 检测到 ${provider} 凭证错误: ${reason}`
      )
    }

    return {
      shouldSuspend,
      reason: reason || '',
      userInstruction: reason ? this.getRepairInstructions(provider, reason) : '',
      provider
    }
  }

  /** 匹配已知的凭证错误模式 */
  private detectCredentialError(httpStatus: number, body: string, provider: string): string | null {
    if (httpStatus === 401) {
      return `${provider} API Key 无效或已过期`
    }

    if (httpStatus === 402) {
      return `${provider} 账户余额不足`
    }

    if (httpStatus === 403) {
      if (body.includes('billing') || body.includes('quota')) {
        return `${provider} 配额已用尽`
      }
      if (body.includes('region') || body.includes('geo')) {
        return `${provider} 地区限制，当前区域不可用`
      }
      return `${provider} 访问被拒绝，请检查 API Key 权限`
    }

    if (httpStatus === 429) {
      return `${provider} 请求频率超限，请稍后重试`
    }

    const lowerBody = body.toLowerCase()
    if (lowerBody.includes('invalid_api_key') || lowerBody.includes('invalid key')) {
      return `${provider} API Key 格式错误`
    }
    if (lowerBody.includes('insufficient_quota') || lowerBody.includes('exceeded')) {
      return `${provider} 额度已耗尽`
    }
    if (lowerBody.includes('account_deactivated')) {
      return `${provider} 账户已被停用`
    }

    return null
  }

  /** 生成面向用户的中文修复指引 */
  private getRepairInstructions(provider: string, reason: string): string {
    const providerLabel = this.getProviderLabel(provider)
    const settingPath = this.getSettingPath(provider)

    return [
      `检测到 ${providerLabel} 凭证异常：${reason}`,
      ``,
      `请前往 [全局设置] → [${settingPath}] 更新配置：`,
      `  1. 检查 API Key 是否正确且未过期`,
      `  2. 确认账户余额充足`,
      `  3. 如使用中转代理，确认代理地址可达`,
      ``,
      `修复后点击"重试"即可继续当前任务。`
    ].join('\n')
  }

  private getProviderLabel(provider: string): string {
    const labels: Record<string, string> = {
      deepseek: 'DeepSeek',
      qwen: '通义千问',
      doubao: '豆包',
      proxy: 'OpenAI 协议中转',
      openai: 'OpenAI'
    }
    return labels[provider] || provider
  }

  private getSettingPath(provider: string): string {
    const paths: Record<string, string> = {
      deepseek: 'DeepSeek 配置',
      qwen: '通义千问配置',
      doubao: '豆包配置',
      proxy: 'OpenAI 中转配置',
      openai: 'OpenAI 配置'
    }
    return paths[provider] || `${provider} 配置`
  }
}
