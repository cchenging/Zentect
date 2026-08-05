// Module: editor/shell/hooks/usePipelineExecutor
// 原 editor/hooks/usePipelineExecutor.ts — 已迁移

import { useEffect, useCallback, useRef } from 'react';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { API } from '@renderer/api';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';
import { AppNotifier } from '@renderer/core/AppNotifier';

export const usePipelineExecutor = () => {
  const pipelineStore = usePipelineStore();
  const asrBufferRef = useRef<any[]>([]);
  const renderTimerRef = useRef<any>(null);

  /** 接管主进程长连接信号，驱动前台组件重新渲染 */
  const handlePipelineProgress = useCallback((payload: any) => {
    if (!payload) return;

    console.log('====== [RENDERER RECEIVE 核心大包] ======', JSON.stringify(payload));

    const { progress, status, results, error, nodeName } = payload;
    const storeState = useProjectStore.getState();
    const pipelineState = usePipelineStore.getState();

    console.log(`[工作台大总线] 捕获长连接信号 -> 进度: ${progress}% | 状态: ${status}`);

    if (typeof pipelineState.setPipelineProgress === 'function') {
      pipelineState.setPipelineProgress(progress, nodeName || `AI 核心提取管线全力运转中...`);
    }
    if (status === 'processing' || progress < 100) {
      pipelineState.setPipelineRunning?.(true);
    }

    if (results) {
      if (results.asrLines && Array.isArray(results.asrLines)) {
        asrBufferRef.current = results.asrLines;

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

      // 🔧 修复：step2 画面描述流式推送 — 将 partialFrames 实时写入 useStep2Store
      // 后端 VisionExtractStrategy 每完成 5 帧推送一次，前端需实时渲染打字机效果
      if (Array.isArray(results.partialFrames) && results.partialFrames.length > 0) {
        useStep2Store.getState().setVlmFrames(results.partialFrames);
      }

      // 🔧 修复：step4 TTS 增量结果推送 — 每完成一段就更新 ttsResults + ttsProgress
      // 后端 TTSStrategy 每段完成时通过 onProgress 第三参推送 partialTtsResults
      // 前端据此实时显示"合成中"状态，避免进度条 0→100 跳变
      if (Array.isArray(results.partialTtsResults)) {
        const nodeId: string = payload.nodeId || '';
        if (nodeId.includes('tts')) {
          const s4 = useStep4Store.getState();
          // 把后端 audioPath（本地绝对路径）转为 magic://local/ URL
          const mapped = results.partialTtsResults.map((r: any) => {
            let audioUrl = r.audioUrl || r.audioPath || '';
            if (audioUrl && !audioUrl.startsWith('http') && !audioUrl.startsWith('magic://')) {
              audioUrl = `magic://local/${audioUrl.replace(/\\/g, '/')}`;
            }
            return {
              shotId: r.shotId,
              audioUrl,
              duration: r.duration || 0,
              _failed: r._failed || false,
              _error: r._error || '',
            };
          });
          s4.setTtsResults(mapped);
          // 实时更新 ttsProgress，避免 0→100 跳变
          s4.setTtsProgress(progress);
        }
      }
    }

    if (progress === 100 || status === 'success') {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);

      const actualExtractedImages = results?.frames || results?.framePaths || [];

      const finalPayload = {
        videoPath: storeState.extractedData.videoPath,
        vocalPath: results?.vocalPath || storeState.extractedData.vocalPath,
        backgroundPath: results?.backgroundPath || storeState.extractedData.backgroundPath,
        asrLines: asrBufferRef.current.length > 0 ? asrBufferRef.current : (results?.asrLines || []),
        framePaths: actualExtractedImages,
        frameCount: results?.frameCount || actualExtractedImages.length || storeState.extractedData.frameCount
      };

      storeState.setExtractedData?.(finalPayload);

      const nodeId: string = payload.nodeId || '';
      const isFrameNode = nodeId.includes('frame') || nodeId.includes('extract') || nodeId.includes('vision');
      if (isFrameNode && actualExtractedImages.length > 0) {
        useStep1Store.getState().setFrameCount(actualExtractedImages.length);
        AppNotifier.success(`智能分析中心：资产切片无损入库，共生成 ${actualExtractedImages.length} 个高清分镜！`);
      }

      window.api.ipc.invoke(IPC_CHANNELS.ENGINE_RUN_PIPELINE, {
        projectId: storeState.projectId,
        isSaveAction: true,
        extractedData: finalPayload
      }).catch(() => {}).finally(() => {
        const stepStatuses = pipelineState.stepStatuses;
        if (!stepStatuses || !stepStatuses.some((s: any) => s === 'running')) {
          pipelineState.setPipelineRunning?.(false);
        }
      });
    }

    if (status === 'error') {
      pipelineState.setPipelineRunning?.(false);
      AppNotifier.error(`核心引擎算力中断: ${error || '未知底层微服务崩溃'}`);
    }
  }, []);

  useEffect(() => {
    API.engine.onPipelineProgress(handlePipelineProgress);
    if (window.api?.ipc?.on) {
      window.api.ipc.on('QUICK_PIPELINE_PROGRESS', (_e: any, p: any) => handlePipelineProgress(p));
    }
    return () => {
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
      if (API.engine.offPipelineProgress) API.engine.offPipelineProgress();
    };
  }, [handlePipelineProgress]);

  const triggerLinearPipeline = useCallback(async () => {
    const storeState = useProjectStore.getState();
    const pipelineState = usePipelineStore.getState();
    if (!storeState.projectId) return AppNotifier.error('项目上下文丢失，无法运行');

    try {
      pipelineState.setPipelineRunning?.(true);
      pipelineState.setPipelineProgress?.(2, '唤醒本地大模型与音轨提取微服务中...');
      asrBufferRef.current = [];

      await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_RUN_PIPELINE, {
        projectId: storeState.projectId,
        isQuickMode: true
      });
    } catch (err) {
      AppNotifier.error('IPC 网络网关异常，请重启后端微服务守护进程');
    }
  }, []);

  return { triggerLinearPipeline, isRunning: pipelineStore.pipelineRunning };
};
