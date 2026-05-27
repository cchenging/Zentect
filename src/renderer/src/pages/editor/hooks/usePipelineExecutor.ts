import { useState, useEffect, useCallback } from 'react';
import { useEditorStore } from '../../../store/useStore';
import { API } from '../../../api';
import { ActionParser } from '../../../core/ActionParser';
import { NODE_STATUS } from '../../../store/constants';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';

const mapEngineStatusToNodeStatus = (backendStatus: string) => {
  switch (backendStatus) {
    case 'processing': return NODE_STATUS.PROCESSING;
    case 'success': return NODE_STATUS.SUCCESS;
    case 'error': return NODE_STATUS.ERROR;
    default: return NODE_STATUS.IDLE;
  }
};

export const usePipelineExecutor = () => {
  const projectId = useEditorStore((s) => s.projectId);
  const [isRunning, setIsRunning] = useState(false);

  const handleProgress = useCallback((payload: any) => {
    const { nodeId, progress, status, results } = payload;
    const frontendStatus = mapEngineStatusToNodeStatus(status);
    // 管线进度通过 EventBridge 同步到 editorSlice
  }, []);

  useEffect(() => {
    API.engine.onPipelineProgress(handleProgress);
    return () => {
      API.engine.offPipelineProgress?.();
    };
  }, [handleProgress]);

  const execute = useCallback(async () => {
    if (isRunning) return;
    try {
      setIsRunning(true);
      await API.engine.runPipeline({ projectId, sequence: [], sourceMedia: '' });
    } catch (error: any) {
      console.error('管线执行崩溃:', error);
    } finally {
      setIsRunning(false);
    }
  }, [isRunning, projectId]);

  const abort = useCallback(async () => {
    if (!isRunning) return;
    try {
      await API.engine.abortPipeline();
    } catch (e) {
      console.error('工作流强行中止失败', e);
    } finally {
      setIsRunning(false);
    }
  }, [isRunning]);

  return { execute, abort, isRunning };
};
