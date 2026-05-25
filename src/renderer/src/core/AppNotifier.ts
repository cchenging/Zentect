import { toast } from 'react-hot-toast';
import { useI18n } from '../store/useI18n';
import { UI_CONSTANTS } from '../constants/ui';
import { useNotificationCenter } from '../services/NotificationCenter';
import { isFeatureEnabled } from '../../../shared/config/feature-flags';

/**
 * 全局提示调度网关 (Singleton)
 * 优势：业务组件只依赖此网关，内部可无缝切换 Toast / FeedbackBus / NotificationCenter
 *   USE_FEEDBACK_BUS=true → 同步推送 NotificationCenter（统一通知历史队列）
 *   底色保持 react-hot-toast 以避免破坏现有 UI 交互
 */
export class AppNotifier {
  /**
   * 获取翻译后的消息文本
   */
  private static getTranslatedMessage(codeOrMsg: string): string {
    if (!codeOrMsg) return '';
    const { t } = useI18n.getState();
    return ((t as { errors: Record<string, string> }).errors)?.[codeOrMsg] || codeOrMsg;
  }

  /**
   * 获取统一的基础样式
   */
  private static getBaseStyle() {
    return {
      background: UI_CONSTANTS.COLORS.BACKGROUND.DARK,
      color: UI_CONSTANTS.COLORS.TEXT.PRIMARY,
      border: `1px solid ${UI_CONSTANTS.COLORS.BORDER.DEFAULT}`,
    };
  }

  /**
   * 如果启用 FeedbackBus，同步追加到 NotificationCenter
   */
  private static syncToNotificationCenter(level: 'info' | 'success' | 'warn' | 'error', message: string): void {
    if (!isFeatureEnabled('USE_FEEDBACK_BUS')) return;
    try {
      useNotificationCenter.getState().addNotification({
        title: '',
        message: this.getTranslatedMessage(message),
        level,
      });
    } catch {
      // NotificationCenter 不可用时静默吞掉
    }
  }

  /**
   * 成功反馈
   */
  static success(codeOrMsg: string, duration?: number) {
    if (!codeOrMsg) return;
    const msg = this.getTranslatedMessage(codeOrMsg);
    toast.success(msg, {
      duration: duration || UI_CONSTANTS.DURATION.TOAST_NORMAL,
      style: this.getBaseStyle(),
      iconTheme: {
        primary: UI_CONSTANTS.COLORS.STATUS.SUCCESS,
        secondary: UI_CONSTANTS.COLORS.BACKGROUND.DARK,
      },
    });
    this.syncToNotificationCenter('success', msg);
  }

  /**
   * 异常反馈 (附带控制台溯源)
   */
  static error(codeOrMsg: string, errorObj?: any) {
    if (!codeOrMsg) return;
    const msg = this.getTranslatedMessage(codeOrMsg);
    toast.error(msg, {
      duration: UI_CONSTANTS.DURATION.TOAST_LONG,
      style: this.getBaseStyle(),
      iconTheme: {
        primary: UI_CONSTANTS.COLORS.STATUS.ERROR,
        secondary: UI_CONSTANTS.COLORS.BACKGROUND.DARK,
      },
    });
    if (errorObj) {
      console.error(`[AppNotifier Error 溯源]: ${codeOrMsg}`, errorObj);
    }
    this.syncToNotificationCenter('error', msg);
  }

  /**
   * 常规信息
   */
  static info(codeOrMsg: string) {
    if (!codeOrMsg) return;
    const msg = this.getTranslatedMessage(codeOrMsg);
    toast(msg, {
      duration: UI_CONSTANTS.DURATION.TOAST_SHORT,
      style: this.getBaseStyle(),
      icon: '💡',
    });
    this.syncToNotificationCenter('info', msg);
  }

  /**
   * 警告信息
   */
  static warning(codeOrMsg: string) {
    if (!codeOrMsg) return;
    const msg = this.getTranslatedMessage(codeOrMsg);
    toast(msg, {
      duration: UI_CONSTANTS.DURATION.TOAST_NORMAL,
      icon: '⚠️',
      style: this.getBaseStyle(),
    });
    this.syncToNotificationCenter('warn', msg);
  }

  /**
   * warn 是 warning 的别名，保持兼容性
   */
  static warn(codeOrMsg: string) {
    this.warning(codeOrMsg);
  }

  /**
   * 异步长任务加载态
   * @returns toastId 用于手动解除
   */
  static loading(message: string): string {
    return toast.loading(message || '加载中...', {
      style: this.getBaseStyle(),
    });
  }

  /**
   * 消除指定的提示
   */
  static dismiss(toastId?: string) {
    toast.dismiss(toastId);
  }
}
