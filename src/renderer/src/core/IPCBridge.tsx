// 📁 路径：src/renderer/src/core/IPCBridge.tsx
// Layer 2: 前端 IPC 桥接层 — 统一侦听管线状态变更、I18N 错误契约载荷、流式安全数据、故事板卡片流式注入
//
// 🔧 启动性能修复（关键）：
//   原代码顶部 `import { useProjectStore } from '@modules/editor/stores/useProjectStore'`
//   会同步拉入整个 @modules/editor 模块树（含 timeline/canvas/player/AI agent + 5 个 step stores），
//   完全抵消了 App.tsx 中 `React.lazy(() => import('@modules/editor'))` 的懒加载效果，
//   导致 vite dev 首次编译耗时 108 秒。
//
//   修复策略：
//   1. 移除顶部同步 import useProjectStore
//   2. 在 useEffect 内部用动态 import() 获取 store 引用
//   3. 事件回调中通过 useProjectStore.getState().updateShot 调用最新状态
//   这样 vite 在首屏编译时不再编译 editor 模块，编译耗时预计降至 30 秒以内。
import React, { useEffect } from 'react';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';
import { useI18n } from '../store/useI18n';
import { AppNotifier } from './AppNotifier';

// 🔧 类型只读导入：编译期擦除，不会触发运行时加载
import type { useProjectStore as UseProjectStoreType } from '@modules/editor/stores/useProjectStore';

export const IPCBridge: React.FC = () => {
  const { t } = useI18n();

  useEffect(() => {
    if (!window.api?.ipc?.on) return;

    // 🔧 动态 import：让 editor 模块成为按需编译的 chunk，不进入首屏 bundle
    //   类型断言确保后续调用有正确的类型推导
    let projectStoreModule: typeof UseProjectStoreType | null = null;
    const ensureProjectStore = async () => {
      if (!projectStoreModule) {
        try {
          projectStoreModule = await import('@modules/editor/stores/useProjectStore');
        } catch (err) {
          console.error('[IPCBridge] 动态加载 useProjectStore 失败:', err);
        }
      }
      return projectStoreModule;
    };

    /** 侦听主进程管线错误 — 自愈/降级状态同步到前端 */
    const handlePipelineError = async (_event: any, payload: any) => {
      const { shotId, titleKey, promptKey } = payload;
      const store = await ensureProjectStore();
      const updateShot = store?.getState().updateShot;

      if (shotId && updateShot) {
        updateShot(shotId, { pipelineStatus: 'error' });
      }

      if (titleKey || promptKey) {
        AppNotifier.error(
          `${t(titleKey) || titleKey || ''}\n${t(promptKey) || promptKey || ''}`
        );
      }
    };

    /** 侦听主进程清洗后的安全流式数据 — 精准注入故事板镜头卡片 */
    const handleStreamToShotCard = async (_event: any, payload: { shotId: string; safeText: string }) => {
      const { shotId, safeText } = payload;
      if (!shotId || !safeText || safeText === '[]') return;

      try {
        const parsedContent = JSON.parse(safeText);
        const store = await ensureProjectStore();
        const updateShot = store?.getState().updateShot;
        if (updateShot) {
          updateShot(shotId, { scriptPayload: parsedContent });
        }
      } catch {
        // JSON 解析失败静默吞掉
      }
    };

    /** 💥 收听主进程的全局异步事件大闸，触发全量数据水合 */
    const handleGlobalPipelineNotify = async (_event: any, payload: any) => {
      if (!payload) return;
      const store = await ensureProjectStore();
      if (!store) return;
      const storeState = store.getState();

      console.log('[IPCBridge 核心总线] 捕获主进程算力波段信号:', payload.type || payload);

      if (
        payload.type === 'AUDIO_SEPARATE_SUCCESS' ||
        payload.status === 'success' ||
        payload.progress === 100
      ) {
        window.api.ipc.invoke(IPC_CHANNELS.PROJECT_LOAD_DATA, storeState.projectId)
          .then((freshData) => {
            if (freshData) {
              storeState.hydrateProjectData({
                shots: freshData.shots || [],
                aiShots: freshData.aiShots || [],
                roles: freshData.roles || [],
                audioSeparated: true,
                mediaItems: freshData.mediaItems || storeState.mediaItems
              });
              AppNotifier.success('🎵 音频流与视频轨道数据已实时同步！');
            }
          }).catch((err) => console.error('[IPCBridge] 水合崩溃:', err));
      }
    };

    window.api.ipc.on(IPC_CHANNELS.EVENT_PIPELINE_ERROR, handlePipelineError);
    window.api.ipc.on(IPC_CHANNELS.EVENT_STREAM_TO_SHOT_CARD, handleStreamToShotCard);
    window.api.ipc.on('NOTIFY_PIPELINE_EVENT', handleGlobalPipelineNotify);
    window.api.ipc.on(IPC_CHANNELS.PROJECT_SAVE_CANVAS, handleGlobalPipelineNotify);

    return () => {
      if (typeof window.api.ipc.removeListener === 'function') {
        window.api.ipc.removeListener(IPC_CHANNELS.EVENT_PIPELINE_ERROR, handlePipelineError);
        window.api.ipc.removeListener(IPC_CHANNELS.EVENT_STREAM_TO_SHOT_CARD, handleStreamToShotCard);
        window.api.ipc.removeListener('NOTIFY_PIPELINE_EVENT', handleGlobalPipelineNotify);
        window.api.ipc.removeListener(IPC_CHANNELS.PROJECT_SAVE_CANVAS, handleGlobalPipelineNotify);
      } else if (typeof window.api.ipc.removeAllListeners === 'function') {
        window.api.ipc.removeAllListeners(IPC_CHANNELS.EVENT_PIPELINE_ERROR);
        window.api.ipc.removeAllListeners(IPC_CHANNELS.EVENT_STREAM_TO_SHOT_CARD);
        window.api.ipc.removeAllListeners('NOTIFY_PIPELINE_EVENT');
        window.api.ipc.removeAllListeners(IPC_CHANNELS.PROJECT_SAVE_CANVAS);
      }
    };
  }, [t]);

  return null;
};
