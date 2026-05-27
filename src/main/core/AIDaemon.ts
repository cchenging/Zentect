import * as path from 'path';
import * as http from 'http';
import { ChildProcess, spawn } from 'child_process';
import { PathManager } from '../utils/pathManager';
import { ProcessManager } from '../utils/processManager';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
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
    const modelsDir = PathManager.getModelsPath();

    AppLogger.info(LOG_TAGS.AI_DAEMON, 'Starting MOSS-TTS worker...', { script: scriptPath, port: this.ttsPort });

    this.ttsProcess = spawn(pythonExe, [
      scriptPath,
      '--port', this.ttsPort.toString(),
      '--model_dir', path.join(modelsDir, 'moss-tts-nano'),
      '--heartbeat_port', '34568'
    ]);
    ProcessManager.register(this.ttsProcess, 'MOSS_TTS_Worker');

    this.ttsProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
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

  /** 向 Python 运行时发 POST 请求 */
  public async post(endpoint: string, payload: any, options?: { timeout?: number; retries?: number }): Promise<any> {
    await this.waitForReady();

    const status = this.runtimeManager.getStatus();
    if (!status.online) {
      throw new Error('AI 运行时处于离线状态，无法处理请求');
    }

    const url = `http://127.0.0.1:${this.port}${endpoint}`;
    const maxRetries = options?.retries ?? 2;
    const timeoutMs = options?.timeout ?? 60000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
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
          throw new Error(`HTTP ${res.status} - ${errText}`);
        }
        return await res.json();
      } catch (e: any) {
        if (attempt < maxRetries) {
          const delay = 1000 * (attempt + 1);
          AppLogger.warn(LOG_TAGS.AI_DAEMON, `请求失败 [${endpoint}]，${delay}ms 后重试 (${attempt + 1}/${maxRetries})`, e.message);
          await new Promise(r => setTimeout(r, delay));
        } else {
          AppLogger.error(LOG_TAGS.AI_DAEMON, `❌ 请求失败 [${endpoint}] (已重试 ${maxRetries} 次):`, e);
          throw e;
        }
      }
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
