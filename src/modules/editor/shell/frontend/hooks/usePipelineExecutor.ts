// Module: editor/shell/hooks/usePipelineExecutor
// 原 editor/hooks/usePipelineExecutor.ts — 已迁移

import { useEffect, useCallback, useRef } from 'react';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { API } from '@renderer/api';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';
import { AppNotifier } from '@renderer/core/AppNotifier';
import { breakLongParagraphs } from '@modules/pipeline/step3-script/frontend/breakLongParagraphs';
import { normalizeScriptParagraph } from '../../../../../shared/utils/normalizeScriptParagraph';

/**
 * 节点标识 → 全局条中文名（两层进度分工）：
 * 全局状态条只展示"当前节点名 + 宏观百分比"，节点内的细粒度实时消息（如"正在撰写第2/18章"）
 * 由各步骤卡片内部进度条承担，避免全局条与节点内进度条文字重叠。
 */
const NODE_LABELS: Record<string, string> = {
  'audio-separate': '音轨分离',
  asr: '语音识别',
  'face-detect': '人脸检测',
  'cluster-faces': '人脸聚类',
  'vision-extract': '画面感知',
  'script-gen': '解说文案生成',
  'tts-synthesize': '语音合成',
  'semantic-analyze': '镜头匹配',
  'clip-semantic': '片段语义',
  'semantic-flow': '语义流编排',
  'sentiment-analyze': '情感分析',
  'llm-processor': '智能分析',
};

export const usePipelineExecutor = () => {
  const pipelineStore = usePipelineStore();
  const asrBufferRef = useRef<any[]>([]);
  const renderTimerRef = useRef<any>(null);
  /** 前端单调保护基线：记录已推送的全局进度最大值，保证状态条只增不减（与 L2 双保险） */
  const lastGlobalProgressRef = useRef<number>(-1);

  /** 接管主进程长连接信号，驱动前台组件重新渲染 */
  const handlePipelineProgress = useCallback((payload: any) => {
    if (!payload) return;

    console.log('====== [RENDERER RECEIVE 核心大包] ======', JSON.stringify(payload));

    const { progress, globalProgress, status, results, error, nodeName } = payload;
    const storeState = useProjectStore.getState();
    const pipelineState = usePipelineStore.getState();

    console.log(`[工作台大总线] 捕获长连接信号 -> 进度: ${progress}% | 状态: ${status}`);

    if (typeof pipelineState.setPipelineProgress === 'function') {
      // 🔧 L2 全局归一化进度优先（缺失时回退节点内部进度）；Math.max 防回退兜底（双保险）
      const nextProgress = typeof globalProgress === 'number' ? globalProgress : progress;
      const monotonic = Math.max(lastGlobalProgressRef.current, nextProgress);
      lastGlobalProgressRef.current = monotonic;
      // 🔧 两层分工：全局条只显示节点名（宏观）；节点细粒度消息由各步骤卡片内部进度条承担
      const nodeId: string = payload.nodeId || '';
      const nodeLabel = NODE_LABELS[nodeId] || payload.message || nodeName || `AI 核心提取管线全力运转中...`;
      pipelineState.setPipelineProgress(monotonic, nodeLabel);
    }

    // 🔧 评审回填：管线/步骤从 0 起步时（重跑或新管线）显式清空旧文案，
    // 杜绝"上一轮 18 章 + 新一轮第 1 章"翻倍膨胀（流式 append 的兜底清空）。
    // 🛑 根因修复：仅脚本节点自身起步/重跑才清空步骤3文案。
    //   其它节点（如步骤4独立 TTS）单节点序列的 ProgressAccumulator 区间也是 {0,100}，
    //   onProgress(0) 会被映射为 globalProgress=0，无条件清空会误删步骤4依赖的步骤3文案，
    //   导致配音列表整体消失（"没流式显示、完成也不显示"）。
    if (typeof globalProgress === 'number' && globalProgress === 0) {
      lastGlobalProgressRef.current = 0;
      const nodeId: string = payload.nodeId || '';
      if (nodeId.includes('script')) {
        useStep3Store.getState().setScriptParagraphs([]);
        useStep3Store.getState().setStreamMeta(null);
      }
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

      // 🔧 步骤3 章粒度流式：每章就绪即增量 append（§五 5.3-A）
      // 后端 ScriptGenStrategy 阶段2 每章通过质量校验后推送 partialParagraphs；
      // 单阶段模式一次性推送全量段落。流式仅用于即时渲染，落库以全量 Pipeline Result 覆写收敛。
      if (Array.isArray(results.partialParagraphs) && results.partialParagraphs.length > 0) {
        const nodeId: string = payload.nodeId || '';
        if (nodeId.includes('script')) {
          const s3 = useStep3Store.getState();
          /** ✅ 身份键统一：段落主键 id 出生处(ScriptGenStrategy)已强制 seg_{idx} 全局唯一，此层仅透传、
           *  不再做任何去重/追加后缀（删除了旧 idMap 兜底，防线收敛到唯一权威源头）。 */
          const paragraphs = results.partialParagraphs.map((p: any) => {
            return {
              /** ✅ 身份键统一：id 出生处即段落唯一主键，前端编辑/时间轴定位按此对齐 */
              id: p.id,
              text: p.text || p.content || '',
              shotId: p.shotId,
              duration: p.duration,
              emotion: p.emotion || '',
              characters: p.characters,
              visualIntent: p.visualIntent,
              startMs: p.startMs,
              durationMs: p.durationMs,
            };
          });
          const newParagraphs = breakLongParagraphs(paragraphs).map((x) => normalizeScriptParagraph({ ...x, editing: false }));
          s3.appendParagraphs(newParagraphs);
          // 🔧 章粒度流式元数据：驱动前端"正在推演第k/N章"进度显示（§五 5.3-C）
          if (results.streamMeta && typeof results.streamMeta.chapterIndex === 'number') {
            s3.setStreamMeta({
              chapterIndex: results.streamMeta.chapterIndex,
              totalChapters: results.streamMeta.totalChapters || 1,
            });
          }
        }
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
              /** ✅ 身份键统一：id 出生处即段落唯一主键（后端 Strategy 产 s.id||s.shotId），
               *  流式增量与主链路 mapPipelineResultToState 形态一致，消费端一律只读 id */
              id: r.id || r.shotId,
              shotId: r.id || r.shotId,
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
