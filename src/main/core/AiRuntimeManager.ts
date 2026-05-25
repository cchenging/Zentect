import { spawn, ChildProcess } from 'child_process'
import * as http from 'http'
import { PathManager } from '../utils/pathManager'
import { ProcessManager } from '../utils/processManager'
import { ProcessSupervisor, RestartCallback } from './ProcessSupervisor'
import { AppLogger } from './AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'
import { SettingsRepository } from '../database/repositories/SettingsRepository'
import { RuntimeVersionGuard } from './RuntimeVersionGuard'

interface RuntimeStatus {
  online: boolean
  port: number
  pid: number | null
  modelStatus: string
  gpuEnabled: boolean
}

/**
 * AI 运行时管理器
 * 管理 Python AI 运行时（TTS、ASR、人脸检测等微服务）的完整生命周期：
 *  - 启动 / 停止 / 重启
 *  - 健康检查
 *  - 版本校验
 *  - 进程守护
 *
 * AIDaemon 保留为 facade，内部逐步委托给本模块
 */
export class AiRuntimeManager {
  private static instance: AiRuntimeManager
  private supervisor = ProcessSupervisor.getInstance()
  private versionGuard = RuntimeVersionGuard.getInstance()
  private settings = new SettingsRepository()
  private runtimePid: number | null = null
  private runtimePort = 34567
  private isOnline = false

  private constructor() {}

  static getInstance(): AiRuntimeManager {
    if (!AiRuntimeManager.instance) {
      AiRuntimeManager.instance = new AiRuntimeManager()
    }
    return AiRuntimeManager.instance
  }

  /** 启动 AI 运行时（Python daemon） */
  async start(): Promise<{ success: boolean; message: string }> {
    if (this.isOnline && this.runtimePid) {
      return { success: true, message: 'AI 运行时已在运行中' }
    }

    const compat = this.versionGuard.checkRuntimeCompatibility()
    if (!compat.compatible) {
      const msg = `AI 运行时版本不兼容: ${compat.issues.join('; ')}`
      AppLogger.error(LOG_TAGS.SYSTEM, `[AiRuntimeManager] ${msg}`)
      return { success: false, message: msg }
    }

    const pythonPath = this.settings.get<string>('pythonPath', 'python')
    const customPort = this.settings.get<number>('aiPort', 34567)
    this.runtimePort = Number(customPort) || 34567
    const gpuEnabled = this.settings.get<boolean>('enableGPU', true)
    const deviceType = gpuEnabled ? 'cuda' : 'cpu'
    const scriptPath = PathManager.getScriptPath('ai_daemon.py')
    const modelsDir = PathManager.getModelsPath()

    try {
      AppLogger.info(LOG_TAGS.AI_DAEMON, '[AiRuntimeManager] 启动 AI 运行时...', {
        script: scriptPath, port: this.runtimePort, device: deviceType
      })

      const proc = spawn(pythonPath, [
        scriptPath,
        '--port', String(this.runtimePort),
        '--models_dir', modelsDir,
        '--device', deviceType
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      })

      if (!proc.pid) {
        return { success: false, message: '无法启动 AI 运行时进程' }
      }

      this.runtimePid = proc.pid
      ProcessManager.register(proc, 'AI_Daemon_Master')
      this.supervisor.supervise(proc, 'ai-daemon', 3, this.createRestartCallback())

      proc.stdout?.on('data', (data: Buffer) => {
        const output = data.toString().trim()
        if (output) AppLogger.info(LOG_TAGS.AI_DAEMON, `[Python Daemon] ${output}`)
        this.checkStartupSignal(output)
      })

      proc.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim()
        if (!output) return
        if (output.includes('%|') || (output.includes('M/s]') && output.includes('<00:'))) return
        if (output.includes('INFO:') || output.includes('Application startup') || output.includes('Uvicorn running')) {
          AppLogger.debug(LOG_TAGS.AI_DAEMON, `[Uvicorn] ${output}`)
          this.checkStartupSignal(output)
        } else {
          AppLogger.warn(LOG_TAGS.AI_DAEMON, `[Python Daemon ERR] ${output}`)
        }
      })

      proc.on('error', (err) => {
        AppLogger.error(LOG_TAGS.AI_DAEMON, '[AiRuntimeManager] 进程启动失败', err)
      })

      proc.on('close', (code) => {
        this.isOnline = false
        if (code !== 0) {
          AppLogger.warn(LOG_TAGS.AI_DAEMON, `[AiRuntimeManager] 进程异常退出 (code: ${code})`)
        }
      })

      await this.waitForHttpReady(30000)
      this.isOnline = true

