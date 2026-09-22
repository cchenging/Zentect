// 📁 路径: src/infra/logger/AppLogger.ts
import log from 'electron-log';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { LogSanitizer } from './LogSanitizer';

// ============================================================
// 🔧 文件日志落盘（2026-09-14 重新启用，附带自动清理）
// 历史背景：早期因"旧进程持有文件句柄/描述符失效，每次写日志抛 EBADF+完整堆栈，
//        拖慢主进程（每次 IPC 都触发）"而关闭 file transport，仅保留 console。
// 现在重新启用：electron-log 的 file transport 自带"按 maxSize 自动轮转"（写满后同名 .old.log），
//        配合下方启动时的"按天/按总数"双重清理，避免日志堆成巨无霸。
//  - level = 'info'：落盘级别只记 info/warn/error，过滤掉高频 debug（如 healthcheck 心跳），省盘且够诊断
//  - maxSize  = 1MB：单份轮转就绪，多代历史由 electron-log 自动 handle；不会无限膨胀
// ============================================================
log.transports.file.level = 'info';
log.transports.file.maxSize = 1024 * 1024;

/** 🔧 用户配置的日志目录（null 表示使用默认 userData/logs）。由 main 进程在 DB 就绪后通过 setLogDir 注入。
 *  electron-log 的 file transport 每次写日志都会重新调用 resolvePathFn 求值路径，
 *  因此运行时切换日志目录无需重启、对下一条日志立即生效。 */
let configuredLogDir: string | null = null;

/** 🔧 计算当前生效的日志目录：优先取用户配置，缺省回退默认 userData/logs。 */
function getEffectiveLogDir(): string {
  return (configuredLogDir && configuredLogDir.trim())
    ? configuredLogDir.trim()
    : app.getPath('logs');
}

/** 🔧 动态日志路径：本地文件回车时每次求值（依赖 configuredLogDir，切目录立即生效，无需重启）。 */
log.transports.file.resolvePathFn = () => path.join(getEffectiveLogDir(), 'main.log');

/**
 * 🔧 启动时自动清理日志目录：双重策略防堆积。
 *  1. 按时间：删除超过 retentionDays 的日志文件（默认 7 天）；
 *  2. 按数量：若剩余文件总数仍超 maxFiles，则按修改时间删最旧的过量文件。
 *  extends/vite dev 热重载会多次执行，幂等且容忍句柄占用（删除失败静默跳过）。
 * @param retentionDays 日志保留天数，超期删除
 * @param maxFiles      日志目录下保留的最大文件数
 */
function cleanupLogFiles(retentionDays = 7, maxFiles = 20): void {
  try {
    const dirName = getEffectiveLogDir();
    if (!dirName || !fs.existsSync(dirName)) return;
    const listLogs = (): string[] => fs.readdirSync(dirName)
      .map((n) => path.join(dirName, n))
      .filter((p) => { try { return fs.statSync(p).isFile() && p.toLowerCase().endsWith('.log'); } catch { return false; } });
    // ① 按修改时间清除超期文件
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    for (const p of listLogs()) {
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* 句柄占用则跳过 */ }
    }
    // ② 超总数仍存在的，删最旧的过量文件
    const remain = listLogs();
    if (remain.length > maxFiles) {
      remain.sort((a, b) => { try { return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs; } catch { return 0; } });
      for (const p of remain.slice(0, remain.length - maxFiles)) {
        try { fs.unlinkSync(p); } catch { /* 忽略单个清理失败 */ }
      }
    }
  } catch { /* 目录不可达时静默，不阻塞启动 */ }
}

// 应用就绪后执行首次清理（app.getPath('logs') 需 app ready 后才稳定）
if (app.isReady()) {
  cleanupLogFiles();
} else {
  app.whenReady().then(() => cleanupLogFiles());
}

/**
 * 🔧 由 main 进程在 DB 就绪后注入用户配置的日志目录；并立即对新目录执行一次清理（防堆积）。
 *  electron-log file transport 每次写日志重新求值路径，因此切换目录对下一条日志立即生效，无需重启。
 * 传入空/无效值则回退默认 userData/logs（等效"使用默认位置"）。
 * @param dir 用户配置的日志目录；为空时回退默认
 */
function setLogDir(dir: string | null | undefined): void {
  configuredLogDir = (dir && dir.trim()) ? dir.trim() : null;
  if (app.isReady()) {
    cleanupLogFiles();
  } else {
    app.whenReady().then(() => cleanupLogFiles());
  }
}

// ============================================================
// Windows 中文乱码修复
// 根因：electron-log 默认的 console transport 使用 process.stdout.write
//       直接写入 UTF-8 字节，但 Windows 终端默认 GBK 编码
// 方案：自定义 writeFn 使用 console.log，Node.js 运行时会自动
//       将 UTF-8 字符串转换为终端代码页编码
// ============================================================

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

  // 🔧 统一防刷屏：CLIP 高维特征数组 dump（visionEmbedding/colorHistogram/clipZhEmbedding 可达 512 维）
  // 无论来自 daemon stdout/stderr 转发还是前端 console 转发，最终都汇聚到此 console transport。
  // 单行超长且含特征字段即判定为无诊断价值的刷屏 dump（此类特征已由落库层剥离），整行丢弃；
  // 不影响正常短日志（含 [镜头匹配] 等诊断行）的输出。
  const FEATURE_DUMP_KEYS = ['visionEmbedding', 'colorHistogram', 'clipZhEmbedding'];
  const isFeatureDump = line.length > 800 && FEATURE_DUMP_KEYS.some((k) => line.includes(k));
  if (isFeatureDump) return;

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

  /** 🔧 注入/更新日志目录（委托模块级 setLogDir）。DB 就绪后由 main 进程调用，切换目录立即生效无需重启。 */
  public static setLogDir(dir: string | null | undefined): void {
    setLogDir(dir);
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
