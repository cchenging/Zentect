// 📁 路径: src/infra/logger/AppLogger.ts
import log from 'electron-log';
import { LogSanitizer } from './LogSanitizer';

// ============================================================
// Windows 中文乱码修复
// 根因：electron-log 默认的 console transport 使用 process.stdout.write
//       直接写入 UTF-8 字节，但 Windows 终端默认 GBK 编码
// 方案：自定义 writeFn 使用 console.log，Node.js 运行时会自动
//       将 UTF-8 字符串转换为终端代码页编码
// ============================================================

log.transports.file.level = 'info';
log.transports.console.level = 'debug';

(log.transports.console as unknown as { writeFn: (msg: { message: { level: string; data: any[]; date: Date } }) => void }).writeFn = ({ message }: { message: { level: string; data: any[]; date: Date } }) => {
  const level = message.level;
  const data = message.data || [];
  const d = message.date;
  const timestamp = d
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
    : '';
  const text = data.map((item: any) => {
    if (typeof item === 'string') return item;
    try { return JSON.stringify(item); } catch { return String(item); }
  }).join(' ');

  const line = `[${timestamp}] [${level}] ${text}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
};

export class AppLogger {
  public static getInstance() {
    return AppLogger;
  }

  private static formatMessage(message: string, meta?: any): string {
    if (meta === undefined || meta === null) return message;

    if (typeof meta === 'object') {
      try {
        if (meta instanceof Error) {
          const errObj = {
            message: meta.message,
            code: (meta as Error & { code?: string }).code || 'UNKNOWN',
            stack: meta.stack,
          };
          return `${message} | ERR_DETAIL: ${JSON.stringify(errObj)}`;
        }

        const safeMeta: any = Array.isArray(meta) ? [...meta] : { ...meta };
        for (const key in safeMeta) {
          if (safeMeta[key] instanceof Error) {
            safeMeta[key] = {
              message: safeMeta[key].message,
              code: (safeMeta[key] as Error & { code?: string }).code || 'UNKNOWN',
              stack: safeMeta[key].stack,
            };
          }
        }
        return `${message} | CONTEXT: ${JSON.stringify(safeMeta)}`;
      } catch {
        return `${message} | CONTEXT: [Unserializable Object]`;
      }
    }
    return `${message} | ${meta}`;
  }

  public static info(tag: string, message: string, meta?: any) {
    const sanitized = LogSanitizer.sanitize(message);
    const safeMeta = this.sanitizeMeta(meta);
    log.scope(tag).info(this.formatMessage(sanitized, safeMeta));
  }

  public static warn(tag: string, message: string, meta?: any) {
    const sanitized = LogSanitizer.sanitize(message);
    const safeMeta = this.sanitizeMeta(meta);
    log.scope(tag).warn(this.formatMessage(sanitized, safeMeta));
  }

  public static error(tag: string, message: string, meta?: any) {
    const sanitized = LogSanitizer.sanitize(message);
    const safeMeta = this.sanitizeMeta(meta);
    log.scope(tag).error(this.formatMessage(sanitized, safeMeta));
  }

  public static debug(tag: string, message: string, meta?: any) {
    const sanitized = LogSanitizer.sanitize(message);
    const safeMeta = this.sanitizeMeta(meta);
    log.scope(tag).debug(this.formatMessage(sanitized, safeMeta));
  }

  public static fatal(tag: string, message: string, meta?: any) {
    const sanitized = LogSanitizer.sanitize(message);
    const safeMeta = this.sanitizeMeta(meta);
    log.scope(tag).error(`[FATAL] ${this.formatMessage(sanitized, safeMeta)}`);
  }

  public static log(tag: string, message: string, meta?: any) {
    this.info(tag, message, meta);
  }

  private static sanitizeMeta(meta?: any): any {
    if (meta === undefined || meta === null) return meta;
    if (typeof meta === 'string') return LogSanitizer.sanitize(meta);
    if (typeof meta === 'object' && !Array.isArray(meta)) {
      try {
        return LogSanitizer.sanitizeObject(meta as Record<string, unknown>);
      } catch {
        return meta;
      }
    }
    return meta;
  }
}
