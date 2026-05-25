import { useState, useEffect, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useEditorStore } from '../../../store/useStore';
import { API } from '../../../api';
import { ActionParser } from '../../../core/ActionParser';
import { NODE_STATUS } from '../../../store/constants';

// 🟢 优化 1：抽离状态映射器为纯函数，降低 Hook 内部复杂度，便于后续单测扩展
const mapEngineStatusToNodeStatus = (backendStatus: string) => {
  switch (backendStatus) {
    case 'processing': return NODE_STATUS.PROCESSING;
    case 'success': return NODE_STATUS.SUCCESS;
    case 'error': return NODE_STATUS.ERROR;
    default: return NODE_STATUS.IDLE;
  }
};

export const usePipelineExecutor = () => {
  const { getNodes, getEdges } = useReactFlow();
  const projectId = useEditorStore((s) => s.projectId);
  const updateNodeData = useEditorStore((s) => s.updateNodeData);
  const [isRunning, setIsRunning] = useState(false);

  // 🟢 优化 2：将进度处理逻辑抽离为独立方法，避免每次渲染重建，提升 IPC 响应性能
  const handleProgress = useCallback((payload: any) => {
    const { nodeId, progress, status, results } = payload;
    const frontendStatus = mapEngineStatusToNodeStatus(status);
    
    updateNodeData(nodeId, { 
      progress, 
      status: frontendStatus, 
      results: results || {}
    });
  }, [updateNodeData]);

  useEffect(() => {
    API.engine.onPipelineProgress(handleProgress);
    return () => {
      // ♻️ 优化：生命周期卸载，严格防止 IPC 内存泄漏
      API.engine.offPipelineProgress?.();
    };
  }, [handleProgress]);

  const execute = useCallback(async () => {
    if (isRunning) return;

    const nodes = getNodes();
    const edges = getEdges();

    try {
      setIsRunning(true);
      
      // 1. DAG 图提纯编译：使用 compileToSequence 生成后端可识别的执行序列
      const sequence = ActionParser.compileToSequence(nodes as any, edges as any);

      if (!sequence || sequence.length === 0) {
        setIsRunning(false);
        return;
      }

      // 2. 状态重置：只遍历一次
      nodes.forEach(n => updateNodeData(n.id, { progress: 0, status: NODE_STATUS.IDLE }));

      // 3. 引擎点火 — 传入执行序列而非原始节点/边
      await API.engine.runPipeline({ projectId, sequence, sourceMedia: '' });

    } catch (error: any) {
      console.error('管线执行崩溃:', error);
    } finally {
      setIsRunning(false);
    }
  }, [isRunning, getNodes, getEdges, projectId, updateNodeData]);

  const abort = useCallback(async () => {
    if (!isRunning) return;
    try {
      await API.engine.abortPipeline();
      const nodes = getNodes();
      nodes.forEach(n => {
        if (n.data?.status === NODE_STATUS.PROCESSING) {
          updateNodeData(n.id, { status: NODE_STATUS.IDLE, progress: 0 });
        }
      });
    } catch (e) {
      console.error('工作流强行中止失败', e);
    } finally {
      setIsRunning(false);
    }
  }, [isRunning, getNodes, updateNodeData]);

  return { execute, abort, isRunning };
};
