import { API } from '../api';
import { LogLevel, LogProcess } from '../../../modules/infra/logger/LogConstants';

/**
 * @class FrontendLogger
 * @description 前端渲染进程专属日志记录仪，自动跨进程同步至主日志文件
 */
export class FrontendLogger {
  
  /**
   * 生成轻量级端到端追踪 ID
   */
  public static generateTraceId(): string {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
  }

  private static dispatch(level: LogLevel, module: string, message: string, traceId?: string, meta?: any) {
    // 1. 打印到浏览器控制台 (方便开发时抓虫)
    const time = new Date().toLocaleTimeString();
    const prefix = `[${time}] [${level}] [${module}]`;
    switch(level) {
      case LogLevel.INFO: console.info(`%c${prefix}`, 'color: #10b981', message, traceId ? `[Trace: ${traceId}]` : '', meta || ''); break;
      case LogLevel.ERROR: console.error(`%c${prefix}`, 'color: #ef4444', message, traceId ? `[Trace: ${traceId}]` : '', meta || ''); break;
      case LogLevel.WARN: console.warn(`%c${prefix}`, 'color: #f59e0b', message, traceId ? `[Trace: ${traceId}]` : '', meta || ''); break;
      default: console.log(`%c${prefix}`, 'color: #6b7280', message, traceId ? `[Trace: ${traceId}]` : '', meta || '');
    }

    // 2. 异步推送到主进程物理文件
    try {
      API.system.log({
        level,
        process: LogProcess.RENDERER, // 💥 标记为前端案发现场
        module,
        traceId,
        message,
        meta
      });
    } catch (e) {
      // 忽略网关尚未就绪的早期日志
    }
  }

  public static debug(module: string, message: string, traceId?: string, meta?: any) {
    this.dispatch(LogLevel.DEBUG, module, message, traceId, meta);
  }
  public static info(module: string, message: string, traceId?: string, meta?: any) {
    this.dispatch(LogLevel.INFO, module, message, traceId, meta);
  }
  public static warn(module: string, message: string, traceId?: string, meta?: any) {
    this.dispatch(LogLevel.WARN, module, message, traceId, meta);
  }
  public static error(module: string, message: string, traceId?: string, meta?: any) {
    this.dispatch(LogLevel.ERROR, module, message, traceId, meta);
  }
}
