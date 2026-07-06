import { AppLogger } from './AppLogger'
import { LOG_TAGS } from '../../infra/logger/LogConstants'
import fs from 'fs'
import path from 'path'
import os from 'os'

interface CrashReport {
  timestamp: string
  type: 'uncaughtException' | 'unhandledRejection'
  message: string
  stack?: string
  platform: string
  arch: string
  nodeVersion: string
  electronVersion: string
  appVersion: string
}

export class CrashReporter {
  private static instance: CrashReporter
  private crashDir: string
  private initialized = false

  private constructor() {
    this.crashDir = path.join(os.tmpdir(), 'zentect-crashes')
  }

  static getInstance(): CrashReporter {
    if (!CrashReporter.instance) {
      CrashReporter.instance = new CrashReporter()
    }
    return CrashReporter.instance
  }

  /** 注册全局崩溃钩子 */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    if (!fs.existsSync(this.crashDir)) {
      fs.mkdirSync(this.crashDir, { recursive: true })
    }

    process.on('uncaughtException', (error: Error) => {
      this.capture('uncaughtException', error)
    })

    process.on('unhandledRejection', (reason: any) => {
      const msg = reason instanceof Error ? reason.message : String(reason)
      const stack = reason instanceof Error ? reason.stack : undefined
      this.capture('unhandledRejection', { message: msg, stack } as Error)
    })

    AppLogger.info(LOG_TAGS.SYSTEM, 'CrashReporter 已就绪', { crashDir: this.crashDir })
  }

  /** 捕获崩溃并写入本地报告 */
  private capture(type: CrashReport['type'], error: Error): void {
    const report: CrashReport = {
      timestamp: new Date().toISOString(),
      type,
      message: error.message || 'Unknown',
      stack: error.stack?.slice(0, 4096),
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      nodeVersion: process.versions.node || '',
      electronVersion: process.versions.electron || '',
      appVersion: process.env.npm_package_version || '1.0.0'
    }

    const fileName = `crash-${type}-${Date.now()}.json`
    const filePath = path.join(this.crashDir, fileName)

    try {
      fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8')
      AppLogger.fatal(
        LOG_TAGS.SYSTEM,
        `崩溃报告已保存: ${fileName}\n` +
          `  类型: ${type}\n` +
          `  消息: ${report.message}\n` +
          `  路径: ${filePath}`
      )
    } catch (writeErr) {
      AppLogger.error(LOG_TAGS.SYSTEM, '写入崩溃报告失败', writeErr)
    }

    // 保留最近 20 个报告，自动清理旧报告
    this.cleanupOldReports(20)
  }

  /** 获取所有历史崩溃报告 */
  getReports(): CrashReport[] {
    try {
      if (!fs.existsSync(this.crashDir)) return []
      return fs
        .readdirSync(this.crashDir)
        .filter((f) => f.endsWith('.json'))
        .slice(-20)
        .map((f) => {
          try {
            const content = fs.readFileSync(path.join(this.crashDir, f), 'utf-8')
            return JSON.parse(content) as CrashReport
          } catch {
            return null
          }
        })
        .filter((r): r is CrashReport => r !== null)
    } catch {
      return []
    }
  }

  private cleanupOldReports(maxKeep: number): void {
    try {
      const files = fs
        .readdirSync(this.crashDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
      if (files.length > maxKeep) {
        files.slice(0, files.length - maxKeep).forEach((f) => {
          fs.unlinkSync(path.join(this.crashDir, f))
        })
      }
    } catch {
      /* 静默失败 */
    }
  }
}
