import os from 'os';
import { ComputeResourceManager } from '../core/ComputeResourceManager';
import { AIDaemon } from '../core/AIDaemon';
import { SQLiteConnection } from '../database/core/SQLiteConnection';
import { PathManager } from '../utils/pathManager';
import fs from 'fs';

interface HealthReport {
  timestamp: number
  uptime: number
  platform: string
  hostname: string
  cpu: { model: string; cores: number; percent: number }
  memory: { totalMB: number; freeMB: number; percent: number }
  disk: { freeGB: number; totalGB: number } | null
  process: { pid: number; uptimeS: number; memoryMB: number }
  services: { db: boolean; aiDaemon: boolean; ffmpeg: boolean }
  /** 🔧 V5 新增：SQLite 版本号（供健康检查主行显示，替代详情 Modal） */
  sqliteVersion: string
  /** 🔧 V5 新增：存储路径可写性检测（替代旧版硬编码"所有路径可写入"） */
  pathsWritable: { projects: boolean; exports: boolean; models: boolean }
  paths: Record<string, string>
}

export class HealthService {
  private startTime = Date.now()

  private resourceManager = ComputeResourceManager.getInstance()

  /** 收集完整健康报告 */
  collect(): HealthReport {
    const snap = this.resourceManager.snapshot()
    const procMem = process.memoryUsage()

    return {
      timestamp: snap.timestamp,
      uptime: Date.now() - this.startTime,
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      hostname: os.hostname(),
      cpu: {
        model: os.cpus()[0]?.model || 'Unknown',
        cores: os.cpus().length,
        percent: snap.cpuPercent
      },
      memory: {
        totalMB: snap.totalMemMB,
        freeMB: snap.freeMemMB,
        percent: Math.round((1 - snap.freeMemMB / snap.totalMemMB) * 100)
      },
      disk: this.getDiskInfo(),
      process: {
        pid: process.pid,
        uptimeS: Math.round(process.uptime()),
        memoryMB: Math.round(procMem.rss / (1024 * 1024))
      },
      services: this.checkServices(),
      // 🔧 V5：SQLite 版本号供主行显示 "SQLite v3.45.0 · 已连接"
      sqliteVersion: this.getSqliteVersion(),
      // 🔧 V5：真实检测存储路径可写性（替代旧版硬编码"所有路径可写入"）
      pathsWritable: {
        projects: this.checkPathWritable(PathManager.getProjectsPath()),
        exports: this.checkPathWritable(PathManager.getExportRootPath()),
        models: this.checkPathWritable(PathManager.getModelsPath()),
      },
      paths: {
        userData: PathManager.getUserDataPath(),
        projects: PathManager.getProjectsPath(),
        exports: PathManager.getExportRootPath(),
        models: PathManager.getModelsPath(),
        logs: PathManager.getLogsPath()
      }
    }
  }

  /** 简要冒烟检查：核心服务是否存活 */
  smokeTest(): { passed: boolean; checks: { name: string; ok: boolean; detail: string }[] } {
    const checks = [
      {
        name: '数据库连接',
        ok: this.checkDatabase(),
        detail: this.checkDatabase() ? 'SQLite 读写正常' : '数据库连接异常'
      },
      {
        name: 'FFmpeg',
        ok: this.checkFFmpeg(),
        detail: this.checkFFmpeg() ? 'FFmpeg 就绪' : 'FFmpeg 缺失'
      },
      {
        name: 'AI 守护进程',
        ok: this.checkAiDaemon(),
        detail: this.checkAiDaemon() ? 'Python Daemon 存活' : 'Python Daemon 离线',
      },
      {
        name: 'CPU 负载',
        ok: this.resourceManager.snapshot().cpuPercent < 90,
        detail: `CPU ${this.resourceManager.snapshot().cpuPercent}%`
      },
      {
        name: '可用内存',
        ok: this.resourceManager.snapshot().freeMemMB > 256,
        detail: `空闲 ${this.resourceManager.snapshot().freeMemMB}MB`
      }
    ]

    return {
      passed: checks.every((c) => c.ok),
      checks
    }
  }

  /**
   * 🔧 V5 新增：获取 SQLite 版本号（供健康检查主行显示）
   *   格式如 "3.45.0"，失败返回 "unknown"
   */
  private getSqliteVersion(): string {
    try {
      const db = SQLiteConnection.getInstance().getDB()
      const row = db.pragma('sqlite_version') as Array<{ sqlite_version: string }>
      return row[0]?.sqlite_version || 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * 🔧 V5 新增：检测路径可写性（替代旧版硬编码"所有路径可写入"）
   *   通过尝试创建临时文件验证写权限
   */
  private checkPathWritable(dirPath: string): boolean {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
      }
      const testFile = `${dirPath}/.health_write_test_${Date.now()}`
      fs.writeFileSync(testFile, 'ok', { flag: 'w' })
      fs.unlinkSync(testFile)
      return true
    } catch {
      return false
    }
  }

  private checkDatabase(): boolean {
    try {
      const db = SQLiteConnection.getInstance().getDB()
      const result = db.prepare('SELECT 1 as ok').get() as { ok: number } | undefined
      return result?.ok === 1
    } catch {
      return false
    }
  }

  private checkFFmpeg(): boolean {
    const ffmpegPath = PathManager.getBinPath(
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    )
    return fs.existsSync(ffmpegPath)
  }

  private checkAiDaemon(): boolean {
    try {
      return AIDaemon.getInstance().isTTSReady();
    } catch {
      return false;
    }
  }

  private checkServices(): { db: boolean; aiDaemon: boolean; ffmpeg: boolean } {
    return {
      db: this.checkDatabase(),
      aiDaemon: this.checkAiDaemon(),
      ffmpeg: this.checkFFmpeg(),
    };
  }

  private getDiskInfo(): { freeGB: number; totalGB: number } | null {
    try {
      const projectPath = PathManager.getProjectsPath()
      const stat = fs.statfsSync ? fs.statfsSync(projectPath) : null
      if (stat) {
        return {
          freeGB: Math.round(((stat.bsize * stat.bfree) / 1024 ** 3) * 100) / 100,
          totalGB: Math.round(((stat.bsize * stat.blocks) / 1024 ** 3) * 100) / 100
        }
      }
    } catch {
      /* 非 POSIX 系统跳过 */
    }
    return null
  }
}
