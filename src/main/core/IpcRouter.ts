import { z } from 'zod';
import { ipcMain } from 'electron';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { AppError, ErrorCode } from '../../shared/utils/AppError';
import type { IpcResponse } from '../../shared/contracts/ipc';
import { IPC_ERROR_CODES } from '../../shared/contracts/ipc';
import { getSchema } from '../../shared/contracts/registry';

export class IpcRouter {
  /**
   * 全局统一 IPC 路由处理器（自动 registry 校验）
   * 职责：schema 校验拦截 → 异常捕获 → 日志记录 → 标准化返回值 → 防热更新重复绑定
   *
   * 若 registry 中已为该 channel 注册 schema，则自动校验 payload 合法性。
   * 不合法 payload 立即返回 VALIDATION_ERROR，不进入业务 handler。
   * Controller 代码无需任何修改。
   */
  static handle<T>(
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T
  ) {
    // 尝试从 registry 获取已注册的 schema（无 schema 则不走校验）
    const schema = getSchema(channel);

    // 防热更新重复绑定
    ipcMain.removeHandler(channel);

    ipcMain.handle(channel, async (event, ...args): Promise<IpcResponse<T>> => {
      try {
        // Schema 校验层（仅在 registry 已注册时生效）
        if (schema) {
          const rawPayload = args.length >= 1 ? args[0] : undefined;
          const parseResult = schema.safeParse(rawPayload);

          if (!parseResult.success) {
            const firstIssue = parseResult.error.issues[0];
            const message = firstIssue
              ? `${firstIssue.path.join('.') || '(root)'}: ${firstIssue.message}`
              : '请求参数校验失败';

            AppLogger.warn(LOG_TAGS.IPC_GATEWAY,
              `PayloadGuard 拦截 [${channel}] — ${message}`);

            return {
              success: false,
              error: message,
              errorCode: IPC_ERROR_CODES.VALIDATION_ERROR,
            } as unknown as IpcResponse<T>;
          }
        }

        const data = await handler(event, ...args);
        return { success: true, data };
      } catch (error: any) {
        const isAppError = error instanceof AppError;
        const code = isAppError ? error.code : ErrorCode.SYS_UNKNOWN;
        const message = error.message || '系统底层发生未知异常';

        if (!isAppError) {
          AppLogger.error(LOG_TAGS.IPC_GATEWAY, `信道 <${channel}> 发生未捕获异常: ${message}`, { stack: error?.stack?.substring(0, 500) || '' });
        } else {
          AppLogger.warn(LOG_TAGS.IPC_GATEWAY, `业务拦截 [${channel}] - ${code}: ${message}`);
        }

        return {
          success: false,
          error: message,
          errorCode: code
        } as IpcResponse<T>;
      }
    });
  }

  /**
   * 带运行时 schema 校验的 IPC 路由处理器（显式传入 schema，不依赖 registry）
   * 验证 args[0]（第一个业务参数）是否符合 schema，不通过则返回标准 VALIDATION_ERROR
   * 通过后将 parsed data 传给 handler，避免脏数据流入业务逻辑
   */
  static handleWithSchema<T, S extends z.ZodSchema>(
    channel: string,
    schema: S,
    handler: (event: Electron.IpcMainInvokeEvent, payload: z.infer<S>) => Promise<T> | T
  ) {
    ipcMain.removeHandler(channel);

    ipcMain.handle(channel, async (event, ...args): Promise<IpcResponse<T>> => {
      try {
        const rawPayload = args.length >= 1 ? args[0] : undefined;
        const parseResult = schema.safeParse(rawPayload);

        if (!parseResult.success) {
          const firstIssue = parseResult.error.issues[0];
          const message = firstIssue
            ? `${firstIssue.path.join('.') || '(root)'}: ${firstIssue.message}`
            : '请求参数校验失败';

          AppLogger.warn(LOG_TAGS.IPC_GATEWAY,
            `PayloadGuard(显式) 拦截 [${channel}] — ${message}`);

          return {
            success: false,
            error: message,
            errorCode: IPC_ERROR_CODES.VALIDATION_ERROR,
          } as unknown as IpcResponse<T>;
        }

        const data = await handler(event, parseResult.data as z.infer<S>);
        return { success: true, data };
      } catch (error: any) {
        const isAppError = error instanceof AppError;
        const code = isAppError ? error.code : ErrorCode.SYS_UNKNOWN;
        const message = error.message || '系统底层发生未知异常';

        if (!isAppError) {
          AppLogger.error(LOG_TAGS.IPC_GATEWAY, `信道 <${channel}> 发生未捕获异常: ${message}`, { stack: error?.stack?.substring(0, 500) || '' });
        } else {
          AppLogger.warn(LOG_TAGS.IPC_GATEWAY, `业务拦截 [${channel}] - ${code}: ${message}`);
        }

        return {
          success: false,
          error: message,
          errorCode: code
        } as unknown as IpcResponse<T>;
      }
    });
  }
}
