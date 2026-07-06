/**
 * @enum LogLevel
 * @description 全局日志级别规范
 */
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FATAL = 'FATAL'
}

/**
 * @enum LogProcess
 * @description 进程标识符
 */
export enum LogProcess {
  MAIN = 'MAIN',
  RENDERER = 'RENDER',
  WORKER = 'WORKER'
}

export const LOG_TAGS = {
  BOOTSTRAP: 'Bootstrap',
  IPC_GATEWAY: 'IPC_Gateway',
  AI_DAEMON: 'AI_Daemon',
  MEDIA_ENGINE: 'Media_Engine',
  ENGINE: 'Engine',
  DATABASE: 'Database',
  SCHEDULER: 'Job_Scheduler',
  SYSTEM: 'System',
  AI_ENGINE: 'AI_Engine',
  AI_AGENT: 'AI_Agent',
  EXPORT: 'Export',
  MEDIA: 'Media'
} as const;

export interface LogPayload {
  level: LogLevel;
  process: LogProcess;
  module: string;
  traceId?: string;
  message: string;
  meta?: any;
}
