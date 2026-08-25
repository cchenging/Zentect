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
// 动态 import() 返回的是模块命名空间，需通过 .useProjectStore 访问实际的 zustand store
type ProjectStoreModuleT = typeof import('@modules/editor/stores/useProjectStore');

export const IPCBridge: React.FC = () => {
  const { t } = useI18n();

  useEffect(() => {
    if (!window.api?.ipc?.on) return;

    // 🔧 动态 import：让 editor 模块成为按需编译的 chunk，不进入首屏 bundle
    //   类型断言确保后续调用有正确的类型推导
    let projectStoreModule: ProjectStoreModuleT | null = null;
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
      const updateShot = store?.useProjectStore.getState().updateShot;

      if (shotId && updateShot) {
        updateShot(shotId, { pipelineStatus: 'error' });
      }

      if (titleKey || promptKey) {
        AppNotifier.error(
          `${t[titleKey as keyof typeof t] || titleKey || ''}\n${t[promptKey as keyof typeof t] || promptKey || ''}`
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
        const updateShot = store?.useProjectStore.getState().updateShot;
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
      const storeState = store.useProjectStore.getState();

      console.log('[IPCBridge 核心总线] 捕获主进程算力波段信号:', payload.type || payload);

      if (
        payload.type === 'AUDIO_SEPARATE_SUCCESS' ||
        payload.status === 'success' ||
        payload.progress === 100
      ) {
        window.api.ipc.invoke(IPC_CHANNELS.PROJECT_LOAD_DATA, storeState.projectId)
          .then((freshData) => {
            if (freshData) {
              // 兼容 IPC 返回结构：裸 payload 或 {code, data} 包装
              const f = (freshData.data && typeof freshData.data === 'object' && freshData.data.mediaItems) ? freshData.data : freshData;

              // 🛑 原则 2：partial 增量走 mergePartialUpdate, 不进 hydrate
              // 💥 关键修复：之前只传了 shots/aiShots/roles/audioSeparated/mediaItems 5 个字段，
              //   缺失 framePaths / frameCount / asrLines / vlmFrames / scriptParagraphs 等所有步骤数据！
              //   导致管线完成后前端刷新不显示最新关键帧、ASR、VLM 描述等。
              storeState.mergePartialUpdate({
                // 轨道层
                shots: f.shots || [],
                aiShots: f.aiShots || [],
                roles: f.roles || [],
                mediaItems: f.mediaItems || storeState.mediaItems,
                // extractedData 层（含抽帧路径）
                audioSeparated: f.audioSeparated !== undefined ? !!f.audioSeparated : true,
                asrLines: f.asrLines || undefined,
                framePaths: f.framePaths || undefined,
                frameCount: (f.framePaths && Array.isArray(f.framePaths)) ? f.framePaths.length : (f.frameCount || undefined),
                videoPath: f.videoPath || undefined,
                vocalPath: f.vocalPath || undefined,
                backgroundPath: f.backgroundPath || undefined,
                // 各步骤数据层
                vlmFrames: f.vlmFrames || undefined,
                scriptParagraphs: f.scriptParagraphs || undefined,
                ttsResults: f.ttsResults || undefined,
                videoChunks: f.videoChunks || undefined,
                // 步骤5 匹配层
                matchResults: f.matchResults || undefined,
                activeBgm: f.activeBgm || undefined,
                beatTimestamps: f.beatTimestamps || undefined,
                // 画布
                canvasData: f.canvasData !== undefined ? f.canvasData : undefined,
              });
              AppNotifier.success('🎵 数据已同步到前端（含关键帧/ASR/步骤结果）');
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
