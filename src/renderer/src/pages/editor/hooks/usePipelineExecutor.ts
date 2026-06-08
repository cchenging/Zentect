// 📁 路径: src/renderer/src/pages/editor/hooks/usePipelineExecutor.ts
import { useEffect, useCallback, useRef } from 'react';
import { useEditorStore } from '../../../store/useStore';
import { API } from '../../../api';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { AppNotifier } from '../../../core/AppNotifier';

export const usePipelineExecutor = () => {
  const store = useEditorStore();
  const asrBufferRef = useRef<any[]>([]);
  const renderTimerRef = useRef<any>(null);

  /** 💥【中继网关核心打通】：全面接管主进程发过来的长连接电波信号，驱动前台组件重新渲染 */
  const handlePipelineProgress = useCallback((payload: any) => {
    if (!payload) return;

    console.log('====== [RENDERER RECEIVE 核心大包] ======', JSON.stringify(payload));

    const { progress, status, results, error, nodeName } = payload;
    const storeState = useEditorStore.getState();

    console.log(`[工作台大总线] 捕获长连接信号 -> 进度: ${progress}% | 状态: ${status}`);

    // 1. 同步更新前台右侧流程面板上的百分比进度条与转圈状态，解除假死感
    if (typeof storeState.setPipelineProgress === 'function') {
      storeState.setPipelineProgress(progress, nodeName || `AI 核心提取管线全力运转中...`);
    }
    if (status === 'processing' || progress < 100) {
      storeState.setPipelineRunning?.(true);
    }

    // 2. 💥【增量高性能回填】：将音轨路径、ASR文本真正塞回 Zustand 对应的状态房间里
    if (results) {
      if (results.asrLines && Array.isArray(results.asrLines)) {
        asrBufferRef.current = results.asrLines;

        // 150ms 动态节流窗，保护您的剪辑主线程绝对不假死
        if (!renderTimerRef.current) {
          renderTimerRef.current = setTimeout(() => {
            storeState.setExtractedData?.({ asrLines: asrBufferRef.current });
            renderTimerRef.current = null;
          }, 150);
        }
      }

      if (results.vocalPath || results.backgroundPath) {
        storeState.setExtractedData?.({
          vocalPath: results.vocalPath || storeState.extractedData.vocalPath,
          backgroundPath: results.backgroundPath || storeState.extractedData.backgroundPath
        });
      }
    }

    // 3. 💥【完工同步落盘大闸】：响应日志中的成功完工信号，强推 SQLite 磁盘持久化
    if (progress === 100 || status === 'success') {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);

      // 💥【终极对接卡点】：后端叫 results.frames，前台叫 framePaths。在此完成工业级对齐！
      const actualExtractedImages = results?.frames || results?.framePaths || [];

      const finalPayload = {
        videoPath: storeState.extractedData.videoPath,
        vocalPath: results?.vocalPath || storeState.extractedData.vocalPath,
        backgroundPath: results?.backgroundPath || storeState.extractedData.backgroundPath,
        asrLines: asrBufferRef.current.length > 0 ? asrBufferRef.current : (results?.asrLines || []),
        framePaths: actualExtractedImages,
        frameCount: results?.frameCount || actualExtractedImages.length || storeState.extractedData.frameCount
      };

      // 前台数据完成最终注水
      storeState.setExtractedData?.(finalPayload);
      
      // 同步驱动计数徽章
      useEditorStore.setState({ frameCount: actualExtractedImages.length });
      AppNotifier.success(`⚙️ 智能分析中心：资产切片无损入库，共生成 ${actualExtractedImages.length} 个高清分镜！`);

      // 呼叫主进程对齐 SQLite，落库成功后彻底治愈重进项目丢失
      window.api.ipc.invoke(IPC_CHANNELS.ENGINE_RUN_PIPELINE, {
        projectId: storeState.projectId,
        isSaveAction: true,
        extractedData: finalPayload
      }).catch(() => {}).finally(() => {
        /** 仅在非步骤模式下重置 running 状态，步骤模式由 usePipelineOrchestrator 管理 */
        const stepStatuses = (storeState as any).stepStatuses;
        if (!stepStatuses || !stepStatuses.some((s: any) => s === 'running')) {
          storeState.setPipelineRunning?.(false);
        }
      });
    }

    if (status === 'error') {
      storeState.setPipelineRunning?.(false);
      AppNotifier.error(`核心引擎算力中断: ${error || '未知底层微服务崩溃'}`);
    }
  }, []);

  useEffect(() => {
    // 💥 严密咬合长连接大总线与顺序向导大闸
    API.engine.onPipelineProgress(handlePipelineProgress);
    if (window.api?.ipc?.on) {
      window.api.ipc.on('QUICK_PIPELINE_PROGRESS', (_e, p) => handlePipelineProgress(p));
    }
    return () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
      if (API.engine.offPipelineProgress) API.engine.offPipelineProgress();
    };
  }, [handlePipelineProgress]);

  /** 💥 触发执行大闸 Action：不包含任何多余的连线拓扑编译，一秒直传主进程 */
  const triggerLinearPipeline = useCallback(async () => {
    const storeState = useEditorStore.getState();
    if (!storeState.projectId) return AppNotifier.error('项目上下文丢失，无法运行');

    try {
      storeState.setPipelineRunning?.(true);
      storeState.setPipelineProgress?.(2, '唤醒本地大模型与音轨提取微服务中...');
      asrBufferRef.current = [];

      await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_RUN_PIPELINE, {
        projectId: storeState.projectId,
        isQuickMode: true
      });
    } catch (err) {
      AppNotifier.error('IPC 网络网关异常，请重启后端微服务守护进程');
    }
  }, []);

  return { triggerLinearPipeline, isRunning: store.pipelineRunning };
};
