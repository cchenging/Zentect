// 📁 路径: src/infra/error/AppError.ts
// 💥 工业级规范：全站统一的全局错误码字典 (SSOT)

export enum ErrorCode {
  // === 系统级错误 ===
  SYS_UNKNOWN = 'SYS_UNKNOWN',                 // 未知系统异常
  SYS_IPC_FAILED = 'SYS_IPC_FAILED',           // IPC 通信通道崩溃
  SYS_ENV_ERROR = 'SYS_ENV_ERROR',             // 运行环境/路径异常

  // === 数据库与存储错误 ===
  DB_CONNECTION_FAILED = 'DB_CONNECTION_FAILED', // 数据库连接失败
  DB_READ_ERROR = 'DB_READ_ERROR',             // 数据读取失败
  DB_WRITE_ERROR = 'DB_WRITE_ERROR',           // 数据写入失败
  DB_RECORD_NOT_FOUND = 'DB_RECORD_NOT_FOUND',   // 数据记录不存在
  DATABASE_ERROR = 'DATABASE_ERROR',           // 通用数据库错误

  // === 项目业务错误 ===
  PROJECT_NAME_DUPLICATE = 'PROJECT_NAME_DUPLICATE', // 项目名称重复

  // === 媒体与文件系统错误 ===
  FS_FILE_NOT_FOUND = 'FS_FILE_NOT_FOUND',       // 物理文件丢失
  FS_PATH_INVALID = 'FS_PATH_INVALID',           // 文件路径不合法
  FS_READ_ERROR = 'FS_READ_ERROR',             // 文件读取权限被拒
  FS_WRITE_ERROR = 'FS_WRITE_ERROR',           // 文件写入失败(磁盘满)
  MEDIA_PARSE_FAILED = 'MEDIA_PARSE_FAILED',     // FFprobe 媒体解析失败

  // === AI 与微服务错误 ===
  AI_SERVICE_OFFLINE = 'AI_SERVICE_OFFLINE',     // AI 守护进程未启动
  AI_PROCESS_FAILED = 'AI_PROCESS_FAILED',       // AI 算法执行崩溃
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT'          // 外部网络/接口超时
}

// 💥 工业级规范：标准应用异常类
export class AppError extends Error {
  public code: ErrorCode;
  public details?: any;

  constructor(code: ErrorCode, message?: string, details?: any) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    
    // 维持原型链，确保 instanceof 校验正常
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
