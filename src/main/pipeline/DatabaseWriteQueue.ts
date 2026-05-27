import { AppLogger } from '../core/AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'

type QueueTask<T = void> = {
  execute: () => T
  resolve: (value: T) => void
  reject: (err: unknown) => void
  retries?: number  // 当前已重试次数
}

export class DatabaseWriteQueue {
  private static instance: DatabaseWriteQueue
  private queue: QueueTask<any>[] = []
  private processing = false
  private readonly drainMs = 5
  /** 最大重试次数 */
  private readonly maxRetries = 2
  /** 队列上限，防止内存溢出 */
  private static readonly MAX_QUEUE_SIZE = 10000

  private constructor() {}

  static getInstance(): DatabaseWriteQueue {
    if (!DatabaseWriteQueue.instance) {
      DatabaseWriteQueue.instance = new DatabaseWriteQueue()
    }
    return DatabaseWriteQueue.instance
  }

  /** 入队任务，超出上限时拒绝新任务 */
  enqueue<T>(fn: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.queue.length >= DatabaseWriteQueue.MAX_QUEUE_SIZE) {
        AppLogger.error(LOG_TAGS.DATABASE, `[WriteQueue] 队列已满 (${DatabaseWriteQueue.MAX_QUEUE_SIZE})，拒绝新任务`)
        reject(new Error('DatabaseWriteQueue 队列已满'))
        return
      }
      this.queue.push({ execute: fn, resolve, reject, retries: 0 })
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
      for (let i = 0; i < batch.length; i++) {
        const task = batch[i]
        try {
          const result = task.execute()
          task.resolve(result)
        } catch (e) {
          // 失败重试：未超过最大重试次数时重新入队
          if ((task.retries || 0) < this.maxRetries) {
            task.retries = (task.retries || 0) + 1
            this.queue.unshift(task) // 优先重试
            AppLogger.warn(LOG_TAGS.DATABASE, `[WriteQueue] 任务失败，第 ${task.retries} 次重试`)
            // 将 batch 中剩余未执行的任务重新入队，避免丢失
            for (let j = i + 1; j < batch.length; j++) {
              this.queue.unshift(batch[j])
            }
            break // 让出执行，等下次 scheduleDrain
          }
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
