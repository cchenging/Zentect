interface FeedbackEvent {
  type: 'toast' | 'modal' | 'inline' | 'notification'
  level: 'info' | 'success' | 'warn' | 'error' | 'fatal'
  title: string
  message: string
  /** 操作按钮 */
  actions?: FeedbackAction[]
  /** 过期时间（毫秒），仅 toast 有效 */
  durationMs?: number
  /** 关联的 traceId */
  traceId?: string
  /** 是否为可恢复错误 */
  recoverable?: boolean
}

interface FeedbackAction {
  label: string
  /** 操作类型，用于 renderer 端路由处理 */
  intent: 'retry' | 'abort' | 'repair_config' | 'repair_credential' | 'view_logs' | 'dismiss'
  payload?: Record<string, unknown>
}

type FeedbackListener = (event: FeedbackEvent) => void

/**
 * 反馈总线
 * 统一管理 Toast / Modal / Inline Error / Notification 的事件分发，
 * 解耦 Main 进程错误与 Renderer 端 UI 表现
 */
export class FeedbackBus {
  private static instance: FeedbackBus
  private listeners = new Set<FeedbackListener>()
  private eventHistory: FeedbackEvent[] = []
  private maxHistory = 50

  private constructor() {
    // singleton
  }

  static getInstance(): FeedbackBus {
    if (!FeedbackBus.instance) {
      FeedbackBus.instance = new FeedbackBus()
    }
    return FeedbackBus.instance
  }

  /** 注册反馈监听器（通常由 renderer 端 IPCBridge 注册） */
  subscribe(listener: FeedbackListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 发送反馈事件 */
  emit(event: FeedbackEvent): void {
    this.eventHistory.push(event)
    if (this.eventHistory.length > this.maxHistory) {
      this.eventHistory.shift()
    }

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // listener 错误不应影响其他监听器
      }
    }
  }

  /** 快捷方法：Toast 消息 */
  toast(message: string, level: FeedbackEvent['level'] = 'info', durationMs = 4000): void {
    this.emit({
      type: 'toast',
      level,
      title: '',
      message,
      durationMs
    })
  }

  /** 快捷方法：Modal 弹窗 */
  modal(title: string, message: string, actions: FeedbackAction[]): void {
    this.emit({
      type: 'modal',
      level: 'warn',
      title,
      message,
      actions
    })
  }

  /** 快捷方法：Pipeline 降级提示 */
  degraded(stepName: string, reason: string): void {
    this.emit({
      type: 'inline',
      level: 'warn',
      title: `${stepName} 已降级`,
      message: reason,
      recoverable: true
    })
  }

  /** 快捷方法：配置缺失 */
  configMissing(configKey: string): void {
    this.emit({
      type: 'modal',
      level: 'error',
      title: '配置缺失',
      message: `缺少必要配置: ${configKey}。请前往全局设置补全后重试。`,
      actions: [
        { label: '前往设置', intent: 'repair_config', payload: { configKey } },
        { label: '放弃', intent: 'abort' }
      ]
    })
  }

  /** 快捷方法：凭证失效 */
  credentialExpired(provider: string, instruction: string): void {
    this.emit({
      type: 'modal',
      level: 'error',
      title: `${provider} 凭证失效`,
      message: instruction,
      recoverable: true,
      actions: [
        { label: '修复凭证', intent: 'repair_credential', payload: { provider } },
        { label: '放弃', intent: 'abort' }
      ]
    })
  }

  /** 获取历史事件 */
  getHistory(limit = 20): FeedbackEvent[] {
    return this.eventHistory.slice(-limit)
  }

  /** 清空历史 */
  clearHistory(): void {
    this.eventHistory = []
  }
}
