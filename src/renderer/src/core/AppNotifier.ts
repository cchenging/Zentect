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
  /** 防重去抖窗口（毫秒）：同级别+同内容在窗口内第二次及以后被静默丢弃 */
  private static readonly DEDUP_WINDOW_MS = 500;

  /** 最近一次已发出的提示缓存：key = `${level}:${message}`，value = 触发时间戳 */
  private static readonly _lastFireMap = new Map<string, number>();

  /**
   * 💥 防重判定：短时间内完全相同的提示只放行一次，避免重复弹 Toast
   * @returns true=允许放行，false=判定为重复已拦截
   */
  private static checkDedupPass(level: string, message: string): boolean {
    const key = `${level}:${message}`;
    const now = Date.now();
    const last = this._lastFireMap.get(key) || 0;
    if (now - last < this.DEDUP_WINDOW_MS) {
      // 落入防重窗口 → 判定为重复，拦截
      console.warn(`[AppNotifier] 防重拦截：窗口内重复提示已忽略 (${key})`);
      return false;
    }
    this._lastFireMap.set(key, now);
    // 💥 轻量兜底：控制 Map 不至于无限膨胀（>200 项时清空）
    if (this._lastFireMap.size > 200) this._lastFireMap.clear();
    return true;
  }

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
      background: 'var(--bg-secondary)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-default)',
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
    // 💥 防重防线2：同内容短时间内重复调用直接拦截，不再弹 Toast / 入通知中心
    if (!this.checkDedupPass('success', msg)) return;
    toast.success(msg, {
      duration: duration || UI_CONSTANTS.DURATION.TOAST_NORMAL,
      style: this.getBaseStyle(),
      iconTheme: {
        primary: 'var(--success)',
        secondary: 'var(--bg-secondary)',
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
    if (!this.checkDedupPass('error', msg)) {
      // 即使是防重拦截，错误溯源日志也保留一份以便排查
      if (errorObj) console.error(`[AppNotifier Error 溯源·重复调用已合并]: ${codeOrMsg}`, errorObj);
      return;
    }
    toast.error(msg, {
      duration: UI_CONSTANTS.DURATION.TOAST_LONG,
      style: this.getBaseStyle(),
      iconTheme: {
        primary: 'var(--destructive)',
        secondary: 'var(--bg-secondary)',
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
    if (!this.checkDedupPass('info', msg)) return;
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
    if (!this.checkDedupPass('warn', msg)) return;
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
