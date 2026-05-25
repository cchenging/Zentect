import { AppLogger } from '../core/AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'

type QueueTask<T = void> = {
  execute: () => T
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

export class DatabaseWriteQueue {
  private static instance: DatabaseWriteQueue
  private queue: QueueTask<any>[] = []
  private processing = false
  private readonly drainMs = 5

  private constructor() {}

  static getInstance(): DatabaseWriteQueue {
    if (!DatabaseWriteQueue.instance) {
      DatabaseWriteQueue.instance = new DatabaseWriteQueue()
    }
    return DatabaseWriteQueue.instance
  }

  enqueue<T>(fn: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ execute: fn, resolve, reject })
      this.scheduleDrain()
    })
  }

  private scheduleDrain(): void {
    if (this.processing) return
    this.processing = true
    setTimeout(() => this.drain(), this.drainMs)
  }

  /** 同步排水：阻塞式清空队列（用于优雅关闭） */
  flush(): void {
    this.drain();
  }

  private drain(): void {
    const batch = this.queue.splice(0)
    if (batch.length === 0) {
      this.processing = false
      return
    }

    try {
      for (const task of batch) {
        try {
          const result = task.execute()
          task.resolve(result)
        } catch (e) {
          task.reject(e)
        }
      }
    } catch (e) {
      AppLogger.error(LOG_TAGS.DATABASE, 'DatabaseWriteQueue 批量写入失败', e)
    }

    if (this.queue.length > 0) {
      this.scheduleDrain()
    } else {
      this.processing = false
    }
  }

  get pending(): number {
    return this.queue.length
  }
}
