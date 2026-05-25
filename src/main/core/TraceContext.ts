import { randomUUID } from 'crypto'

interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  operation: string
  startTime: number
  endTime?: number
  tags: Record<string, string>
}

/**
 * 追踪上下文
 * 为每次 IPC 调用、Pipeline 执行、API 请求分配唯一 traceId，
 * 贯穿 Renderer → IPC → Main → Python runtime 全链路
 */
export class TraceContext {
  private static currentTraceId: string | null = null
  private static activeSpans = new Map<string, TraceSpan>()

  /** 生成新的追踪 ID 并设为当前上下文 */
  static startTrace(operation: string, tags: Record<string, string> = {}): string {
    const traceId = randomUUID()
    this.currentTraceId = traceId

    const span: TraceSpan = {
      traceId,
      spanId: randomUUID(),
      operation,
      startTime: Date.now(),
      tags
    }

    this.activeSpans.set(span.spanId, span)
    return traceId
  }

  /** 结束当前追踪 */
  static endTrace(): void {
    if (!this.currentTraceId) return

    for (const span of this.activeSpans.values()) {
      if (span.traceId === this.currentTraceId && !span.endTime) {
        span.endTime = Date.now()
      }
    }

    this.currentTraceId = null
  }

  /** 获取当前追踪 ID */
  static getTraceId(): string | null {
    return this.currentTraceId
  }

  /** 在追踪中创建子 Span */
  static startSpan(operation: string, tags: Record<string, string> = {}): string {
    const parentTraceId = this.currentTraceId
    if (!parentTraceId) return ''

    const span: TraceSpan = {
      traceId: parentTraceId,
      spanId: randomUUID(),
      parentSpanId: this.findActiveSpanId(parentTraceId),
      operation,
      startTime: Date.now(),
      tags
    }

    this.activeSpans.set(span.spanId, span)
    return span.spanId
  }

  /** 结束指定 Span */
  static endSpan(spanId: string): void {
    const span = this.activeSpans.get(spanId)
    if (span) {
      span.endTime = Date.now()
    }
  }

  /** 获取指定 Span 的耗时（毫秒） */
  static getSpanDuration(spanId: string): number {
    const span = this.activeSpans.get(spanId)
    if (!span || !span.endTime) return -1
    return span.endTime - span.startTime
  }

  /** 为日志添加追踪前缀 */
  static enrichLog(message: string): string {
    const traceId = this.currentTraceId
    if (!traceId) return message
    const shortId = traceId.slice(0, 8)
    return `[trace:${shortId}] ${message}`
  }

  private static findActiveSpanId(traceId: string): string | undefined {
    for (const span of this.activeSpans.values()) {
      if (span.traceId === traceId && !span.endTime) {
        return span.spanId
      }
    }
    return undefined
  }
}
