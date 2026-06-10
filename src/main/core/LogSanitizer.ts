import { SENSITIVE_CONFIG_KEYS } from '../../shared/config/keys'

interface SanitizeRule {
  /** 匹配模式 */
  pattern: RegExp
  /** 替换文本 */
  replacement: string
  /** 规则描述 */
  label: string
}

/**
 * 日志脱敏工具
 * 在日志输出前自动脱敏 API Key、密码、Token 等敏感字段，
 * 防止凭证泄露到本地日志文件或远程上报
 */
export class LogSanitizer {
  private static rules: SanitizeRule[] = [
    {
      pattern:
        /(api[_-]?key|apikey|api_key|secret[_-]?key|access[_-]?token|bearer)\s*[:=]\s*["']?([a-zA-Z0-9_\-.]{8,})["']?/gi,
      replacement: '$1: "****"',
      label: 'API Key / Token'
    },
    {
      pattern: /(sk-[a-zA-Z0-9]{20,})/g,
      replacement: 'sk-****',
      label: 'OpenAI API Key'
    },
    {
      pattern: /(Authorization:\s*Bearer\s+)[a-zA-Z0-9_\-.]{8,}/gi,
      replacement: '$1****',
      label: 'Authorization Header'
    },
    {
      pattern: /(password|passwd|pwd)\s*[:=]\s*["']?[^"'\s,}]+["']?/gi,
      replacement: '$1: "****"',
      label: 'Password'
    },
    {
      pattern: /"apiKey"\s*:\s*"[^"]+"/g,
      replacement: '"apiKey": "****"',
      label: 'JSON apiKey'
    },
    {
      pattern: /"token"\s*:\s*"[^"]+"/g,
      replacement: '"token": "****"',
      label: 'JSON token'
    }
  ]

  /** 脱敏字符串 */
  static sanitize(text: string): string {
    if (typeof text !== 'string') return String(text ?? '');
    let result = text

    for (const rule of this.rules) {
      result = result.replace(rule.pattern, rule.replacement)
    }

    return result
  }

  /** 脱敏对象（递归处理所有字符串属性） */
  static sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_CONFIG_KEYS.includes(key as any)) {
        sanitized[key] = '****'
        continue
      }

      if (typeof value === 'string') {
        sanitized[key] = this.sanitize(value)
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        sanitized[key] = this.sanitizeObject(value as Record<string, unknown>)
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map((v) =>
          typeof v === 'string'
            ? this.sanitize(v)
            : typeof v === 'object' && v !== null
              ? this.sanitizeObject(v as Record<string, unknown>)
              : v
        )
      } else {
        sanitized[key] = value
      }
    }

    return sanitized
  }

  /** 脱敏 URL（隐藏 query 参数中的敏感值） */
  static sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url)
      const sensitiveParams = ['key', 'token', 'api_key', 'apikey', 'secret', 'password']

      for (const param of sensitiveParams) {
        if (parsed.searchParams.has(param)) {
          parsed.searchParams.set(param, '****')
        }
      }

      return parsed.toString()
    } catch {
      return this.sanitize(url)
    }
  }
}
