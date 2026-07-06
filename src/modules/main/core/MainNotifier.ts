import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { DICT } from '../../infra/i18n/dictionary';
import type { TaskCompletedPayload, AppNotifyPayload } from '../../shared/types';
import { TaskRepository } from '../database/repositories/TaskRepository';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';

/** 主进程通知器：统一管理 IPC 推送与任务状态持久化 */
export class MainNotifier {
  /** 任务仓库单例，避免高频场景重复实例化造成 GC 压力 */
  private static taskRepo = new TaskRepository();

  static getMainWindow(): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows();
    return windows.length > 0 ? windows[0] : null;
  }

  // 💥 绝对防御工具函数：拦截 undefined 信道，防止 V8 底层崩溃
  private static safeSend(window: BrowserWindow | null, channel: string, payload: any) {
    if (!channel) {
      AppLogger.fatal(LOG_TAGS.IPC_GATEWAY, `🚨 致命拦截：试图向空信道(undefined)发送消息！载荷数据:`, payload);
      return;
    }
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }

  /** 推送任务进度到渲染进程并持久化 */
  static notifyTaskProgress(mediaId: string, projectId: string, code: string, percent: number, status: string = DICT.TASK_STATUS.RUNNING) {
    MainNotifier.taskRepo.upsertTask({ mediaId, projectId, status, progress: percent, text: code });

    const payload = { mediaId, code, percent, status };
    this.safeSend(this.getMainWindow(), IPC_CHANNELS.EVENT_TASK_PROGRESS, payload);
  }

  /** 推送任务完成事件到渲染进程并持久化 */
  static notifyTaskCompleted(mediaId: string, projectId: string, result: any) {
    MainNotifier.taskRepo.upsertTask({ mediaId, projectId, status: DICT.TASK_STATUS.COMPLETED, progress: 100, text: 'TASK_SUCCESS' });

    const payload: TaskCompletedPayload = { mediaId, projectId, result };
    // 💥 替换为 safeSend
    this.safeSend(this.getMainWindow(), IPC_CHANNELS.EVENT_TASK_COMPLETED, payload);
  }

  static notifyApp(code: string, level: 'success' | 'error' | 'info' | 'warn' = 'info') {
    const payload: AppNotifyPayload = { code, level };
    // 💥 替换为 safeSend
    this.safeSend(this.getMainWindow(), IPC_CHANNELS.EVENT_APP_NOTIFY, payload);
  }

  // 💥 新增：通用通知方法
  static notify(eventName: string, payload: any) {
    // 💥 替换为 safeSend (大概率是由于 EVENT_EXTRACTION_SUCCESS 未定义在这里触发的崩溃)
    this.safeSend(this.getMainWindow(), eventName, payload);
  }

  static sendTaskProgress(mediaId: string, code: string, percent: number, status: string) {
    const window = MainNotifier.getMainWindow();
    this.safeSend(window, IPC_CHANNELS.EVENT_TASK_PROGRESS, {
      mediaId, code, percent, status
    });
  }

  // 💥 新增：兼容PipelineEngine的send方法
  static send(_sender: any, channel: string, payload: any) {
    // 忽略sender参数，总是向主窗口发送消息
    this.safeSend(this.getMainWindow(), channel, payload);
  }
}
