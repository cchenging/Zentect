// 路径: src/main/engine/PythonClient.ts
// 统一封装 Node 端调用 Python 微服务的通用逻辑：
//   1. 端口获取（从 AIDaemon 单例）
//   2. URL 构建
//   3. 同步 POST 调用 + 响应解析
//   4. 异步 POST 触发 + SSE 订阅（fire-and-forget 长任务模式）
// 消除 VisionProcessor / AudioProcessor / LocalWhisperStrategy / JobScheduler
// 中各自重复的 URL 拼接、端口获取、错误处理逻辑。

import { AIDaemon } from '../core/AIDaemon';
import { HttpClient } from '../core/HttpClient';
import { PythonProgressSubscriber } from './media/PythonProgressSubscriber';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';

export class PythonClient {
  private static instance: PythonClient;
  private httpClient: HttpClient;

  private constructor() {
    this.httpClient = new HttpClient({ timeoutMs: 90000 });
  }

  static getInstance(): PythonClient {
    if (!PythonClient.instance) {
      PythonClient.instance = new PythonClient();
    }
    return PythonClient.instance;
  }

  /** 获取 Python 端口（带就绪等待） */
  private async getPort(): Promise<number> {
    const daemon = AIDaemon.getInstance();
    if (!daemon.isOnline()) {
      try { await daemon.waitForReady(); } catch {}
    }
    return daemon.getPort();
  }

  /** 构建完整 URL */
  private buildUrl(path: string, port: number): string {
    return `http://127.0.0.1:${port}${path.startsWith('/') ? path : '/' + path}`;
  }

  /**
   * 同步调用 Python 端点（非 SSE 短任务，如 /api/vision /api/cluster_faces）
   * 返回 Python 端原始响应 JSON，由调用方按各自契约解析
   *
   * @param path    端点路径
   * @param body    请求体
   * @param signal  取消信号（可选）
   * @param options 可选：覆盖本次调用的超时/重试配置（缺省用本客户端默认 90s/2 次重试）
   *                耗时端点（如 /api/vision 人脸检测）用它放宽超时、关闭重试，避免级联超时
   */
  async call(path: string, body: any, signal?: AbortSignal, options?: { timeoutMs?: number; maxRetries?: number }): Promise<any> {
    const port = await this.getPort();
    const url = this.buildUrl(path, port);
    try {
      // 仅在显式覆盖超时/重试时新建 HttpClient，否则复用共享实例（保持默认行为）
      const http = options && (options.timeoutMs !== undefined || options.maxRetries !== undefined)
        ? new HttpClient({
            timeoutMs: options.timeoutMs ?? this.httpClient['config'].timeoutMs,
            maxRetries: options.maxRetries ?? this.httpClient['config'].maxRetries,
          })
        : this.httpClient;
      return await http.post(url, body, { signal });
    } catch (err: any) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[PythonClient] ${path} 调用失败: ${err?.message || err}`);
      throw err;
    }
  }

  /**
   * 异步调用 Python 端点（fire-and-forget + SSE 长任务模式）
   * 用于 /api/separate 和 /api/transcribe 等耗时操作
   *
   * @param path       POST 触发路径，如 '/api/separate'
   * @param body       请求体（不含 task_id，由本方法自动生成）
   * @param onProgress 进度回调
   * @param options    超时、取消信号、SSE 流路径
   * @returns SSE 流结束时的最终结果（Python 端 _set_progress 写入的 result 字段）
   */
  async callAsync(
    path: string,
    body: any,
    onProgress: (pct: number, msg: string) => void,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      streamPath?: string;  // SSE 路径，默认 path + '/stream/'
    } = {}
  ): Promise<{ done: boolean; error?: string; result?: any }> {
    const port = await this.getPort();
    const url = this.buildUrl(path, port);
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Step 1: POST 触发任务（短超时，仅确认任务已启动）
    const triggerClient = new HttpClient({ timeoutMs: 10000, maxRetries: 0 });
    let postOk = false;
    try {
      const postRes = await triggerClient.post(url, { ...body, task_id: taskId }, { signal: options.signal });
      postOk = !!(postRes && (postRes.success || postRes.deduplicated));
    } catch (err: any) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[PythonClient] ${path} POST 触发失败 (task=${taskId}): ${err?.message || err}`);
      return { done: true, error: err?.message || String(err) };
    }

    if (!postOk) {
      return { done: true, error: `${path} 触发返回失败` };
    }

    // Step 2: SSE 订阅进度和最终结果
    const streamPath = options.streamPath || `${path}/stream/`;
    return await PythonProgressSubscriber.subscribe(
      taskId, onProgress, options.timeoutMs || 600000, options.signal, streamPath
    );
  }
}