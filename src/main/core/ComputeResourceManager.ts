import { AppLogger } from './AppLogger'
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants'
import os from 'os'

interface ResourceSnapshot {
  cpuPercent: number
  freeMemMB: number
  totalMemMB: number
  loadAvg: number[]
  timestamp: number
}

interface ResourceThresholds {
  maxCpuPercent: number
  minFreeMemMB: number
  cooldownMs: number
}

export class ComputeResourceManager {
  private static instance: ComputeResourceManager
  private thresholds: ResourceThresholds
  private lastThrottleTime = 0
  private cpuHistory: number[] = []

  private constructor() {
    this.thresholds = {
      maxCpuPercent: 85,
      minFreeMemMB: 512,
      cooldownMs: 30000
    }
  }

  static getInstance(): ComputeResourceManager {
    if (!ComputeResourceManager.instance) {
      ComputeResourceManager.instance = new ComputeResourceManager()
    }
    return ComputeResourceManager.instance
  }

  /** 获取当前资源快照 */
  snapshot(): ResourceSnapshot {
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const cpuPercent = this.sampleCpu()

    this.cpuHistory.push(cpuPercent)
    if (this.cpuHistory.length > 10) this.cpuHistory.shift()

    return {
      cpuPercent,
      freeMemMB: Math.round(freeMem / (1024 * 1024)),
      totalMemMB: Math.round(totalMem / (1024 * 1024)),
      loadAvg: os.loadavg(),
      timestamp: Date.now()
    }
  }

  /** 是否应该限流（资源过载） */
  shouldThrottle(): { throttle: boolean; reason: string } {
    const snap = this.snapshot()
    const now = Date.now()

    if (now - this.lastThrottleTime < this.thresholds.cooldownMs) {
      return { throttle: false, reason: '' }
    }

    if (snap.cpuPercent > this.thresholds.maxCpuPercent) {
      this.lastThrottleTime = now
      return {
        throttle: true,
        reason: `CPU 过载: ${snap.cpuPercent}% > ${this.thresholds.maxCpuPercent}%`
      }
    }

    if (snap.freeMemMB < this.thresholds.minFreeMemMB) {
      this.lastThrottleTime = now
      return {
        throttle: true,
        reason: `内存不足: ${snap.freeMemMB}MB < ${this.thresholds.minFreeMemMB}MB`
      }
    }

    return { throttle: false, reason: '' }
  }

  /** 获取最近平均 CPU 使用率 */
  getAverageCpu(): number {
    if (this.cpuHistory.length === 0) return 0
    const sum = this.cpuHistory.reduce((a, b) => a + b, 0)
    return Math.round((sum / this.cpuHistory.length) * 100) / 100
  }

  /** 检查是否适合启动新的 AI 任务 */
  canStartNewTask(): { allowed: boolean; reason: string } {
    const snap = this.snapshot()
    if (snap.cpuPercent > this.thresholds.maxCpuPercent) {
      return { allowed: false, reason: 'CPU 负载过高，请等待当前任务完成' }
    }
    if (snap.freeMemMB < this.thresholds.minFreeMemMB) {
      return { allowed: false, reason: '可用内存不足，请关闭其他应用后重试' }
    }
    return { allowed: true, reason: '' }
  }

  /** 更新阈值配置 */
  setThresholds(thresholds: Partial<ResourceThresholds>): void {
    Object.assign(this.thresholds, thresholds)
    AppLogger.info(LOG_TAGS.SYSTEM, '资源阈值已更新', this.thresholds)
  }

  /** 简单的 CPU 采样（基于空闲时间差值） */
  private sampleCpu(): number {
    const cpus = os.cpus()
    let totalIdle = 0
    let totalTick = 0

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += (cpu.times as any)[type]
      }
      totalIdle += cpu.times.idle
    }

    return Math.round((1 - totalIdle / totalTick) * 100)
  }
}
