import * as http from 'http';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { AiRuntimeManager } from './AiRuntimeManager';

/**
 * AI 守护进程 Facade
 * 对外提供统一的 Python AI 运行时接口
 * 内部委托给 AiRuntimeManager + ProcessSupervisor
 */
export class AIDaemon {
  private static instance: AIDaemon;
  private isReady = false;
  private port = 34567;
  private settingsRepo = new SettingsRepository();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private healthFailCount = 0;
  private readonly HEALTH_CHECK_INTERVAL = 5000;
  private readonly HEALTH_MAX_FAILURES = 3;
  private runtimeManager: AiRuntimeManager;

  private constructor() {
    this.runtimeManager = AiRuntimeManager.getInstance();
  }

  public static getInstance(): AIDaemon {
    if (!AIDaemon.instance) {
      AIDaemon.instance = new AIDaemon();
    }
    return AIDaemon.instance;
  }

  /** 启动 AI Daemon — 委托给 AiRuntimeManager */
  public start() {
    this.port = Number(this.settingsRepo.get<number>('aiPort', 34567)) || 34567;

    if (this.isReady) {
      AppLogger.info(LOG_TAGS.AI_DAEMON, 'Daemon 已在运行中', { port: this.port });
      return;
    }

    AppLogger.info(LOG_TAGS.AI_DAEMON, '通过 AiRuntimeManager 启动 AI 运行时...');

    this.runtimeManager.start()
      .then((result) => {
        if (!result.success) {
          AppLogger.error(LOG_TAGS.AI_DAEMON, `AiRuntimeManager 启动失败: ${result.message}`);
          return;
        }

        this.port = this.runtimeManager.getPort();
        this.isReady = true;
        this.startHealthCheck();
        AppLogger.info(LOG_TAGS.AI_DAEMON, 'AI Daemon 已上线', { port: this.port });
      })
      .catch((err) => {
        AppLogger.error(LOG_TAGS.AI_DAEMON, 'AiRuntimeManager 启动异常', err);
      });
  }

  /** 停止 — 同时停止 RuntimeManager */
  public stop() {
    this.stopHealthCheck();
    this.runtimeManager.stop();
    this.isReady = false;
  }

  /** 等待就绪 — 查询 AiRuntimeManager 状态；若离线则自动点火 */
  public async waitForReady(): Promise<void> {
    if (this.isReady) return;

    if (!this.runtimeManager.online) {
      AppLogger.warn(LOG_TAGS.AI_DAEMON, '检测到 AI 运行时离线，执行自动点火...');
      this.start();
    }

    let retries = 60;
    while (!this.runtimeManager.online && retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      retries--;
    }

    if (this.runtimeManager.online) {
      this.isReady = true;
      return;
    }
    throw new Error('AI 运行时启动超时 (30秒)！');
  }

  /** 检查 Python AI 运行时是否在线 */
  public isOnline(): boolean {
    const status = this.runtimeManager.getStatus();
    return this.isReady && status.online;
  }

  public getPort(): number {
    return this.port;
  }

