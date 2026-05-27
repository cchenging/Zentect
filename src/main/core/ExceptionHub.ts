// 📁 路径：src/main/core/ExceptionHub.ts
// Layer 5: 异常归一化翻译官 — 将各种野鸡报错清洗为标准 I18N Key 契约载荷
import { AppError, ErrorCode } from '../../shared/utils/AppError';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';

/** 标准化 I18N 错误载荷 — 主进程只传递 Key，前端字典负责渲染具体语种 */
export interface I18NErrorPayload {
  code: ErrorCode;
  titleKey: string;    // 传递给前端 useI18n 的 Key 契约
  promptKey: string;   // 详细提示 Key
  rawMessage: string;  // 留底日志排查
}

export class ExceptionHub {
  /**
   * 将任意异常归一化为 I18N Key 契约载荷
   * @param error 原始异常对象
   * @returns 标准化的 I18N 错误载荷
   */
  public static normalize(error: any): I18NErrorPayload {
    const rawMsg = String(error?.message || error || '').toLowerCase();

    // 1. 鉴权失败 (401 / 密钥错误)
    if (rawMsg.includes('401') || rawMsg.includes('unauthorized') || rawMsg.includes('api key')) {
      return {
        code: ErrorCode.SYS_ENV_ERROR,
        titleKey: 'engine_errors.AI_AUTH_FAILED_TITLE',
        promptKey: 'engine_errors.AI_AUTH_FAILED_PROMPT',
        rawMessage: rawMsg,
      };
    }

    // 2. 流量超限与服务限流 (429 / 欠费 / quota)
    if (rawMsg.includes('429') || rawMsg.includes('rate limit') || rawMsg.includes('quota') || rawMsg.includes('insufficient')) {
      return {
        code: ErrorCode.AI_PROCESS_FAILED,
        titleKey: 'engine_errors.AI_QUOTA_LIMIT_TITLE',
        promptKey: 'engine_errors.AI_QUOTA_LIMIT_PROMPT',
        rawMessage: rawMsg,
      };
    }

    // 3. 本地 AI 守护进程离线 — 触发静默自愈
    if (rawMsg.includes('daemon offline') || rawMsg.includes('econnrefused') || rawMsg.includes('clip_search')) {
      this.triggerDaemonSelfHealing(rawMsg);
      return {
        code: ErrorCode.AI_SERVICE_OFFLINE,
        titleKey: 'engine_errors.DAEMON_OFFLINE_TITLE',
        promptKey: 'engine_errors.DAEMON_OFFLINE_AUTOHAL_PROMPT',
        rawMessage: rawMsg,
      };
    }

    // 4. 外部网络通讯超时
    if (rawMsg.includes('timeout') || rawMsg.includes('etimedout')) {
      return {
        code: ErrorCode.NETWORK_TIMEOUT,
        titleKey: 'engine_errors.NETWORK_TIMEOUT_TITLE',
        promptKey: 'engine_errors.NETWORK_TIMEOUT_PROMPT',
        rawMessage: rawMsg,
      };
    }

    // 5. 物理断网拦截（Node.js fetch failed）
    if (rawMsg.includes('fetch failed') || rawMsg.includes('物理断网')) {
      return {
        code: ErrorCode.NETWORK_TIMEOUT,
        titleKey: 'engine_errors.NETWORK_TIMEOUT_TITLE',
        promptKey: 'engine_errors.NETWORK_TIMEOUT_PROMPT',
        rawMessage: rawMsg,
      };
    }

    // 6. JSON 契约破损（大模型输出格式异常）
    if (rawMsg.includes('json') && (rawMsg.includes('parse') || rawMsg.includes('contract') || rawMsg.includes('unexpected'))) {
      return {
        code: ErrorCode.AI_PROCESS_FAILED,
        titleKey: 'engine_errors.DAEMON_CONTRACT_BROKEN_TITLE',
        promptKey: 'engine_errors.DAEMON_CONTRACT_BROKEN_PROMPT',
        rawMessage: rawMsg,
      };
    }

    // 7. 兜底：未知异常
    return {
      code: ErrorCode.AI_PROCESS_FAILED,
      titleKey: 'engine_errors.DAEMON_CONTRACT_BROKEN_TITLE',
      promptKey: 'engine_errors.DAEMON_CONTRACT_BROKEN_PROMPT',
      rawMessage: rawMsg,
    };
  }

  /**
   * 触发 AI 守护进程静默自愈 — 停止并重新拉起本地 Python 运行时
   * @param rawMsg 原始错误信息
   */
  private static triggerDaemonSelfHealing(rawMsg: string): void {
    AppLogger.warn(LOG_TAGS.SYSTEM, '检测到本地 AI 守护进程响应中断，触发引擎静默自愈序列...');

    try {
      // 延迟导入避免循环依赖
      const { AIDaemon } = require('./AIDaemon') as typeof import('./AIDaemon');
      const daemon = AIDaemon.getInstance();
      daemon.stop();
      daemon.start();
      AppLogger.info(LOG_TAGS.SYSTEM, 'AI 守护进程自愈重启已触发');
    } catch (recoveryError) {
      AppLogger.error(LOG_TAGS.SYSTEM, '致命：运行时本地自愈重启失败', recoveryError);
    }
  }

  /**
   * 将 I18N 载荷转换为可序列化的 IPC 传输对象
   */
  public static toIPCPayload(payload: I18NErrorPayload): Record<string, string> {
    return {
      code: payload.code,
      titleKey: payload.titleKey,
      promptKey: payload.promptKey,
      rawMessage: payload.rawMessage,
    };
  }
}
