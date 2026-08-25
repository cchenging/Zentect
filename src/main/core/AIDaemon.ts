import * as http from 'http';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { AiRuntimeManager } from './AiRuntimeManager';
import { Semaphore } from '../utils/async';

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
  /** 🔧 P0 修复（根治：模型加载 26s 不被误杀）：失败窗口从 15s 拉长到 40s
   *   旧逻辑 3 次 × 5 秒 = 15 秒 —— CLIP 首次加载耗时 26 秒，被判定为 daemon 死误重启
   *   新逻辑 8 次 × 5 秒 = 40 秒 —— 搭配独立健康检查 HTTPD 和 loading 状态识别，三重保险 */
  private readonly HEALTH_MAX_FAILURES = 8;
  /** 在途长任务计数：守护进程正在处理请求时，健康检查失败不触发重启，避免 CPU 密集任务（如 TTS 合成）被误杀 */
  private inflightTaskCount = 0;
  /** 专用健康检查端口：ai_daemon.py 启动独立线程 HTTPD，在 stderr 中打印 [AI_HEALTH_PORT]=xxx
   *   AiRuntimeManager 解析后通过 setHealthPort() 注入；健康检查优先打此端口，1ms 响应永不饿死 */
  private healthPort?: number;
  private runtimeManager: AiRuntimeManager;
  /** P1 #7：ensureWarm() 的幂等单飞 Promise。
   *  同一进程内并发调用 ensureWarm，仅真正跑一次 /health 拉活流程，其他调用直接复用同一 Promise。 */
  private warmPromise: Promise<void> | null = null;
  private lastWarmAt = 0;
  /** 预热有效时间窗：10 分钟内再次调用视为仍然热，不重复打 /health */
  private readonly WARM_TTL_MS = 10 * 60 * 1000;
  /** 预热超时：/health 超过 10 秒仍未返回就算失败（不抛错，仅日志，继续执行后续请求） */
  private readonly WARM_TIMEOUT_MS = 10000;
  /** P1 #7：全局请求并发上限信号量（默认 4）。
   *  Python 守护进程因 GIL，CPU 密集任务（TTS/ASR/beat 检测/KM 求解）并发 8+ 会互相拖垮；
   *  设 4 并发保证吞吐可控，超出部分自动排队 FIFO。 */
  private requestSem: Semaphore;
  /** 队列深度告警阈值：排队请求超过此值打 warn，便于诊断上游是否暴打 daemon */
  private readonly QUEUE_WARN_THRESHOLD = 8;

  private constructor() {
    this.runtimeManager = AiRuntimeManager.getInstance();
    this.requestSem = new Semaphore(4, 'AIDaemon.post');
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
        this.setHealthPort(this.runtimeManager.getHealthPort());
        this.isReady = true;
        this.startHealthCheck();
        AppLogger.info(LOG_TAGS.AI_DAEMON, 'AI Daemon 已上线', { port: this.port, healthPort: this.healthPort });
      })
      .catch((err) => {
        AppLogger.error(LOG_TAGS.AI_DAEMON, 'AiRuntimeManager 启动异常', err);
      });
  }

  /** 停止 — 同时停止 RuntimeManager */
  public stop() {
    this.stopHealthCheck();
    // 🔧 R1 模型生命周期（PR-1）：daemon 退出前主动释放全部模型，回收内存
    this.releaseAllModels();
    this.runtimeManager.stop();
    this.isReady = false;
  }

  /** 🔧 R1：fire-and-forget 调用 /release_models，让 Python 侧释放全部常驻模型再退出。
   *   daemon 即将被 killTree，请求失败静默，不阻塞退出流程。 */
  private releaseAllModels(): void {
    try {
      const status = this.runtimeManager?.getStatus?.();
      if (status && !status.online) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      fetch(`http://127.0.0.1:${this.port}/release_models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      }).catch(() => { /* daemon 即将退出，失败静默 */ })
        .finally(() => clearTimeout(timer));
    } catch { /* 静默 */ }
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

  /** 函数级中文注释：设置专用健康检查端口（AiRuntimeManager 解析 stderr 的 [AI_HEALTH_PORT]=xxx 后调用）。
   *  undefined 表示 fallback 到业务端口 this.port。 */
  public setHealthPort(port: number | undefined) {
    this.healthPort = port;
    if (port) AppLogger.debug(LOG_TAGS.AI_DAEMON, `[healthd] 使用独立健康检查端口 ${port}（永不阻塞）`);
  }

  /** 函数级中文注释：返回当前健康检查的 URL —— 优先独立 HTTPD，fallback 业务端口。 */
  private getHealthCheckUrl(): string {
    const p = this.healthPort ?? this.port;
    return `http://127.0.0.1:${p}/health`;
  }

  /** 函数级中文注释：从 /health JSON 响应体中解析 status 字段。
   *  status==='loading' 表示 Python 正在加载模型（CLIP/InsightFace/…），此时 HTTP 200 但不应视为健康失败。
   *  返回值：{healthy:boolean, loading:boolean, loadingModel?:string, elapsedMs?:number} */
  private parseHealthBody(body: string): { healthy: boolean; loading: boolean; loadingModel?: string; elapsedMs?: number } {
    try {
      const json = JSON.parse(body || '{}');
      const status: string = json?.status;
      if (status === 'loading') {
        return { healthy: false, loading: true, loadingModel: json?.loadingModel, elapsedMs: json?.elapsedMs };
      }
      return { healthy: status === 'ok', loading: false };
    } catch {
      return { healthy: true, loading: false }; // 没按约定格式就当正常，避免反复误判
    }
  }

  /**
   * P1 #7 预调 daemon：提前打 /health 把 Python 子进程 + 运行时模型热起来。
   * 关键语义：
   *   - 幂等并发（单飞）：同一时间 N 处调用，只执行一次 /health，其余共享 Promise
   *   - 冷启动复用 waitForReady：进程未启动时自动点火，不会因为"提前拉活"导致还没 spawn
   *   - TTL 防抖：10 分钟内重复调用视为仍然 warm，不重复发 /health
   *   - 失败静默：/health 挂了只打 warn，绝不抛错（不能因为预热失败阻塞后续真正业务请求）
   *   - 长任务安全：会把 inflightTaskCount 短暂 +1，避免 /health 被健康检查判定为 daemon 死
   */
  public async ensureWarm(): Promise<void> {
    const now = Date.now();
    /** TTL 内仍然 warm → 立即返回 */
    if (this.lastWarmAt > 0 && now - this.lastWarmAt < this.WARM_TTL_MS && this.isOnline()) return;
    /** 有在途 Promise → 复用（并发单飞） */
    if (this.warmPromise) return this.warmPromise;

    this.warmPromise = (async () => {
      try {
        /** 进入轻量长任务窗口：/health 期间的健康检查失败判为"忙非死" */
        this.inflightTaskCount++;
        try {
          await this.waitForReady();
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.AI_DAEMON, `[ensureWarm] 自动点火失败（继续由首次 POST 兜底）: ${e.message}`);
          return;
        }

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), this.WARM_TIMEOUT_MS);
          const res = await fetch(this.getHealthCheckUrl(), {
            method: 'GET',
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (res.ok) {
            this.lastWarmAt = Date.now();
            AppLogger.info(LOG_TAGS.AI_DAEMON, `[ensureWarm] /health 拉活成功 (port=${this.healthPort ?? this.port})`);
            /** 🔧 P0 根治：拉活成功后调用 /api/preload 把 CLIP/InsightFace 权重提前加载到内存
             *   使用业务端口 34567 发请求（/api/preload 是 FastAPI 端点，不走 health HTTPD）；
             *   预热 60 秒超时并静默失败，不阻塞后续业务请求。*/
            try {
              const c2 = new AbortController();
              const t2 = setTimeout(() => c2.abort(), 60000);
              const r2 = await fetch(`http://127.0.0.1:${this.port}/api/preload?models=clip,chinese_clip,face`, {
                method: 'GET',
                signal: c2.signal,
              });
              clearTimeout(t2);
              if (r2.ok) {
                const j2 = await r2.json().catch(() => ({}));
                AppLogger.info(LOG_TAGS.AI_DAEMON, `[ensureWarm] /api/preload 预热成功，耗时 ${j2?.elapsedMs ?? -1}ms，模型=${JSON.stringify(j2?.requested ?? [])}`);
              } else {
                AppLogger.warn(LOG_TAGS.AI_DAEMON, `[ensureWarm] /api/preload 预热返回非 200: HTTP ${r2.status}，不影响后续请求`);
              }
            } catch (e2: any) {
              AppLogger.warn(LOG_TAGS.AI_DAEMON, `[ensureWarm] /api/preload 预热失败（不影响业务）: ${e2.message}`);
            }
          } else {
            AppLogger.warn(LOG_TAGS.AI_DAEMON, `[ensureWarm] /health 返回非 200: HTTP ${res.status}`);
          }
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.AI_DAEMON, `[ensureWarm] /health 失败（不影响后续请求）: ${e.message}`);
        }
      } finally {
        this.inflightTaskCount = Math.max(0, this.inflightTaskCount - 1);
        this.warmPromise = null;
      }
    })();
    return this.warmPromise;
  }

  /** 向 Python 运行时发 POST 请求
   *  🔧 R3 取消贯通（PR-1）：options.taskId 用于请求头 X-Task-Id（daemon 侧查询取消标记）与
   *    abort/超时时自动 POST /cancel/{taskId} 通知 daemon 提前终止 */
  public async post(endpoint: string, payload: any, options?: { timeout?: number; retries?: number; signal?: AbortSignal; taskId?: string }): Promise<any> {
    await this.waitForReady();

    const status = this.runtimeManager.getStatus();
    if (!status.online) {
      throw new Error('AI 运行时处于离线状态，无法处理请求。请确认 AI Daemon 已启动（端口 ' + this.port + '）');
    }

    /** 🔧 P1 #7：并发窗口信号量。
     *   Daemon 是 Python（GIL 单解释器），CPU 密集任务（TTS/ASR/detect_beats/KM 求解/切片）并发过高会导致
     *   彼此切换开销 + /health 响应变慢 → 健康检查误杀 → 重启打断业务。
     *   限 4 并发，超出部分 FIFO 排队，队列深度 > 8 打 warning 便于观测。 */
    if (this.requestSem.queueDepth >= this.QUEUE_WARN_THRESHOLD) {
      AppLogger.warn(LOG_TAGS.AI_DAEMON,
        `[${endpoint}] Daemon 请求排队深度=${this.requestSem.queueDepth}，超过阈值 ${this.QUEUE_WARN_THRESHOLD}，请留意下游是否卡 CPU/显存`);
    }
    const release = await this.requestSem.acquire();
    /** 进入长任务窗口：请求在途期间置忙，健康检查失败不触发重启（守护进程正在处理 CPU 密集任务） */
    this.inflightTaskCount++;

    const url = `http://127.0.0.1:${this.port}${endpoint}`;
    const maxRetries = options?.retries ?? 2;
    const timeoutMs = options?.timeout ?? 60000;

    let lastError: Error | null = null;

    try {
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
          /** 🔧 R3 取消贯通：abort（外部 signal 或内部超时）时通知 daemon 取消长任务，
           *   让 KM 等求解循环提前退出，CPU 不再空烧。fire-and-forget，失败静默。 */
          const notifyCancel = () => {
            const tid = options?.taskId;
            if (!tid) return;
            fetch(`http://127.0.0.1:${this.port}/cancel/${encodeURIComponent(tid)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            }).catch(() => { /* fire-and-forget */ });
          };
          const timeoutId = setTimeout(() => { notifyCancel(); controller.abort(); }, timeoutMs);

          // Fix 10: 外部取消信号触发时同步中止 fetch
          onExternalAbort = () => { notifyCancel(); controller.abort(); };
          options?.signal?.addEventListener('abort', onExternalAbort);

          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(options?.taskId ? { 'X-Task-Id': options.taskId } : {}),
            },
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
    } finally {
      // 退出长任务窗口：无论成功、失败还是被取消，都要释放在途计数
      this.inflightTaskCount = Math.max(0, this.inflightTaskCount - 1);
      // 归还并发窗口信号量许可：必须与 acquire 配对，否则下一波请求会饿死
      try { release(); } catch { /* ignore */ }
    }
  }

  /** 快速健康检查 (3秒超时)，用于重试前确认 daemon 存活。
   *  函数级中文注释：使用 healthPort 优先 URL；若 /health 返回 loading 视为"存活"（正在加载权重），
   *  仅 HTTP 层失败（超时/ECONNREFUSED）才返回 false，避免 loading 期间触发不必要重启。 */
  private async quickHealthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(this.getHealthCheckUrl(), {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) return false;
      const txt = await res.text().catch(() => '{}');
      const parsed = this.parseHealthBody(txt);
      // loading 或 ok 均视为"活着"
      return parsed.healthy || parsed.loading;
    } catch {
      return false;
    }
  }

  // ==========================================
  // 💓 健康心跳检测 — 连续失败自动重启（长任务期间 / 模型加载期间跳过重启判定）
  // ==========================================
  private startHealthCheck() {
    if (this.healthCheckTimer) return;
    this.healthFailCount = 0;

    this.healthCheckTimer = setInterval(() => {
      if (!this.runtimeManager.online) return;

      const url = this.getHealthCheckUrl();
      const req = http.get(url, (res: any) => {
        // 🔧 P0 根治：读取响应 body，判断 status==='loading' 不算失败。
        // loading 代表 Python 正在加载模型（CLIP/chinese_clip 等 26 秒），但 daemon 实际是活着的。
        let chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 200) {
            const parsed = this.parseHealthBody(body);
            if (parsed.loading) {
              AppLogger.debug(LOG_TAGS.AI_DAEMON,
                `健康检查: 模型 ${parsed.loadingModel ?? '?'} 正在加载，已耗时 ${parsed.elapsedMs ?? -1}ms，不计入失败`);
              this.healthFailCount = 0;
              return;
            }
            if (parsed.healthy) {
              this.healthFailCount = 0;
              return;
            }
          }
          this.handleHealthCheckFailure('HTTP ' + res.statusCode);
        });
      });

      req.on('error', () => this.handleHealthCheckFailure('连接错误'));
      req.setTimeout(3000, () => { req.destroy(); this.handleHealthCheckFailure('超时'); });
    }, this.HEALTH_CHECK_INTERVAL);
  }

  /**
   * 处理一次健康检查失败（HTTP 失败 / 超时 / 连接拒绝 / 返回非 ok+非 loading ）。
   *
   * 三重防护（从外到内，层层过滤误重启）：
   *   ① 有在途长任务（POST 请求 inflight / ensureWarm / preload）→ 跳过
   *   ② /health 返回 status==='loading'（Python 侧 AIModels._MODEL_LOADING_STATE 有值）→ 已在上面归零，不进这里
   *   ③ 失败窗口 40s（8 次 × 5s）≥ CLIP 最大加载 26s → 极端情况也不触发
   */
  private handleHealthCheckFailure(reason: string) {
    if (this.inflightTaskCount > 0) {
      AppLogger.debug(LOG_TAGS.AI_DAEMON,
        `健康检查失败(${reason})，但守护进程有 ${this.inflightTaskCount} 个在途长任务，判定为忙非死，跳过重启`);
      return;
    }

    this.healthFailCount++;
    if (this.healthFailCount >= this.HEALTH_MAX_FAILURES) {
      AppLogger.error(LOG_TAGS.AI_DAEMON, `健康检查连续 ${this.healthFailCount} 次失败，重启守护进程`);
      this.healthFailCount = 0;
      this.restartDaemon();
    } else {
      AppLogger.warn(LOG_TAGS.AI_DAEMON,
        `健康检查失败(${reason})，累计 ${this.healthFailCount}/${this.HEALTH_MAX_FAILURES}，仍在容忍窗口 ${this.HEALTH_MAX_FAILURES * this.HEALTH_CHECK_INTERVAL / 1000}s`);
    }
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
          this.setHealthPort(this.runtimeManager.getHealthPort());
          AppLogger.info(LOG_TAGS.AI_DAEMON, 'AI 运行时已重启', { healthPort: this.healthPort });
        }
      })
      .catch((err) => {
        AppLogger.error(LOG_TAGS.AI_DAEMON, 'RuntimeManager 重启失败', err);
      });
  }
}
