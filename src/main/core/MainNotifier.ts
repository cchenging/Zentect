import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { DICT } from '../../shared/locales/dictionary';
import type { TaskCompletedPayload, AppNotifyPayload } from '../../shared/types';
import { TaskRepository } from '../database/repositories/TaskRepository';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';

export class MainNotifier {
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

  static notifyTaskProgress(mediaId: string, projectId: string, code: string, percent: number, status: string = DICT.TASK_STATUS.RUNNING) {
    const taskRepo = new TaskRepository();
    taskRepo.upsertTask({ mediaId, projectId, status, progress: percent, text: code });

    const payload = { mediaId, code, percent, status };
    this.safeSend(this.getMainWindow(), IPC_CHANNELS.EVENT_TASK_PROGRESS, payload);
  }

  static notifyTaskCompleted(mediaId: string, projectId: string, result: any) {
    const taskRepo = new TaskRepository();
    taskRepo.upsertTask({ mediaId, projectId, status: DICT.TASK_STATUS.COMPLETED, progress: 100, text: 'TASK_SUCCESS' });

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

  // 💥 新增：任务进度信号发射器（直接发送到 'system:taskProgress' 频道）
  static sendTaskProgress(mediaId: string, code: string, percent: number, status: string) {
    const window = MainNotifier.getMainWindow();
    // 💥 替换为 safeSend
    this.safeSend(window, 'system:taskProgress', {
      mediaId, code, percent, status
    });
  }

  // 💥 新增：兼容PipelineEngine的send方法
  static send(_sender: any, channel: string, payload: any) {
    // 忽略sender参数，总是向主窗口发送消息
    this.safeSend(this.getMainWindow(), channel, payload);
  }
}
