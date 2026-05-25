// 📁 路径：src/shared/types/ipc.ts

/**
 * 💥 全局 IPC 通信标准响应体 (The Envelope)
 * 所有主进程的 handle 返回值必须符合此结构
 */
export interface IpcResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string | number;
}