  /** 向 Python 运行时发 POST 请求 */
  public async post(endpoint: string, payload: any, options?: { timeout?: number; retries?: number; signal?: AbortSignal }): Promise<any> {
    await this.waitForReady();

    const status = this.runtimeManager.getStatus();
    if (!status.online) {
      throw new Error('AI 运行时处于离线状态，无法处理请求。请确认 AI Daemon 已启动（端口 ' + this.port + '）');
    }

    const url = `http://127.0.0.1:${this.port}${endpoint}`;
    const maxRetries = options?.retries ?? 2;
    const timeoutMs = options?.timeout ?? 60000;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 🔧 修复 TS2304：onExternalAbort 提升到 try 外，catch 块也能访问
      let onExternalAbort: (() => void) | null = null;
      try {
        /** 每次重试前先做一次快速健康检查（5秒超时），确保 daemon 存活 */
        if (attempt > 0) {
          const isHealthy = await this.quickHealthCheck();
          if (!isHealthy) {
            AppLogger.warn(LOG_TAGS.AI_DAEMON, `[${endpoint}] 重试前健康检查失败，尝试重启 AI Daemon...`);
            this.restartDaemon();
            await new Promise(r => setTimeout(r, 3000));
          }
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        // Fix 10: 外部取消信号触发时同步中止 fetch
        onExternalAbort = () => controller.abort();
        options?.signal?.addEventListener('abort', onExternalAbort);

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener('abort', onExternalAbort);
        onExternalAbort = null;
        if (!res.ok) {
          const errText = await res.text().catch(() => '未返回详细错误');
          const errMsg = `HTTP ${res.status} - ${errText}`;
          /** 服务端返回 5xx → 可重试 */
          if (res.status >= 500 && attempt < maxRetries) {
            lastError = new Error(errMsg);
            const delay = 2000 * (attempt + 1);
            AppLogger.warn(LOG_TAGS.AI_DAEMON,
              `服务端错误 ${res.status} [${endpoint}]，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw new Error(errMsg);
        }
        return await res.json();
      } catch (e: any) {
        lastError = e;

        /** 网络层错误分类：提供更精准的错误诊断 */
        const errorCode = e.cause?.code || '';
        const isConnectionRefused = errorCode === 'ECONNREFUSED';
        const isConnectionReset = errorCode === 'ECONNRESET';
        const isTimeout = errorCode === 'ETIMEDOUT' || e.name === 'AbortError';
        const isNetworkError = isConnectionRefused || isConnectionReset || isTimeout ||
          e.message?.includes('fetch failed') ||
          e.message?.includes('Network Error') ||
          e.message?.includes('远程主机强迫关闭');

        if (attempt < maxRetries && (isNetworkError || isTimeout)) {
          // Fix 10: 重试前清理外部 abort listener，下次迭代重新注册
          if (onExternalAbort) {
            options?.signal?.removeEventListener('abort', onExternalAbort);
            onExternalAbort = null;
          }
          const delay = isConnectionReset ? 3000 * (attempt + 1) : 1000 * (attempt + 1);
          const reason = isConnectionRefused ? '连接被拒绝 (端口未监听)'
            : isConnectionReset ? '连接被重置 (进程可能崩溃)'
            : isTimeout ? '请求超时'
            : '网络异常';
          AppLogger.warn(LOG_TAGS.AI_DAEMON,
            `${reason} [${endpoint}]，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          AppLogger.error(LOG_TAGS.AI_DAEMON,
            `❌ 请求失败 [${endpoint}] (已重试 ${maxRetries} 次): ${e.message}`);

          // Fix 10: 清理外部 abort listener
          if (onExternalAbort) {
            options?.signal?.removeEventListener('abort', onExternalAbort);
            onExternalAbort = null;
          }

          /** 抛出带友好提示和解决方案的错误 */
          if (isConnectionRefused) {
            throw new Error(
              `AI 运行时服务未启动 (端口 ${this.port})，请检查：\n` +
              `1. 确认 Python 环境已安装必要依赖\n` +
              `2. 在设置中检查 AI 服务端口配置\n` +
              `3. 尝试重启应用或手动启动 AI Daemon`
            );
          }
          if (isConnectionReset) {
            throw new Error(
              `AI 运行时服务异常崩溃 (端口 ${this.port})，连接已被重置。\n` +
              `可能原因：模型加载失败、显存不足、或 Python 进程异常退出。\n` +
              `建议：重启应用后重试，或检查系统资源。`
            );
          }
          if (isTimeout) {
            throw new Error(
              `AI 运行时服务响应超时 (${timeoutMs / 1000}秒)，请检查：\n` +
              `1. 系统资源是否充足 (CPU/内存/显存)\n` +
              `2. 模型文件是否完整\n` +
              `3. 尝试降低处理参数后重试`
            );
          }
          throw e;
        }
      }
    }
    /** 所有重试已用完，抛出最后错误 */
    throw lastError || new Error(`AI Daemon 请求失败: ${endpoint}`);
  }

  /** 快速健康检查 (3秒超时)，用于重试前确认 daemon 存活 */
  private async quickHealthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ==========================================
  // 💓 健康心跳检测 — 连续失败自动重启
  // ==========================================
  private startHealthCheck() {
    if (this.healthCheckTimer) return;
    this.healthFailCount = 0;

    this.healthCheckTimer = setInterval(() => {
      if (!this.runtimeManager.online) return;

      const req = http.get(`http://localhost:${this.port}/health`, (res: any) => {
        if (res.statusCode === 200) {
          this.healthFailCount = 0;
        } else {
          this.healthFailCount++;
        }
        res.resume();
      });

      req.on('error', () => { this.healthFailCount++; });
      req.setTimeout(3000, () => { req.destroy(); this.healthFailCount++; });

      if (this.healthFailCount >= this.HEALTH_MAX_FAILURES) {
        AppLogger.error(LOG_TAGS.AI_DAEMON, `健康检查连续 ${this.healthFailCount} 次失败，重启守护进程`);
        this.healthFailCount = 0;
        this.restartDaemon();
      }
    }, this.HEALTH_CHECK_INTERVAL);
  }

  private stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.healthFailCount = 0;
  }

  private restartDaemon() {
    this.runtimeManager.restart()
      .then((r) => {
        if (r.success) {
          this.isReady = true;
          this.port = this.runtimeManager.getPort();
          AppLogger.info(LOG_TAGS.AI_DAEMON, 'AI 运行时已重启');
        }
      })
      .catch((err) => {
        AppLogger.error(LOG_TAGS.AI_DAEMON, 'RuntimeManager 重启失败', err);
      });
  }
}
