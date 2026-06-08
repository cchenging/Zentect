import { DatabaseWriteQueue } from './DatabaseWriteQueue'
import { AppLogger } from '../core/AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'

interface BatchEntry<T> {
  key: string
  data: T
  coalesce?: (existing: T, incoming: T) => T
}

export class DBWriteBatcher<T> {
  private queue = DatabaseWriteQueue.getInstance()
  private buffer = new Map<string, BatchEntry<T>>()
  private readonly batchMs: number
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly label: string

  constructor(label: string, batchMs = 50) {
    this.label = label
    this.batchMs = batchMs
  }

  enqueue(key: string, data: T, coalesce?: (existing: T, incoming: T) => T): void {
    const existing = this.buffer.get(key)
    if (existing && coalesce) {
      existing.data = coalesce(existing.data, data)
    } else {
      this.buffer.set(key, { key, data, coalesce })
    }

    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), this.batchMs)
  }

  private async flush(): Promise<void> {
    const entries = Array.from(this.buffer.values())
    this.buffer.clear()
    this.flushTimer = null

    if (entries.length === 0) return

    try {
      await this.queue.enqueue(() => entries)
      AppLogger.info(LOG_TAGS.DATABASE, `[${this.label}] 批量写入 ${entries.length} 条记录`)
    } catch (err) {
      AppLogger.error(LOG_TAGS.DATABASE, `[${this.label}] 批量写入失败`, err)
    }
  }

  async forceFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  get bufferedCount(): number {
    return this.buffer.size
  }

  destroy(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.buffer.clear()
  }
}
