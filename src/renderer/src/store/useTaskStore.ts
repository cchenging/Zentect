// 📁 路径：src/renderer/src/store/useTaskStore.ts
import { create } from 'zustand';
import type { TaskProgressPayload } from '../../../shared/types';
import { AppNotifier } from '../core/AppNotifier';
import { IPC_CHANNELS } from '../../../modules/infra/ipc/IpcConstants';
import { EventBridge } from '../bridge/EventBridge';

/**
 * 任务状态接口
 */
interface TaskState {
  tasks: Record<string, TaskProgressPayload>;
  _initialized: boolean;
  setTaskProgress: (payload: TaskProgressPayload) => void;
  clearTask: (mediaId: string) => void;
  initIpcListeners: () => void;
  cleanupIpcListeners: () => void;
}

/**
 * 全局任务遥测站：
 * 通过 EventBridge 接收主进程推送，不直接注册底层 IPC 监听
 */

/** 保存 subscribe 返回的取消订阅函数，用于精确移除监听器 */
let taskProgressUnsub: (() => void) | null = null;

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: {},
  _initialized: false,

  /**
   * 设置任务进度
   */
  setTaskProgress: (payload) => set((state) => ({
    tasks: { ...state.tasks, [payload.mediaId || '']: payload }
  })),

  /**
   * 清理任务
   */
  clearTask: (mediaId) => set((state) => {
    const newTasks = { ...state.tasks };
    delete newTasks[mediaId];
    return { tasks: newTasks };
  }),

  /**
   * 通过 EventBridge 挂载进度监听（不直连底层 IPC）
   */
  initIpcListeners: () => {
    if (typeof window === 'undefined' || !window.api) return;
    if (get()._initialized) return;
    set({ _initialized: true });

    const bridge = EventBridge.getInstance();

    taskProgressUnsub = bridge.subscribe(IPC_CHANNELS.EVENT_TASK_PROGRESS, (payload: TaskProgressPayload) => {
      get().setTaskProgress(payload);

      const mediaId = (payload as any).mediaId;
      if ((payload as any).percent >= 100 || payload.status === 'error') {
        if (payload.status === 'error') {
          AppNotifier.error(`素材解析异常：${(payload as any).code}`);
        } else {
          AppNotifier.success('素材解析完毕，特征入库成功！');
        }
        setTimeout(() => {
          if (get().tasks[mediaId]) {
            get().clearTask(mediaId);
          }
        }, 2000);
      }
    });
  },

  /** 精确移除任务进度监听器，兜底清理频道所有监听 */
  cleanupIpcListeners: () => {
    set({ _initialized: false });
    taskProgressUnsub?.();
    taskProgressUnsub = null;
    EventBridge.getInstance().removeAllForChannel(IPC_CHANNELS.EVENT_TASK_PROGRESS);
  }
}));
