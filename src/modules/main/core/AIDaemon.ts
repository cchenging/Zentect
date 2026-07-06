import * as path from 'path';
import * as http from 'http';
import { ChildProcess, spawn } from 'child_process';
import { PathManager } from '../utils/pathManager';
import { ProcessManager } from '../utils/processManager';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { AiRuntimeManager } from './AiRuntimeManager';

/**
 * AI 守护进程 Facade
 * 对外提供统一的 Python AI 运行时接口
 * 内部委托给 AiRuntimeManager + ProcessSupervisor
 */
export class AIDaemon {
  private static instance: AIDaemon;
  private ttsProcess: ChildProcess | null = null;
  private isReady = false;
  private ttsReady = false;
  private port = 34567;
  private ttsPort = 9881;
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
    this.stopTTS();
  }

  // ==========================================
  // 🔊 MOSS-TTS-Nano 工作进程管理
  // ==========================================
  public startTTS() {
    if (this.ttsReady || this.ttsProcess) return;

    const pythonExe = this.settingsRepo.get<string>('pythonPath', 'python');
    const scriptPath = PathManager.getScriptPath('tts_worker.py');
    const defaultModelsDir = PathManager.getModelsPath();
    // 读取用户在设置中配置的模型路径，优先使用
    const configuredModelDir = this.settingsRepo.get<string>('mossModelDir', '');
    const modelDir = configuredModelDir || path.join(defaultModelsDir, 'moss-tts-nano');

    AppLogger.info(LOG_TAGS.AI_DAEMON, 'Starting MOSS-TTS worker...', { script: scriptPath, port: this.ttsPort, modelDir });

    const pyLibsPath = path.join(PathManager.getResourcesPath(), 'scripts', 'py_libs');
    const pythonEnv = { ...process.env, PYTHONPATH: pyLibsPath };
    this.ttsProcess = spawn(pythonExe, [
      scriptPath,
      '--port', this.ttsPort.toString(),
      '--model_dir', modelDir,
    ]);
    ProcessManager.register(this.ttsProcess, 'MOSS_TTS_Worker');

    // 捕获 stdout 输出（uvicorn 启动日志走 stdout）
    this.ttsProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      AppLogger.info(LOG_TAGS.AI_DAEMON, `[MOSS-TTS stdout] ${output}`);
      if (output.includes('Uvicorn running') || output.includes('Application startup')) {
        this.ttsReady = true;
        AppLogger.info(LOG_TAGS.AI_DAEMON, 'MOSS-TTS worker is online.', { port: this.ttsPort });
      }
    });

    // 捕获 stderr 输出（模型加载日志走 stderr）
    this.ttsProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      AppLogger.info(LOG_TAGS.AI_DAEMON, `[MOSS-TTS stderr] ${output}`);
      if (output.includes('Uvicorn running') || output.includes('Application startup')) {
        this.ttsReady = true;
        AppLogger.info(LOG_TAGS.AI_DAEMON, 'MOSS-TTS worker is online.', { port: this.ttsPort });
      }
    });

    this.ttsProcess.on('close', (code) => {
      this.ttsReady = false;
      this.ttsProcess = null;
      AppLogger.info(LOG_TAGS.AI_DAEMON, `MOSS-TTS worker exited with code ${code}.`);
    });

    this.ttsProcess.on('error', (err) => {
      AppLogger.error(LOG_TAGS.AI_DAEMON, 'Failed to start MOSS-TTS worker.', err);
    });
  }

  public stopTTS() {
    if (this.ttsProcess) {
      // 💥 危机三修复：树形强杀 TTS 进程，杜绝僵尸端口占满
      const pid = this.ttsProcess.pid;
      if (pid) {
        ProcessManager.killTree(pid);
      } else {
        this.ttsProcess.kill();
      }
      this.ttsProcess = null;
      this.ttsReady = false;
    }
  }

  public isTTSReady(): boolean {
    return this.ttsReady;
  }

  /** 等待就绪 — 查询 AiRuntimeManager 状态 */
  private async waitForReady(): Promise<void> {
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

  /** 向 Python 运行时发 POST 请求 */
  public async post(endpoint: string, payload: any, options?: { timeout?: number; retries?: number }): Promise<any> {
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
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
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
