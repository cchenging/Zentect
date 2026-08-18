// 📁 路径: src/main/utils/async.ts
// 异步工具集合：并发窗口 PromisePool + Semaphore（Daemon HTTP 限流器）
// 目的：
//   1. 给 Python 守护进程（GIL/CPU 密集）做统一并发上限窗口，避免前端同时 N 个请求涌进去把进程打爆；
//   2. 提供通用 PromisePool，用于纯 JS 侧的批量并行任务（如 N 个 ASR 定位查找）。
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

/**
 * 带并发上限的 Promise.all：同一时间最多 `concurrency` 个任务在跑，
 * 任一任务完成就立刻启动下一个，保证 CPU/IO 窗口满载。
 * 相比 `Promise.all(promises)` 能防止同时发起过多请求 / 计算把下游压垮。
 * 返回结果数组顺序与输入 tasks 顺序严格一致（即使先完成的是第 k 个）。
 */
export async function promisePool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const c = Math.max(1, Math.floor(concurrency) || 1);
  const results: T[] = new Array(tasks.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      try {
        results[idx] = await tasks[idx]();
      } catch (e: any) {
        /** 保持与 Promise.all 一致：遇到错误立即抛，但会等其他已启动任务跑完 */
        throw e;
      }
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < c && i < tasks.length; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * 计数信号量：限制某个共享资源的并发访问数。
 * 典型使用场景：AIDaemon.post 统一限流，防止 Python 守护进程因 GIL 被并发请求打爆。
 */
export class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];
  private readonly label: string;

  constructor(permits: number, label: string = 'Semaphore') {
    this.permits = Math.max(1, Math.floor(permits) || 1);
    this.label = label;
  }

  /** 获取一个许可；没有就排队等待，绝不丢请求。返回 release 函数用于归还许可。 */
  public async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.releaseOne();
      };
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.permits--;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.releaseOne();
        });
      });
    });
  }

  /** 运行一个异步函数并自动归还许可，错误也会释放。 */
  public async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 调试用：返回当前排队数量。 */
  public get queueDepth(): number { return this.queue.length; }

  private releaseOne(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      if (this.queue.length > 0) {
        AppLogger.warn(LOG_TAGS.SCHEDULER, `[${this.label}] 信号量状态异常: permits=${this.permits}, queue=${this.queue.length}`);
      }
    }
  }
}
