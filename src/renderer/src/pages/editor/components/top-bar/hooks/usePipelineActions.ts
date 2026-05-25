import { useCallback, useMemo } from 'react';
import { useEditorStore } from '../../../../../store/useStore';
import { AppNotifier } from '../../../../../core/AppNotifier';
import { ActionParser } from '../../../../../core/ActionParser';
import { IPC_CHANNELS } from '../../../../../../../shared/utils/IpcConstants';

export function usePipelineActions() {
  const nodes = useEditorStore((s) => s.nodes);

  const isRunning = useMemo(
    () => nodes.some((n) => n.data?.status === 'processing'),
    [nodes]
  );

  const handleExecutePipeline = useCallback(async () => {
    const { nodes: currentNodes, edges, projectId, updateNodeData } = useEditorStore.getState();

    if (currentNodes.some((n) => n.data?.status === 'processing')) {
      return AppNotifier.warn('任务正在运行，请先中止！');
    }

    let sequence: any[] = [];
    try {
      const compiled: any = ActionParser.compile(currentNodes, edges);
      sequence = Array.isArray(compiled)
        ? compiled
        : compiled.sequence || compiled.actions || [];

      if (sequence.length === 0) {
        return AppNotifier.warn('有效执行节点为空，请检查算力节点连线！');
      }
    } catch (e: any) {
      return AppNotifier.error(e.message);
    }

    try {
      AppNotifier.info('流水线任务已发送，引擎预热中...');

      const response = await window.api.ipc.invoke(IPC_CHANNELS.PIPELINE_RUN, {
        sequence,
        context: { projectId }
      });

      if (!response.success) {
        AppNotifier.error(`流水线意外中断: ${response.error}`);
        sequence.forEach((a) =>
          updateNodeData(a.nodeId, { status: 'error', error: response.error })
        );
      }
    } catch (err: any) {
      console.error('执行通信崩溃', err);
      AppNotifier.error('与主进程通信失败！');
      sequence.forEach((a) => updateNodeData(a.nodeId, { status: 'error' }));
    }
  }, []);

  const handleStopOrReset = useCallback(async () => {
    const { nodes: currentNodes, updateNodeData } = useEditorStore.getState();

    currentNodes.forEach((node) => {
      if (node.data?.status === 'processing') {
        updateNodeData(node.id, { status: 'idle', progress: 0 });
      }
    });

    AppNotifier.success('前端状态已强制重置！');

    try {
      await window.api.ipc.invoke(IPC_CHANNELS.PIPELINE_STOP);
    } catch (e) {
      console.log('通知主进程停止任务失败', e);
    }
  }, []);

  return { isRunning, handleExecutePipeline, handleStopOrReset };
}
