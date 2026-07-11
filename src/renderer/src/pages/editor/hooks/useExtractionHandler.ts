/**
 * @deprecated 已迁移至 src/modules/editor/shell/frontend/hooks/useExtractionHandler.ts
 * 请使用 import { useExtractionHandler } from '@/modules/editor/shell'
 */

import { useEffect } from 'react';
import { useStore } from '../../../store/useStore';
import { useProjectStore } from '../../../../../modules/editor/stores/useProjectStore';
import { usePipelineStore } from '../../../../../renderer/src/store/usePipelineStore';
import { useEditorNavStore } from '../../../../../modules/editor/stores/useEditorNavStore';
import { useStep1Store } from '../../../../../modules/pipeline/stores/useStep1Store';
import { useStep2Store } from '../../../../../modules/pipeline/stores/useStep2Store';
import { API } from '../../../api';
import { v4 as uuidv4 } from 'uuid';

/** 将秒数格式化为 mm:ss */
function formatSeconds(seconds: number): string {
  if (!seconds && seconds !== 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * 素材提取完成事件处理 Hook
 * 监听提取完成事件，自动更新 Store 状态，自动模式下通过回调推进到下一步骤
 * 核心修复：从 shots 中提取 ASR 数据，正确映射后端字段，自动添加媒体到左侧库
 * @param onAutoContinue 自动模式递进回调，由 usePipelineOrchestrator 提供
 */
export const useExtractionHandler = (onAutoContinue?: (nextStep: number) => Promise<void>) => {
  useEffect(() => {
    /** 素材提取成功事件处理器 */
    API.events.onExtractionSuccess(async (payload: any) => {
      const state = useStore.getState();
      state.setStepCompleted(1, true);
      state.setStepStatus(1, 'completed');
      state.setPipelineRunning(false);

      /** 💥 根据实际结果设置子步骤状态，而非无条件全部标记完成 */
      const shots = payload.shots || [];
      const hasAsrLines = shots.some((s: any) => s.originalText && s.originalText.trim());
      const media = payload.media;
      const hasFrames = media?.frames && Array.isArray(media.frames) && media.frames.length > 0;
      const hasAudio = !!(media?.extractedAudio || media?.extractedVocals || media?.extractedBgm);
      const hasRoles = (payload.roles || []).length > 0;

      /** 💥 调试日志：确认 ASR 数据是否正确传递到前端 */
      console.log('[DEBUG ASR] shots count:', shots.length, 'hasAsrLines:', hasAsrLines,
        'sample originalTexts:', shots.slice(0, 3).map((s: any) => s.originalText?.substring(0, 20)));

      state.setSubStepStatus('frames', hasFrames ? 'completed' : (state.subStepStatuses.frames || 'idle'));
      state.setSubStepStatus('audio', hasAudio ? 'completed' : (state.subStepStatuses.audio || 'idle'));
      state.setSubStepStatus('whisper', hasAsrLines ? 'completed' : (state.subStepStatuses.whisper || 'idle'));
      state.setSubStepStatus('faces', hasRoles ? 'completed' : (state.subStepStatuses.faces || 'idle'));

      let updatedMediaItems = [...state.mediaItems];
      const mediaId: string | null = payload.mediaId || payload.media?.id;

      /** 从 shots 中提取 ASR 台词数据（shots 已在上面声明） */
      const asrLines = shots
        .filter((s: any) => s.originalText && s.originalText.trim())
        .map((s: any) => {
          const original = s.originalText || s.aiText || '';
          return {
            start: formatSeconds(s.start),
            end: formatSeconds(s.end),
            text: original,
            originalText: original,
          };
        });

      if (media) {

        /** 音频分离状态（hasAudio 已在上面声明） */
        if (hasAudio) {
          useStep1Store.getState().setAudioSeparated(true);
        }

        /** ASR 台词：优先从 shots 提取，其次从 media 字段取 */
        if (asrLines.length > 0) {
          useStep1Store.getState().setAsrLines(asrLines);
        } else if (media.asrLines || media.transcription) {
          useStep1Store.getState().setAsrLines(media.asrLines || media.transcription || []);
        }

        /** 帧数量 */
        const frameCount = media.frames?.length || media.frameCount || 0;
        if (frameCount > 0) {
          useStep1Store.getState().setFrameCount(frameCount);
        }

        /** 将帧路径写入 extractedData.framePaths，供帧预览网格使用 */
        if (media.frames && Array.isArray(media.frames) && media.frames.length > 0) {
          const frameUrls = media.frames.map((frame: any) =>
            typeof frame === 'string' ? frame : (frame.path || frame.filePath || frame.thumbnail || '')
          ).filter(Boolean);
          if (frameUrls.length > 0) {
            useProjectStore.getState().setExtractedData({ framePaths: frameUrls, frameCount: frameUrls.length });
          }
        }

        /** 💥 VLM 画面描述：从 shots 的 visionText + contextFrames 构建 vlmFrames，
         *  打通步骤1→步骤2的数据链路 */
        const vlmFramesData = shots
          .filter((s: any) => s.visionText || (s.contextFrames && s.contextFrames.length > 0))
          .map((s: any) => ({
            url: (Array.isArray(s.contextFrames) && s.contextFrames.length > 0)
              ? s.contextFrames[0] : (s.coverPath || ''),
            description: s.visionText || '',
            editing: false,
            confirmed: !!(s.visionText && s.visionText.trim()),
          }));
        if (vlmFramesData.length > 0) {
          state.setVlmFrames(vlmFramesData);
        }

        /** 更新 mediaItems 中对应媒体 */
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

        /** === 帧数据已通过 extractedData.framePaths 写入，不再添加到 mediaItems ===
         *  帧预览统一在 StepMaterialAnalysis 的帧预览网格中展示，
         *  素材库只保留视频和音频，避免几百张帧淹没素材列表 */

        /** === 自动添加人声和背景音到 mediaItems === */
        if (media.extractedVocals) {
          const existingVocals = updatedMediaItems.find(
            m => m.type === 'audio' && m.sourceType === 'vocals'
          );
          if (!existingVocals) {
            updatedMediaItems.push({
              id: uuidv4(),
              type: 'audio',
              sourceType: 'vocals',
              fileName: '分离人声',
              name: '分离人声',
              filePath: media.extractedVocals,
              projectId: state.projectId,
              mediaId: mediaId,
              createdAt: new Date().toISOString(),
            });
          }
        }

        if (media.extractedBgm) {
          const existingBgm = updatedMediaItems.find(
            m => m.type === 'audio' && m.sourceType === 'bgm'
          );
          if (!existingBgm) {
            updatedMediaItems.push({
              id: uuidv4(),
              type: 'audio',
              sourceType: 'bgm',
              fileName: '分离背景音',
              name: '分离背景音',
              filePath: media.extractedBgm,
              projectId: state.projectId,
              mediaId: mediaId,
              createdAt: new Date().toISOString(),
            });
          }
        }

        if (media.extractedAudio && !media.extractedVocals && !media.extractedBgm) {
          const existingAudio = updatedMediaItems.find(
            m => m.type === 'audio' && m.sourceType === 'extracted'
          );
          if (!existingAudio) {
            updatedMediaItems.push({
              id: uuidv4(),
              type: 'audio',
              sourceType: 'extracted',
              fileName: '提取音频',
              name: '提取音频',
              filePath: media.extractedAudio,
              projectId: state.projectId,
              mediaId: mediaId,
              createdAt: new Date().toISOString(),
            });
          }
        }

        state.setMediaItems(updatedMediaItems);

        /** 持久化媒体信息到后端 */
        if (mediaId) {
          try {
            await API.media.update(mediaId, {
              extractedAudio: media.extractedAudio,
              extractedVocals: media.extractedVocals,
              extractedBgm: media.extractedBgm,
              frames: media.frames,
              frameCount,
            });
          } catch (updateErr) {
            console.error('[Editor] 更新媒体信息失败:', updateErr);
          }
        }
      } else if (asrLines.length > 0) {
        /** 没有 media 但有 shots 中的 ASR 数据 */
        useStep1Store.getState().setAsrLines(asrLines);
      }

      /** 更新 shots 和 roles 数据 */
      if (shots.length > 0) {
        state.hydrateProjectData({
          shots,
          /** 💥 修复主键冲突：aiShots 不能 fallback 到 shots，
           *  否则 shots 和 aiShots 有相同 id，saveData 合并后插入 DB 会 UNIQUE constraint failed */
          aiShots: payload.aiShots || state.aiShots,
          roles: payload.roles || state.roles,
        });
      }

      /** 持久化项目数据 */
      /** 💥 关键修复：保存前重新获取最新 store 状态，
       *  因为前面的 setSubStepStatus/setAsrLines 等操作已经更新了 store，
       *  但回调开始时的 state 快照还是旧值 */
      const latestState = useStore.getState();
      if (latestState.projectId) {
        try {
          const savePayload = {
            shots: latestState.shots,
            aiShots: latestState.aiShots,
            roles: latestState.roles,
            mediaItems: latestState.mediaItems,
            asrLines: useStep1Store.getState().asrLines,
            frameCount: useStep1Store.getState().frameCount,
            /** 💥 显式持久化帧路径数组，确保重进项目帧预览不丢失 */
            framePaths: latestState.extractedData?.framePaths || [],
            audioSeparated: useStep1Store.getState().audioSeparated,
            subStepStatuses: latestState.subStepStatuses,
            subStepProgresses: latestState.subStepProgresses,
            stepStatuses: latestState.stepStatuses,
            stepCompleted: latestState.stepCompleted,
            /** 💥 持久化当前步骤，确保重进后能继续下一步 */
            currentStep: latestState.currentStep,
            storyboardMode: latestState.storyboardMode,
            /** 💥 持久化抽帧配置，确保重进项目后参数不丢失 */
            extractionConfig: latestState.extractionConfig,
            /** 💥 持久化 VLM 画面描述数据，确保重进项目后步骤2数据不丢失 */
            vlmFrames: latestState.vlmFrames,
          };
          await API.project.saveData(latestState.projectId, savePayload);
        } catch (saveErr) {
          console.error('[Editor] 保存提取结果失败:', saveErr);
        }
      }

      /** 自动模式递进 */
      if (state.isAutoMode && onAutoContinue) {
        state.setCurrentStep(2);
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
