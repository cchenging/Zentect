import { spawn, ChildProcess, execSync } from 'child_process'
import path from 'path'
import * as http from 'http'
import { PathManager } from '../utils/pathManager'
import { ProcessManager } from '../utils/processManager'
import { ProcessSupervisor } from './ProcessSupervisor'
import type { RestartCallback } from './ProcessSupervisor'
import { AppLogger } from './AppLogger'
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants'
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
 * 管理 Python AI 运行时（ASR、音频分离、人脸检测等微服务）的完整生命周期：
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

    const pythonPath = this.resolvePythonPath()
    const customPort = this.settings.get<number>('aiPort', 34567)
    this.runtimePort = Number(customPort) || 34567
    const gpuEnabled = this.settings.get<boolean>('enableGPU', false)
    const deviceType = gpuEnabled ? 'cuda' : 'cpu'
    const scriptPath = PathManager.getScriptPath('ai_daemon.py')
    const modelsDir = PathManager.getModelsPath()

    try {
      // 🔧 修复 P0：启动前清理端口占用的残留 daemon 进程
      //   场景：应用异常退出（crash/force kill）时 stop() 未执行，旧 daemon 残留监听 34567 端口。
      //   新 daemon 因端口冲突启动失败，但 waitForHttpReady 检测到旧进程 /health 误判为就绪，
      //   导致业务路由全部 404（旧代码路由未注册）。
      this.killStaleDaemonOnPort(this.runtimePort)

      AppLogger.info(LOG_TAGS.AI_DAEMON, '[AiRuntimeManager] 启动 AI 运行时...', {
        script: scriptPath, port: this.runtimePort, device: deviceType
      })

      const scriptsPath = path.join(PathManager.getResourcesPath(), 'scripts');
      // 🔧 修复 P0：PYTHONPATH 只加 scriptsPath，不再加 py_libs
      //   深层根因：py_libs 优先级高于系统 site-packages，会覆盖系统级库。
      //   py_libs/scipy 不完整（缺 OpenBLAS DLL），导致 MDX-Net 加载 _fblas 失败
      //   → Demucs（无 demucs.api 模块）+ MDX-Net（scipy 崩溃）双引擎全部失败
      //   → /api/separate 返回 500 "所选引擎均不可用" → 前端 fetch failed
      //   系统级 site-packages 已有完整依赖（scipy 1.15.2 + numpy 1.26.4 + librosa 等），
      //   无需 py_libs。scriptsPath 仍需保留，让 ai_daemon.py 能 import 同目录子模块。
      const pythonEnv = { ...process.env, PYTHONPATH: scriptsPath };
      const proc = spawn(pythonPath, [
        scriptPath,
        '--port', String(this.runtimePort),
        '--models_dir', modelsDir,
        '--device', deviceType
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: pythonEnv  // 🔧 修复：补上 env 参数，让 py_libs 生效
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

  /**
   * 清理占用指定端口的残留 daemon 进程
   * 通过 netstat 查找监听端口的 PID，若与当前 runtimePid 不同则 kill
   */
  private killStaleDaemonOnPort(port: number): void {
    try {
      // netstat 查找监听目标端口的进程 PID
      const output = execSync(`netstat -ano | findstr ":${port} "`, {
        encoding: 'utf-8',
        timeout: 5000
      })
      const pids = new Set<number>()
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/)
        // netstat 输出格式：协议 本地地址 外部地址 状态 PID
        // 仅匹配 LISTENING 状态的 TCP 连接
        if (parts.length >= 5 && parts[3] === 'LISTENING') {
          const pid = parseInt(parts[4], 10)
          if (pid && pid !== this.runtimePid && pid !== process.pid) {
            pids.add(pid)
          }
        }
      }
      if (pids.size === 0) return
      AppLogger.warn(LOG_TAGS.AI_DAEMON, `[AiRuntimeManager] 检测到端口 ${port} 被残留进程占用，正在清理: PIDs=[${[...pids].join(', ')}]`)
      for (const pid of pids) {
        try {
          ProcessManager.killTree(pid)
        } catch {
          // 单个 PID kill 失败不阻断流程
        }
      }
    } catch {
      // netstat 无输出或命令失败 → 端口未被占用，正常情况
    }
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
      gpuEnabled: this.settings.get<boolean>('enableGPU', false)
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
    const pythonPath = this.resolvePythonPath()
    const port = this.runtimePort
    const gpuEnabled = this.settings.get<boolean>('enableGPU', false)
    const deviceType = gpuEnabled ? 'cuda' : 'cpu'
    const scriptPath = PathManager.getScriptPath('ai_daemon.py')
    const modelsDir = PathManager.getModelsPath()

    return async (_label: string, _restartCount: number): Promise<ChildProcess> => {
      // 🔧 自动重启时也清理端口残留进程，防止旧 daemon 占用端口
      this.killStaleDaemonOnPort(port)
      const scriptsPath = path.join(PathManager.getResourcesPath(), 'scripts');
      // 🔧 修复 P0：PYTHONPATH 只加 scriptsPath，不再加 py_libs（py_libs/scipy 不完整会导致 MDX-Net 崩溃）
      const pythonEnv = { ...process.env, PYTHONPATH: scriptsPath };
      const proc = spawn(pythonPath, [
        scriptPath,
        '--port', String(port),
        '--models_dir', modelsDir,
        '--device', deviceType
      ], { stdio: ['pipe', 'pipe', 'pipe'], env: pythonEnv })

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

  /**
   * 解析 Python 解释器路径
   * 优先级：用户 settings 自定义 → ai-env 便携环境 → 系统 Python
   * 发版后用户机器无 Python 时，ai-env 兜底保证可运行
   */
  private resolvePythonPath(): string {
    // 1. 用户在设置中显式配置的 pythonPath（最高优先级）
    const userDefined = this.settings.get<string>('pythonPath', '')
    if (userDefined) return userDefined

    // 2. ai-env 便携环境（发版内置）
    const aiEnvPython = PathManager.getAiEnvPythonPath()
    if (aiEnvPython) {
      AppLogger.info(LOG_TAGS.AI_DAEMON, `[AiRuntimeManager] 使用便携 ai-env: ${aiEnvPython}`)
      return aiEnvPython
    }

    // 3. 降级到系统 Python（开发环境或 ai-env 缺失时）
    AppLogger.warn(LOG_TAGS.AI_DAEMON, '[AiRuntimeManager] ai-env 不存在，降级到系统 python')
    return 'python'
  }

  private getModelStatusSummary(): string {
    const manifest = this.versionGuard.checkModelManifest()
    if (manifest.valid) return '完整'
    if (manifest.missing.length > 0) return `缺失 ${manifest.missing.join(', ')}`
    if (manifest.mismatched.length > 0) return '文件不匹配'
    return '未知'
  }
}
