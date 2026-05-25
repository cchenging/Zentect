import React, { useEffect } from 'react';
import { IPC_CHANNELS } from '../../../shared/utils/IpcConstants';
import { useStore } from '../store/useStore';
import { AppNotifier } from './AppNotifier';

export const IPCBridge: React.FC = () => {
  const updateNodeStatus = useStore((state) => state.updateNodeStatus);

  useEffect(() => {
    if (!window.api?.ipc?.on) return;

    const handleStateChange = (_event: any, payload: any) => {
      const { nodeId, status, progress, error, results } = payload;
      if (updateNodeStatus) {
         updateNodeStatus(nodeId, status, progress, results);
      }

      if (status === 'error') {
        AppNotifier.error(`节点运算异常: ${error}`);
      }
    };

    window.api.ipc.on(IPC_CHANNELS.EVENT_NODE_STATE_CHANGE, handleStateChange);

    return () => {
      if (typeof window.api.ipc.removeListener === 'function') {
        window.api.ipc.removeListener(IPC_CHANNELS.EVENT_NODE_STATE_CHANGE, handleStateChange);
      } else if (typeof window.api.ipc.removeAllListeners === 'function') {
        window.api.ipc.removeAllListeners(IPC_CHANNELS.EVENT_NODE_STATE_CHANGE);
      }
    };
  }, [updateNodeStatus]);

  return null;
};
