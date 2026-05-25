import { ChildProcess } from 'child_process'
import { ProcessManager } from '../utils/processManager'
import { AppLogger } from './AppLogger'
import { LOG_TAGS } from '../../shared/utils/LogConstants'
import * as os from 'os'

interface SupervisedProcess {
  pid: number
  label: string
  startTime: number
  restartCount: number
  maxRestarts: number
  process: ChildProcess
}

/** 自动重启回调：返回新进程或 null（表示放弃重启） */
export type RestartCallback = (label: string, restartCount: number) => Promise<ChildProcess | null>

/**
 * 进程守护者
 * 监控受管子进程（Python runtime 等）的健康状态，
 * 异常退出时自动重启，主进程退出时确保子进程不驻留
 */
export class ProcessSupervisor {
  private static instance: ProcessSupervisor
  private supervised = new Map<number, SupervisedProcess>()
  private labelIndex = new Map<string, number>()
  private restartCallbacks = new Map<string, RestartCallback>()
  private isShuttingDown = false

  private constructor() {
    // singleton
  }

  static getInstance(): ProcessSupervisor {
    if (!ProcessSupervisor.instance) {
      ProcessSupervisor.instance = new ProcessSupervisor()
    }
    return ProcessSupervisor.instance
  }

  /** 注册受管进程，可选传入自动重启回调 */
  supervise(proc: ChildProcess, label: string, maxRestarts = 3, onRestart?: RestartCallback): void {
    if (!proc.pid) {
      AppLogger.error(LOG_TAGS.SYSTEM, `[ProcessSupervisor] 无法注册无 PID 的进程: ${label}`)
      return
    }

    const entry: SupervisedProcess = {
      pid: proc.pid,
      label,
      startTime: Date.now(),
      restartCount: 0,
      maxRestarts,
      process: proc
    }

    this.supervised.set(proc.pid, entry)
    this.labelIndex.set(label, proc.pid)

    if (onRestart) {
      this.restartCallbacks.set(label, onRestart)
    }

    ProcessManager.register(proc, label)

    proc.on('exit', (code, signal) => {
      this.handleExit(proc.pid!, label, code, signal, maxRestarts)
    })

    proc.on('error', (err) => {
      AppLogger.error(LOG_TAGS.SYSTEM, `[ProcessSupervisor] 进程错误 [${label}]: ${err.message}`)
    })

    AppLogger.info(LOG_TAGS.SYSTEM, `[ProcessSupervisor] 注册受管进程: ${label} (PID: ${proc.pid})`)
  }

  /** 获取进程运行时长（秒） */
  getUptime(label: string): number {
    const pid = this.labelIndex.get(label)
    if (!pid) return 0
    const entry = this.supervised.get(pid)
    if (!entry) return 0
    return Math.floor((Date.now() - entry.startTime) / 1000)
  }

  /** 获取进程重启次数 */
  getRestartCount(label: string): number {
    const pid = this.labelIndex.get(label)
    if (!pid) return 0
    return this.supervised.get(pid)?.restartCount || 0
  }

  /** 受管进程数量 */
  get count(): number {
    return this.supervised.size
  }

  /** 获取所有受管进程标签 */
  get labels(): string[] {
    return Array.from(this.labelIndex.keys())
  }

  /** 主动停止指定进程 */
  stopProcess(label: string): void {
    const pid = this.labelIndex.get(label)
    if (!pid) return

    const entry = this.supervised.get(pid)
    if (!entry) return

    AppLogger.info(LOG_TAGS.SYSTEM, `[ProcessSupervisor] 主动停止: ${label} (PID: ${pid})`)
    this.restartCallbacks.delete(label)
    ProcessManager.killTree(pid)
    this.supervised.delete(pid)
    this.labelIndex.delete(label)
  }

