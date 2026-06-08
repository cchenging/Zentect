// 📁 路径: src/main/core/IpcHandler.ts
// 🗑️ @deprecated — 所有 IPC 路由已统一迁移至 IpcRouter。此文件仅保留 IpcHandler 静态类用于向后兼容，
// registerProjectIpcHandlers() 已由 ProjectController 直接接管。计划在下一大版本移除本文件。
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IpcResponse } from '../../shared/types/ipc';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { ProjectService } from '../services/ProjectService';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';

type RouteHandler<T = any> = (event: IpcMainInvokeEvent, payload: any) => Promise<T> | T;

/**
 * 💥 核心拦截器：安全包装主进程处理函数
 * 自动拦截所有的异常，将其降级为标准的 IpcResponse 格式回传给前端，防止进程崩溃
 */
export const handleSafe = (channel: string, handler: RouteHandler) => {
  ipcMain.handle(channel, async (event, payload): Promise<IpcResponse> => {
    try {
      // 可以在这里做全局的中间件逻辑，比如权限校验、耗时打点等
      const startTime = Date.now();
      const data = await handler(event, payload);
      const cost = Date.now() - startTime;

      AppLogger.info(LOG_TAGS.IPC_GATEWAY, `[IPC Route] ${channel} - Success (${cost}ms)`);

      return { success: true, data };
    } catch (error: any) {
      // 集中式异常处理
      const errorMsg = error?.message || String(error);
      AppLogger.error(`[IPC Crash] ${channel} - Failed:`, error);

      return {
        success: false,
        error: errorMsg,
        errorCode: error?.code || 500
      };
    }
  });
};

/**
 * 💥 工业级规范：带全局异常捕获和统一返回格式的 IPC 处理器
 * 彻底杜绝主进程直接把原生报错砸向前端！
 */
export class IpcHandler {
  static handle<T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T) {
    // 💥 核心修复：先移除已有 handler，防止热更新或重复注册导致崩溃
    ipcMain.removeHandler(channel);

    // 强制约束返回值为 IPCResponse<T>
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResponse<T>> => {
      const startTime = Date.now();
      try {
        const data = await handler(event, ...args);
        // 💥 新增：自动注入性能监控日志
        AppLogger.info(LOG_TAGS.IPC_GATEWAY, `[IPC Route] ${channel} 执行耗时: ${Date.now() - startTime}ms`);
        return { success: true, data };
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        AppLogger.error(`[IPC Crash] ${channel} - Failed:`, error);
        return {
          success: false,
          error: errorMsg,
          errorCode: error?.code || 500
        };
      }
    });
  }
}

// 💥 工作流实例化 IPC 处理
const projectService = new ProjectService();

// 💥 注册项目实例化信道
export function registerProjectIpcHandlers() {
  IpcHandler.handle(IPC_CHANNELS.PROJECT_INSTANTIATE, async (_, { templateId }) => {
    return await projectService.instantiateTemplate(templateId);
  });
}
