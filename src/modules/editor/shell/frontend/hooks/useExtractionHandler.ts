// Module: editor/shell/hooks/useExtractionHandler
// 原 editor/hooks/useExtractionHandler.ts — 已迁移

import { useEffect } from 'react';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep2Store } from '@modules/pipeline/stores/useStep2Store';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { useEditorNavStore } from '@modules/editor/stores/useEditorNavStore';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { API } from '@renderer/api';
import { v4 as uuidv4 } from 'uuid';

function formatSeconds(seconds: number): string {
  if (!seconds && seconds !== 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/** 步骤1 的 4 个子任务 key（cluster/semantic 属于步骤2，不参与步骤1状态推导） */
const STEP1_SUBSTEPS = ['frames', 'audio', 'whisper', 'faces'] as const;

/**
 * 根据子任务状态推导步骤1总状态
 * - 全 completed → 'completed' + stepCompleted=true
 * - 任一 failed → 'failed' + stepCompleted=false
 * - 部分完成无失败 → 'idle' + stepCompleted=false（用户应手动重试未完成子任务）
 * - 全 idle → 'idle' + stepCompleted=false
 */
function deriveStep1Status(subStepStatuses: Record<string, string>): {
  stepStatus: 'completed' | 'failed' | 'idle';
  stepCompleted: boolean;
} {
  const step1Values = STEP1_SUBSTEPS
    .map(k => subStepStatuses[k])
    .filter(v => v !== undefined && v !== null);

  if (step1Values.length === 0) {
    return { stepStatus: 'idle', stepCompleted: false };
  }
  const hasFailed = step1Values.some(v => v === 'failed');
  const allCompleted = step1Values.length === STEP1_SUBSTEPS.length
    && step1Values.every(v => v === 'completed');

  if (allCompleted) return { stepStatus: 'completed', stepCompleted: true };
  if (hasFailed) return { stepStatus: 'failed', stepCompleted: false };
  return { stepStatus: 'idle', stepCompleted: false };
}

export const useExtractionHandler = (onAutoContinue?: (nextStep: number) => Promise<void>) => {
  useEffect(() => {
    API.events.onExtractionSuccess(async (payload: any) => {
      const projectState = useProjectStore.getState();
      const navState = useEditorNavStore.getState();
      const pipelineState = usePipelineStore.getState();
      pipelineState.setPipelineRunning(false);

      const shots = payload.shots || [];
      const hasAsrLines = shots.some((s: any) => s.originalText && s.originalText.trim());
      const media = payload.media;
      const hasFrames = media?.frames && Array.isArray(media.frames) && media.frames.length > 0;
      const hasAudio = !!(media?.extractedAudio || media?.extractedVocals || media?.extractedBgm);
      const hasRoles = (payload.roles || []).length > 0;

      console.log('[DEBUG ASR] shots count:', shots.length, 'hasAsrLines:', hasAsrLines,
        'sample originalTexts:', shots.slice(0, 3).map((s: any) => s.originalText?.substring(0, 20)));

      // 重新取最新状态：上方 pipelineState 是注册时的快照，需用最新值做降级判断
      const latestPipeline = usePipelineStore.getState();
      // 记录子步骤结束时间（仅在状态从 running → completed/failed 时）
      const finishSubStep = (key: string, hasData: boolean) => {
        const prev = latestPipeline.subStepStatuses[key];
        if (prev === 'running') {
          pipelineState.setSubStepFinished(key);
        }
        pipelineState.setSubStepStatus(key, hasData ? 'completed' : (prev === 'running' ? 'failed' : prev));
      };
      finishSubStep('frames', hasFrames);
      finishSubStep('audio', hasAudio);
      finishSubStep('whisper', hasAsrLines);
      finishSubStep('faces', hasRoles);

      /** 💥 关键修复：根据子任务结果推导 step1 总状态，替代旧版无条件 setStepStatus(1, 'completed')
       *  旧版 bug：faces/whisper 失败时 stepStatuses[0] 仍被置为 completed，与 subStepStatuses 不一致
       *  导致用户重进项目看到"步骤1已完成"但实际有子任务失败，无法重试 */
      const freshPipeline = usePipelineStore.getState();
      const derived = deriveStep1Status(freshPipeline.subStepStatuses);
      pipelineState.setStepCompleted(1, derived.stepCompleted);
      pipelineState.setStepStatus(1, derived.stepStatus);
      console.log('[Step1 状态推导]', {
        subStepStatuses: freshPipeline.subStepStatuses,
        derived,
      });

      let updatedMediaItems = [...projectState.mediaItems];
      const mediaId: string | null = payload.mediaId || payload.media?.id;

      const asrLines = shots
        .filter((s: any) => s.originalText && s.originalText.trim())
        .map((s: any) => {
          const original = s.originalText || s.aiText || '';
          const startMs = s.startMs !== undefined ? s.startMs : Math.round((s.start || 0) * 1000);
          const endMs = s.endMs !== undefined ? s.endMs : Math.round((s.end || 0) * 1000);
          return {
            start: formatSeconds(s.start),
            startMs,
            end: formatSeconds(s.end),
            endMs,
            text: original,
            originalText: original,
            editing: false,
          };
        });

      if (media) {
        if (hasAudio) { useStep1Store.getState().setAudioSeparated(true); }
        // 同步人声分离降级标记：供前端展示降级提示
        useStep1Store.getState().setVocalsIsFallback(!!media.vocalsIsFallback);

        if (asrLines.length > 0) {
          useStep1Store.getState().setAsrLines(asrLines);
        } else if (media.asrLines || media.transcription) {
          useStep1Store.getState().setAsrLines(media.asrLines || media.transcription || []);
        }

        const frameCount = media.frames?.length || media.frameCount || 0;
        if (frameCount > 0) { useStep1Store.getState().setFrameCount(frameCount); }

        if (media.frames && Array.isArray(media.frames) && media.frames.length > 0) {
          const frameUrls = media.frames.map((frame: any) =>
            typeof frame === 'string' ? frame : (frame.path || frame.filePath || frame.thumbnail || '')
          ).filter(Boolean);
          if (frameUrls.length > 0) {
            useProjectStore.getState().setExtractedData({ framePaths: frameUrls, frameCount: frameUrls.length });
          }
        }

        const vlmFramesData = shots
          .filter((s: any) => s.visionText || (s.contextFrames && s.contextFrames.length > 0))
          .map((s: any) => {
            const startMs = s.startMs !== undefined ? s.startMs : Math.round((s.start || 0) * 1000);
            return {
              url: (Array.isArray(s.contextFrames) && s.contextFrames.length > 0)
                ? s.contextFrames[0] : (s.coverPath || ''),
              description: s.visionText || '',
              editing: false,
              confirmed: !!(s.visionText && s.visionText.trim()),
              // 🎯 锚定透传：帧绝对时间（毫秒/可读格式），供 step3 填充段落 startMs、步骤5 按时间轴锚定
              timeMs: startMs,
              timeStr: formatSeconds(s.start),
            };
          });
        if (vlmFramesData.length > 0) { useStep2Store.getState().setVlmFrames(vlmFramesData); }

        updatedMediaItems = updatedMediaItems.map(item => {
          if (item.id === mediaId) {
            return {
              ...item,
              extractedAudio: media.extractedAudio,
              extractedVocals: media.extractedVocals,
              extractedBgm: media.extractedBgm,
              extractedText: asrLines.length > 0 ? asrLines : (media.asrLines || media.transcription),
              frames: media.frames,
              frameCount,
            };
          }
          return item;
        });

        if (media.extractedVocals) {
          const existingVocals = updatedMediaItems.find(
            m => m.type === 'audio' && m.sourceType === 'vocals'
          );
          if (!existingVocals) {
            updatedMediaItems.push({
              id: uuidv4(), type: 'audio', sourceType: 'vocals',
              fileName: '分离人声', name: '分离人声',
              // 🔧 修复 TS2322：extractedVocals 是 string | null，filePath 期望 string | undefined
              filePath: media.extractedVocals ?? undefined, projectId: projectState.projectId ?? undefined, mediaId: mediaId ?? undefined,
              createdAt: new Date().toISOString(),
            } as any);
          }
        }

        if (media.extractedBgm) {
          const existingBgm = updatedMediaItems.find(
            m => m.type === 'audio' && m.sourceType === 'bgm'
          );
          if (!existingBgm) {
            updatedMediaItems.push({
              id: uuidv4(), type: 'audio', sourceType: 'bgm',
              fileName: '分离背景音', name: '分离背景音',
              // 🔧 修复 TS2322：extractedBgm 是 string | null，filePath 期望 string | undefined
              filePath: media.extractedBgm ?? undefined, projectId: projectState.projectId ?? undefined, mediaId: mediaId ?? undefined,
              createdAt: new Date().toISOString(),
            } as any);
          }
        }

        if (media.extractedAudio && !media.extractedVocals && !media.extractedBgm) {
          const existingAudio = updatedMediaItems.find(
            m => m.type === 'audio' && m.sourceType === 'extracted'
          );
          if (!existingAudio) {
            updatedMediaItems.push({
              id: uuidv4(), type: 'audio', sourceType: 'extracted',
              fileName: '提取音频', name: '提取音频',
              // 🔧 修复 TS2322：extractedAudio 是 string | null，filePath 期望 string | undefined
              filePath: media.extractedAudio ?? undefined, projectId: projectState.projectId ?? undefined, mediaId: mediaId ?? undefined,
              createdAt: new Date().toISOString(),
            } as any);
          }
        }

        projectState.setMediaItems(updatedMediaItems);

        if (mediaId) {
          try {
            await API.media.update(mediaId, {
              extractedAudio: media.extractedAudio,
              extractedVocals: media.extractedVocals,
              extractedBgm: media.extractedBgm,
              frames: media.frames,
              frameCount,
              // 🔧 修复：补传 extractedText，与内存 mediaItems 保持一致
              // 旧版漏传 → DB 的 extracted_text 始终为 NULL（后端 JobScheduler 已兜底，这里作防御）
              extractedText: asrLines.length > 0 ? asrLines : (media.asrLines || media.transcription),
            });
          } catch { }
        }
      } else if (asrLines.length > 0) {
        useStep1Store.getState().setAsrLines(asrLines);
      }

      // 写入 roles（独立于 shots，避免因 shots 为空导致角色数据丢失）
      // 🛑 原则 2：partial 增量走 mergePartialUpdate,不进 hydrate(避免清空其他字段)
      if (payload.roles && payload.roles.length > 0) {
        projectState.mergePartialUpdate({
          roles: payload.roles,
        });
      }

      if (shots.length > 0) {
        projectState.mergePartialUpdate({
          shots,
          aiShots: payload.aiShots || projectState.aiShots,
        });
      }

      const latestProjectState = useProjectStore.getState();
      const latestNavState = useEditorNavStore.getState();
      // 🔧 关键修复：重新取最新 pipeline 状态，避免保存注册时的 stale 快照（全 idle）到 metadata
      // 旧版 bug：上方 pipelineState 是 useEffect 注册时抓的快照，重进后 hydrate 读到全 idle → "结果丢失"
      const freshPipelineState = usePipelineStore.getState();
      if (latestProjectState.projectId) {
        try {
          await API.project.saveData(latestProjectState.projectId, {
            shots: latestProjectState.shots, aiShots: latestProjectState.aiShots,
            roles: latestProjectState.roles, mediaItems: latestProjectState.mediaItems,
            asrLines: useStep1Store.getState().asrLines, frameCount: latestProjectState.extractedData?.framePaths?.length || 0,
            framePaths: latestProjectState.extractedData?.framePaths || [],
            audioSeparated: useStep1Store.getState().audioSeparated,
            subStepStatuses: freshPipelineState.subStepStatuses,
            subStepProgresses: freshPipelineState.subStepProgresses,
            subStepTimings: freshPipelineState.subStepTimings,
            stepStatuses: freshPipelineState.stepStatuses,
            stepCompleted: freshPipelineState.stepCompleted,
            currentStep: latestNavState.currentStep,
            storyboardMode: latestProjectState.storyboardMode,
            extractionConfig: useStep1Store.getState().extractionConfig,
            vlmFrames: useStep2Store.getState().vlmFrames,
          });
        } catch (e) {
          // 🔧 修复 R6：不再静默吞掉异常，便于排查 DB 写入失败
          console.error('[useExtractionHandler] saveData 失败', e);
        }
      }

      if (navState.isAutoMode && onAutoContinue) {
        navState.setCurrentStep(2);
        await onAutoContinue(2);
      }
    });

    return () => {
      if (typeof API.events.offExtractionSuccess === 'function') {
        API.events.offExtractionSuccess();
      } else {
        console.warn('[useExtractionHandler] offExtractionSuccess 方法不存在，监听器可能泄漏');
      }
    };
  }, [onAutoContinue]);
};
