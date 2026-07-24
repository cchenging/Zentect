// 路径: src/main/engine/media/PythonProgressSubscriber.ts
// Python 长任务进度订阅器（SSE 模式）
//
// 设计目标：
//   1. 统一接入 Node 端的 onProgress 回调链（BaseNodeStrategy.performTask 的 onProgress 参数）
//   2. 替代旧版 while 轮询：100ms 推送延迟（vs 旧版 500ms 轮询）
//   3. 按 task_id 隔离，支持并发任务（旧版全局变量会互相覆盖）
//   4. 可复用：未来 TTS/ASR 等 Python 长任务也可直接调用
//
// 依赖：Electron 内置 fetch + ReadableStream（无需额外 npm 包）

import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

/** 订阅结果 */
export interface SubscribeResult {
  /** 是否已完成（正常结束或超时） */
  done: boolean;
  /** 错误信息（若有） */
  error?: string;
}

export class PythonProgressSubscriber {
  /**
   * 订阅 Python 端的 SSE 进度流，转成 Node 端的 onProgress 回调
   *
   * @param taskId       Python 端任务 ID（由 Node 端生成并随 POST 请求传给 Python）
   * @param onProgress   Node 端的进度回调（接入 BaseNodeStrategy 的 onProgress 链）
   * @param timeoutMs    超时（默认 10 分钟，匹配 Demucs 重型模型的最长运行时间）
   * @param signal       取消信号（透传 BaseNodeStrategy 的 context.signal）
   * @returns 订阅结果（done=true 表示流结束，error 有值表示异常）
   */
  static async subscribe(
    taskId: string,
    onProgress: (pct: number, msg: string) => void,
    timeoutMs = 600000,
    signal?: AbortSignal
  ): Promise<SubscribeResult> {
    const port = AIDaemon.getInstance?.()?.getPort?.() || 34567;
    const url = `http://127.0.0.1:${port}/api/separate/stream/${taskId}`;

    AppLogger.debug(LOG_TAGS.MEDIA_ENGINE,
      `[ProgressSubscriber] 订阅 SSE 流: ${url}`);

    const startTime = Date.now();

    try {
      // fetch 原生支持 ReadableStream，Electron 内置无需额外依赖
      const res = await fetch(url, { signal });
      if (!res.ok || !res.body) {
        return { done: true, error: `SSE 连接失败: HTTP ${res.status}` };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        // 超时检查
        if (Date.now() - startTime > timeoutMs) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
            `[ProgressSubscriber] 订阅超时 (task=${taskId})`);
          return { done: true, error: 'timeout' };
        }
        // 取消信号检查
        if (signal?.aborted) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
            `[ProgressSubscriber] 订阅被取消 (task=${taskId})`);
          return { done: true, error: 'aborted' };
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后一段未结束的行

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const progress = JSON.parse(line.slice(6));
            onProgress(progress.pct || 0, progress.msg || '');
            if (progress.done) {
              AppLogger.debug(LOG_TAGS.MEDIA_ENGINE,
                `[ProgressSubscriber] 流结束 (task=${taskId})`);
              return { done: true, error: progress.error };
            }
          } catch {
            // 单行 JSON 解析失败不应中断整体订阅
          }
        }
      }
      return { done: true };
    } catch (err: any) {
      // AbortError 属于正常取消，不作为错误
      if (err?.name === 'AbortError') {
        return { done: true, error: 'aborted' };
      }
      AppLogger.error(LOG_TAGS.MEDIA_ENGINE,
        `[ProgressSubscriber] 订阅异常 (task=${taskId})`, err);
      return { done: true, error: err?.message || String(err) };
    }
  }
}
