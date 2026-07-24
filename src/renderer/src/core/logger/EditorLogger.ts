/**
 * 前端 EditorLogger - 步骤组件的结构化日志
 * 批量 flush 到主进程，避免频繁 IPC
 */
import { LogLevel, LOG_TAGS } from '@modules/infra/logger/LogConstants';

interface LogEntry {
  level: LogLevel; module: string; message: string;
  meta?: string; timestamp: number;
}

class EditorLogger {
  private queue: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private maxQueueSize = 50;

  log(level: LogLevel, module: string, message: string, meta?: unknown) {
    this.queue.push({
      level, module, message,
      meta: meta ? JSON.stringify(meta).slice(0, 2000) : undefined,
      timestamp: Date.now(),
    });
    if (this.queue.length >= this.maxQueueSize) this.flush();
    else this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 2000);
  }

  private flush() {
    const batch = this.queue.splice(0);
    this.flushTimer = null;
    if (batch.length === 0) return;
    try { window.api?.system?.log?.({ batch }); } catch { /* 静默降级 */ }
  }

  info(module: string, msg: string, meta?: unknown) { this.log(LogLevel.INFO, module, msg, meta); }
  warn(module: string, msg: string, meta?: unknown) { this.log(LogLevel.WARN, module, msg, meta); }
  error(module: string, msg: string, meta?: unknown) { this.log(LogLevel.ERROR, module, msg, meta); }
  debug(module: string, msg: string, meta?: unknown) { this.log(LogLevel.DEBUG, module, msg, meta); }

  /** 埋点：步骤执行 */
  trackStep(step: number, action: 'start'|'complete'|'fail', meta?: unknown) {
    const module = 'StepRunner';
    if (action === 'start')  this.info(module, `Step ${step} started`, meta);
    if (action === 'complete') this.info(module, `Step ${step} completed`, meta);
    if (action === 'fail')  this.error(module, `Step ${step} failed`, meta);
  }

  /** 埋点：Store 写操作 */
  trackStoreMutation(store: string, field: string) {
    this.debug(LOG_TAGS.ENGINE, `Store.${store}.${field} mutated`);
  }
}

export const editorLogger = new EditorLogger();