  /** 关闭前清理所有受管进程，确保不驻留 */
  shutdown(): void {
    this.isShuttingDown = true
    const count = this.supervised.size

    this.restartCallbacks.clear()

    if (count > 0) {
      AppLogger.info(LOG_TAGS.SYSTEM, `[ProcessSupervisor] 清理 ${count} 个受管进程`)

      for (const [pid, entry] of this.supervised) {
        try {
          if (os.platform() === 'win32') {
            ProcessManager.killTree(pid)
          } else {
            entry.process.kill('SIGTERM')
          }
        } catch {
          // 进程可能已退出
        }
      }

      this.supervised.clear()
      this.labelIndex.clear()
    }
  }

  /** 处理进程退出 — 同步清理索引，触发自动重启 */
  private handleExit(
    pid: number,
    label: string,
    code: number | null,
    signal: string | null,
    maxRestarts: number
  ): void {
    const entry = this.supervised.get(pid)
    const restartCount = entry ? entry.restartCount : 0

    this.supervised.delete(pid)
    if (this.labelIndex.get(label) === pid) {
      this.labelIndex.delete(label)
    }

    if (this.isShuttingDown) {
      this.restartCallbacks.delete(label)
      AppLogger.info(LOG_TAGS.SYSTEM, `[ProcessSupervisor] ${label} 已随关闭退出`)
      return
    }

    AppLogger.warn(
      LOG_TAGS.SYSTEM,
      `[ProcessSupervisor] ${label} 退出 (code: ${code}, signal: ${signal}), ` +
        `已重启 ${restartCount}/${maxRestarts} 次`
    )

    const onRestart = this.restartCallbacks.get(label)
    if (!onRestart || restartCount >= maxRestarts) {
      if (restartCount >= maxRestarts) {
        this.restartCallbacks.delete(label)
        AppLogger.error(LOG_TAGS.SYSTEM, `[ProcessSupervisor] ${label} 已达最大重启次数 ${maxRestarts}，放弃自动恢复`)
      }
      return
    }

    const delayMs = 2000
    AppLogger.info(LOG_TAGS.SYSTEM, `[ProcessSupervisor] ${label} 将在 ${delayMs}ms 后自动重启 (第 ${restartCount + 1} 次)...`)

    setTimeout(() => {
      onRestart(label, restartCount + 1)
        .then((newProc) => {
          if (!newProc || !newProc.pid) {
            AppLogger.error(LOG_TAGS.SYSTEM, `[ProcessSupervisor] ${label} 重启回调返回空进程，放弃`)
            this.restartCallbacks.delete(label)
            return
          }

          const newEntry: SupervisedProcess = {
            pid: newProc.pid,
            label,
            startTime: Date.now(),
            restartCount: restartCount + 1,
            maxRestarts,
            process: newProc
          }

          this.supervised.set(newProc.pid, newEntry)
          this.labelIndex.set(label, newProc.pid)
          ProcessManager.register(newProc, label)

          newProc.on('exit', (c, s) => {
            this.handleExit(newProc.pid!, label, c, s, maxRestarts)
          })

          newProc.on('error', (err) => {
            AppLogger.error(LOG_TAGS.SYSTEM, `[ProcessSupervisor] 进程错误 [${label}]: ${err.message}`)
          })

          AppLogger.info(LOG_TAGS.SYSTEM, `[ProcessSupervisor] ${label} 自动重启成功 (新 PID: ${newProc.pid}, 第 ${restartCount + 1} 次)`)
        })
        .catch((err) => {
          AppLogger.error(LOG_TAGS.SYSTEM, `[ProcessSupervisor] ${label} 重启回调异常`, err)
          this.restartCallbacks.delete(label)
        })
    }, delayMs)
  }

  /** 记录重启后更新索引（由 AiRuntimeManager 调用） */
  recordRestart(label: string, newPid: number): void {
    const oldEntry = Array.from(this.supervised.values()).find((e) => e.label === label)
    const restartCount = oldEntry ? oldEntry.restartCount + 1 : 1

    this.labelIndex.set(label, newPid)

    AppLogger.info(
      LOG_TAGS.SYSTEM,
      `[ProcessSupervisor] ${label} 已重启，新 PID: ${newPid} (第 ${restartCount} 次)`
    )
  }
}
