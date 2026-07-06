/**
 * 日志基础设施接口定义
 * infra/logger 模块的公共契约
 */

/** 日志级别 */
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FATAL = 'FATAL',
}

/** 日志进程标识 */
export enum LogProcess {
  MAIN = 'MAIN',
  RENDERER = 'RENDER',
  WORKER = 'WORKER',
}

/** 结构化日志载荷 */
export interface LogPayload {
  level: LogLevel;
  process: LogProcess;
  module: string;
  traceId?: string;
  message: string;
  meta?: any;
}

/** 日志器接口 —— 所有日志实现需遵循的契约 */
export interface ILogger {
  info(tag: string, message: string, meta?: any): void;
  warn(tag: string, message: string, meta?: any): void;
  error(tag: string, message: string, meta?: any): void;
  debug(tag: string, message: string, meta?: any): void;
  fatal(tag: string, message: string, meta?: any): void;
  log(tag: string, message: string, meta?: any): void;
}