      AppLogger.info(LOG_TAGS.SYSTEM, `[AiRuntimeManager] AI 运行时已启动 (PID: ${this.runtimePid}, Port: ${this.runtimePort})`)
      return { success: true, message: `AI 运行时已启动 (PID: ${this.runtimePid})` }
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.SYSTEM, `[AiRuntimeManager] 启动失败`, err)
      return { success: false, message: `启动失败: ${err.message}` }
    }
  }

  /** 停止 AI 运行时 */
  async stop(): Promise<void> {
    if (this.runtimePid) {
      ProcessManager.killTree(this.runtimePid)
      this.runtimePid = null
    }
    this.isOnline = false
    AppLogger.info(LOG_TAGS.SYSTEM, '[AiRuntimeManager] AI 运行时已停止')
  }

  /** 重启 AI 运行时 */
  async restart(): Promise<{ success: boolean; message: string }> {
    await this.stop()
    await new Promise((r) => setTimeout(r, 2000))
    return this.start()
  }

  /** 获取运行时状态 */
  getStatus(): RuntimeStatus {
    return {
      online: this.isOnline,
      port: this.runtimePort,
      pid: this.runtimePid,
      modelStatus: this.getModelStatusSummary(),
      gpuEnabled: this.settings.get<boolean>('enableGPU', true)
    }
  }

  /** 获取 Python AI 运行时端口 */
  getPort(): number {
    return this.runtimePort
  }

  /** 运行时是否在线 */
  get online(): boolean {
    return this.isOnline
  }

  /** 运行时 PID */
  get pid(): number | null {
    return this.runtimePid
  }

  /** 构建指向 Python 运行时的完整 URL */
  getUrl(endpoint: string): string {
    return `http://127.0.0.1:${this.runtimePort}${endpoint}`
  }

  /** 识别 Uvicorn 启动成功信号（仅记录日志，不提前设置 isOnline） */
  private checkStartupSignal(output: string): void {
    if (!this.isOnline &&
        (output.includes('Uvicorn running on port') ||
         output.includes('Application startup complete'))) {
      AppLogger.info(LOG_TAGS.AI_DAEMON, '[AiRuntimeManager] 检测到 Uvicorn 启动信号，等待 /health 确认...')
    }
  }

  /** HTTP 就绪探测 — 轮询 /health 端点直到返回 200 */
  private waitForHttpReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = (): void => {
        if (Date.now() - start > timeoutMs) {
          return reject(new Error(`AI 运行时 /health 端点未在 ${timeoutMs}ms 内就绪`))
        }
        const req = http.get(`http://127.0.0.1:${this.runtimePort}/health`, (res: any) => {
          if (res.statusCode === 200) {
            res.resume()
            return resolve()
          }
          res.resume()
          setTimeout(check, 500)
        })
        req.on('error', () => setTimeout(check, 500))
        req.setTimeout(3000, () => { req.destroy(); setTimeout(check, 500) })
      }
      check()
    })
  }

  /** 构建自动重启回调：重 spawn + /health 就绪探测 */
  private createRestartCallback(): RestartCallback {
    const pythonPath = this.settings.get<string>('pythonPath', 'python')
    const port = this.runtimePort
    const gpuEnabled = this.settings.get<boolean>('enableGPU', true)
    const deviceType = gpuEnabled ? 'cuda' : 'cpu'
    const scriptPath = PathManager.getScriptPath('ai_daemon.py')
    const modelsDir = PathManager.getModelsPath()

    return async (_label: string, _restartCount: number): Promise<ChildProcess> => {
      const proc = spawn(pythonPath, [
        scriptPath,
        '--port', String(port),
        '--models_dir', modelsDir,
        '--device', deviceType
      ], { stdio: ['pipe', 'pipe', 'pipe'] })

      if (!proc.pid) {
        throw new Error('重启失败: 无法获取进程 PID')
      }

      this.runtimePid = proc.pid
      this.isOnline = false

      proc.on('close', (code) => {
        this.isOnline = false
        if (code !== 0) {
          AppLogger.warn(LOG_TAGS.AI_DAEMON, `[AiRuntimeManager] 重启后进程异常退出 (code: ${code})`)
        }
      })

      await this.waitForHttpReady(30000)
      this.isOnline = true

      AppLogger.info(LOG_TAGS.SYSTEM, `[AiRuntimeManager] 重启就绪 (PID: ${proc.pid})`)
      return proc
    }
  }

  private getModelStatusSummary(): string {
    const manifest = this.versionGuard.checkModelManifest()
    if (manifest.valid) return '完整'
    if (manifest.missing.length > 0) return `缺失 ${manifest.missing.join(', ')}`
    if (manifest.mismatched.length > 0) return '文件不匹配'
    return '未知'
  }
}
