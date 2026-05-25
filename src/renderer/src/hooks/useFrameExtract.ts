import { useEffect } from 'react';
import { useEditorStore } from '../store/useStore';
import { API } from '../api';

export const useFrameExtract = (nodeId: string, projectId?: string) => {
  const data = useEditorStore((s) => s.nodes.find((n) => n.id === nodeId)?.data);
  const updateNodeData = useEditorStore((s) => s.updateNodeData);
  const updateNodeStatus = useEditorStore((s) => s.updateNodeStatus);
  const currentProjectId = useEditorStore((s) => s.projectId);

  // 兼容原来的接口
  const fps = data?.fps || 1;
  const strategy = data?.strategy || 'uniform';

  const handleFpsChange = (value: number) => {
    updateNodeData(nodeId, { fps: value });
  };

  const handleStrategyChange = (value: string) => {
    updateNodeData(nodeId, { strategy: value });
  };

  // 在 useEffect 中监听状态
  useEffect(() => {
    if (data?.status === 'success') {
      refreshResults();
    }
  }, [data?.status]);

  const refreshResults = async () => {
    const payload = {
      projectId: projectId || currentProjectId,
      nodeId,
      action: 'frame-extract',
      mediaPath: data?.mediaPath || '',
    };
    
    try {
      const results = await API.engine.runPipeline(payload);

      for (const resultNodeId in results) {
        if (['success', 'code', 'message', 'data', 'error'].includes(resultNodeId)) {
          continue;
        }

        const nodeOutput = results[resultNodeId];
        
        if (!nodeOutput || Object.keys(nodeOutput).length === 0) {
          console.warn(`[Pipeline] 节点 ${resultNodeId} 执行完毕，但产物为空。`);
          continue;
        }

        if (typeof updateNodeStatus === 'function') {
          updateNodeStatus(resultNodeId, 'success', 100, nodeOutput);
        }
      }
    } catch (err: any) {
      console.warn('[FrameExtract] Pipeline 执行失败:', err.message);
      if (typeof updateNodeStatus === 'function') {
        updateNodeStatus(nodeId, 'error', 0, { error: err.message });
      }
    }
  };

  return { 
    fps, 
    strategy, 
    handleFpsChange, 
    handleStrategyChange,
    refreshResults 
  };
};
