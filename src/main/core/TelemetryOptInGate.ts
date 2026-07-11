import { SettingsRepository } from '../database/repositories/SettingsRepository'
import { AppLogger } from '../core/AppLogger'
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants'

export class TelemetryOptInGate {
  private static instance: TelemetryOptInGate
  private settingsRepo = new SettingsRepository()
  private readonly SETTING_KEY = 'telemetry.optIn'
  private cached: boolean | null = null

  private constructor() {}

  static getInstance(): TelemetryOptInGate {
    if (!TelemetryOptInGate.instance) {
      TelemetryOptInGate.instance = new TelemetryOptInGate()
    }
    return TelemetryOptInGate.instance
  }

  /** 用户是否已同意遥测 */
  isOptedIn(): boolean {
    if (this.cached !== null) return this.cached
    this.cached = this.settingsRepo.get<boolean>(this.SETTING_KEY, false)
    return this.cached
  }

  /** 设置用户选择 */
  setOptIn(optedIn: boolean): void {
    this.cached = optedIn
    this.settingsRepo.saveSettings({ [this.SETTING_KEY]: optedIn })
    AppLogger.info(LOG_TAGS.SYSTEM, `遥测授权: ${optedIn ? '已同意' : '已拒绝'}`)
  }

  /** 判断某项数据是否可以收集 */
  canCollect(category: 'crash' | 'usage' | 'feature' | 'performance'): boolean {
    const optedIn = this.isOptedIn()
    // 崩溃报告始终允许（安全必需）
    if (category === 'crash') return true
    return optedIn
  }

  /** 重置缓存（设置变更后重新加载） */
  resetCache(): void {
    this.cached = null
  }
}
