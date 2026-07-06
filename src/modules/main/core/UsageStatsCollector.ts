import { SQLiteConnection } from '../database/core/SQLiteConnection'
import { TelemetryOptInGate } from '../core/TelemetryOptInGate'
import { AppLogger } from '../core/AppLogger'
import { LOG_TAGS } from '../../infra/logger/LogConstants'

interface UsageEvent {
  category: 'pipeline' | 'export' | 'editor' | 'settings' | 'project'
  action: string
  label?: string
  value?: number
  timestamp: number
}

interface SessionStats {
  startTime: number
  endTime: number
  pipelineRuns: number
  exportCount: number
  projectsCreated: number
}

export class UsageStatsCollector {
  private static instance: UsageStatsCollector
  private optInGate = TelemetryOptInGate.getInstance()
  private currentSession: SessionStats | null = null
  private initialized = false

  private get db() {
    return SQLiteConnection.getInstance().getDB()
  }

  private constructor() {}

  static getInstance(): UsageStatsCollector {
    if (!UsageStatsCollector.instance) {
      UsageStatsCollector.instance = new UsageStatsCollector()
    }
    return UsageStatsCollector.instance
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        label TEXT,
        value REAL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_category ON usage_stats(category);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_stats(timestamp);
    `)

    this.startSession()
    AppLogger.info(LOG_TAGS.SYSTEM, 'UsageStatsCollector 已就绪 (本地不联网)')
  }

  /** 记录单次使用事件 */
  track(category: UsageEvent['category'], action: string, label?: string, value?: number): void {
    if (!this.optInGate.canCollect('usage')) return

    const event: UsageEvent = {
      category,
      action,
      label,
      value,
      timestamp: Date.now()
    }

    try {
      this.db
        .prepare(
          'INSERT INTO usage_stats (category, action, label, value, timestamp) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          event.category,
          event.action,
          event.label || null,
          event.value ?? null,
          event.timestamp
        )
    } catch (err) {
      AppLogger.error(LOG_TAGS.DATABASE, '写入使用统计失败', err)
    }
  }

  /** 获取指定类别的统计摘要 */
  getSummary(
    category?: string,
    daysBack = 30
  ): { totalEvents: number; byAction: Record<string, number> } {
    const since = Date.now() - daysBack * 86400000
    const whereCategory = category ? 'AND category = ?' : ''
    const params: any[] = [since]
    if (category) params.push(category)

    const rows = this.db
      .prepare(
        `SELECT action, COUNT(*) as cnt FROM usage_stats WHERE timestamp > ? ${whereCategory} GROUP BY action`
      )
      .all(...params) as { action: string; cnt: number }[]

    const byAction: Record<string, number> = {}
    let total = 0
    for (const row of rows) {
      byAction[row.action] = row.cnt
      total += row.cnt
    }

    return { totalEvents: total, byAction }
  }

  /** 开始新会话 */
  private startSession(): void {
    this.currentSession = {
      startTime: Date.now(),
      endTime: 0,
      pipelineRuns: 0,
      exportCount: 0,
      projectsCreated: 0
    }
  }

  /** 获取当前会话统计 */
  getCurrentSession(): SessionStats | null {
    return this.currentSession
  }

  /** 记录 pipeline 运行 */
  recordPipelineRun(): void {
    this.track('pipeline', 'run')
    if (this.currentSession) this.currentSession.pipelineRuns++
  }

  /** 记录导出 */
  recordExport(): void {
    this.track('export', 'export')
    if (this.currentSession) this.currentSession.exportCount++
  }

  /** 清理旧数据 */
  cleanup(daysToKeep = 90): void {
    const cutoff = Date.now() - daysToKeep * 86400000
    this.db.prepare('DELETE FROM usage_stats WHERE timestamp < ?').run(cutoff)
    AppLogger.info(LOG_TAGS.DATABASE, `清理 ${daysToKeep} 天前的使用统计`)
  }
}
