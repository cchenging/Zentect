import { ZodError, ZodSchema } from 'zod';
import { VALIDATION_ERROR_RESPONSE } from '../../shared/contracts/ipc';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';

interface GuardOk {
  ok: true;
  data: unknown;
}

interface GuardFail {
  ok: false;
  response: { success: false; error: { code: string; message: string; userIdMessage?: string } };
}

type GuardResult = GuardOk | GuardFail;

export class PayloadGuard {
  /**
   * 校验 IPC payload 是否符合 schema
   * @param schema   Zod schema
   * @param args     来自 ipcMain.handle 的原始参数数组 (event, ...payload)
   * @param strict   严格模式 (多余字段报错，暂未启用)
   */
  static validate(schema: ZodSchema, args: unknown[], _strict = false): GuardResult {
    // args[0] 是 IpcMainInvokeEvent，从 args[1] 开始是业务 payload
    const payload = args.length >= 2 ? args[1] : undefined;

    try {
      const parsed = schema.parse(payload);
      return { ok: true, data: parsed };
    } catch (err) {
      const zodError = err instanceof ZodError ? err : null;

      const message = zodError
        ? zodError.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        : '请求参数不符合约定格式';

      AppLogger.warn(LOG_TAGS.SYSTEM, `PayloadGuard 拦截非法 payload`, {
        issues: zodError?.issues.slice(0, 5).map(i => ({ path: i.path.join('.'), msg: i.message })),
      });

      return {
        ok: false,
        response: VALIDATION_ERROR_RESPONSE(message),
      };
    }
  }

  /**
   * 提供 args 中的 event 引用 (少数 handler 需要 webContents)
   */
  static extractEvent(args: unknown[]): unknown {
    return args[0];
  }
}
