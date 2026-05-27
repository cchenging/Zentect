// 📁 路径：src/renderer/src/core/IPCBridge.tsx
// Layer 2: 前端 IPC 桥接层 — 统一侦听管线状态变更、I18N 错误契约载荷、流式安全数据、故事板卡片流式注入
import React, { useEffect } from 'react';
import { IPC_CHANNELS } from '../../../shared/utils/IpcConstants';
import { useStore } from '../store/useStore';
import { useI18n } from '../store/useI18n';
import { AppNotifier } from './AppNotifier';

export const IPCBridge: React.FC = () => {
  const updateShot = useStore((state) => state.updateShot);
  const { t } = useI18n();

  useEffect(() => {
    if (!window.api?.ipc?.on) return;

    /** 侦听主进程管线错误 — 自愈/降级状态同步到前端 */
    const handlePipelineError = (_event: any, payload: any) => {
      const { shotId, titleKey, promptKey } = payload;

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
    const handleStreamToShotCard = (_event: any, payload: { shotId: string; safeText: string }) => {
      const { shotId, safeText } = payload;
      if (!shotId || !safeText || safeText === '[]') return;

      try {
        const parsedContent = JSON.parse(safeText);
        if (updateShot) {
          updateShot(shotId, { scriptPayload: parsedContent });
        }
      } catch {
        // JSON 解析失败静默吞掉
      }
    };

    window.api.ipc.on(IPC_CHANNELS.EVENT_PIPELINE_ERROR, handlePipelineError);
    window.api.ipc.on(IPC_CHANNELS.EVENT_STREAM_TO_SHOT_CARD, handleStreamToShotCard);

    return () => {
      if (typeof window.api.ipc.removeListener === 'function') {
        window.api.ipc.removeListener(IPC_CHANNELS.EVENT_PIPELINE_ERROR, handlePipelineError);
        window.api.ipc.removeListener(IPC_CHANNELS.EVENT_STREAM_TO_SHOT_CARD, handleStreamToShotCard);
      } else if (typeof window.api.ipc.removeAllListeners === 'function') {
        window.api.ipc.removeAllListeners(IPC_CHANNELS.EVENT_PIPELINE_ERROR);
        window.api.ipc.removeAllListeners(IPC_CHANNELS.EVENT_STREAM_TO_SHOT_CARD);
      }
    };
  }, [updateShot, t]);

  return null;
};
