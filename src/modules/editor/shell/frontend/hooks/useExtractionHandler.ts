// Module: editor/shell/hooks/useExtractionHandler
// 原 editor/hooks/useExtractionHandler.ts — 已迁移

import { useEffect } from 'react';
import { useStore } from '../../../../../renderer/src/store/useStore';
import { API } from '../../../../../renderer/src/api';
import { v4 as uuidv4 } from 'uuid';

function formatSeconds(seconds: number): string {
  if (!seconds && seconds !== 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const useExtractionHandler = (onAutoContinue?: (nextStep: number) => Promise<void>) => {
  useEffect(() => {
    API.events.onExtractionSuccess(async (payload: any) => {
      const state = useStore.getState();
      state.setStepCompleted(1, true);
      state.setStepStatus(1, 'completed');
      state.setPipelineRunning(false);

      const shots = payload.shots || [];
      const hasAsrLines = shots.some((s: any) => s.originalText && s.originalText.trim());
      const media = payload.media;
      const hasFrames = media?.frames && Array.isArray(media.frames) && media.frames.length > 0;
      const hasAudio = !!(media?.extractedAudio || media?.extractedVocals || media?.extractedBgm);
      const hasRoles = (payload.roles || []).length > 0;

      console.log('[DEBUG ASR] shots count:', shots.length, 'hasAsrLines:', hasAsrLines,
        'sample originalTexts:', shots.slice(0, 3).map((s: any) => s.originalText?.substring(0, 20)));

      state.setSubStepStatus('frames', hasFrames ? 'completed' : (state.subStepStatuses.frames || 'idle'));
      state.setSubStepStatus('audio', hasAudio ? 'completed' : (state.subStepStatuses.audio || 'idle'));
      state.setSubStepStatus('whisper', hasAsrLines ? 'completed' : (state.subStepStatuses.whisper || 'idle'));
      state.setSubStepStatus('faces', hasRoles ? 'completed' : (state.subStepStatuses.faces || 'idle'));

      let updatedMediaItems = [...state.mediaItems];
      const mediaId: string | null = payload.mediaId || payload.media?.id;

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
        if (hasAudio) { state.setAudioSeparated(true); }

        if (asrLines.length > 0) {
          state.setAsrLines(asrLines);
        } else if (media.asrLines || media.transcription) {
          state.setAsrLines(media.asrLines || media.transcription || []);
        }

        const frameCount = media.frames?.length || media.frameCount || 0;
        if (frameCount > 0) { state.setFrameCount(frameCount); }

        if (media.frames && Array.isArray(media.frames) && media.frames.length > 0) {
          const frameUrls = media.frames.map((frame: any) =>
            typeof frame === 'string' ? frame : (frame.path || frame.filePath || frame.thumbnail || '')
          ).filter(Boolean);
          if (frameUrls.length > 0) {
            state.setExtractedData({ framePaths: frameUrls, frameCount: frameUrls.length });
          }
        }

        const vlmFramesData = shots
          .filter((s: any) => s.visionText || (s.contextFrames && s.contextFrames.length > 0))
          .map((s: any) => ({
            url: (Array.isArray(s.contextFrames) && s.contextFrames.length > 0)
              ? s.contextFrames[0] : (s.coverPath || ''),
            description: s.visionText || '',
            editing: false,
            confirmed: !!(s.visionText && s.visionText.trim()),
          }));
        if (vlmFramesData.length > 0) { state.setVlmFrames(vlmFramesData); }

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
              filePath: media.extractedVocals, projectId: state.projectId, mediaId,
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
              id: uuidv4(), type: 'audio', sourceType: 'bgm',
              fileName: '分离背景音', name: '分离背景音',
              filePath: media.extractedBgm, projectId: state.projectId, mediaId,
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
              id: uuidv4(), type: 'audio', sourceType: 'extracted',
              fileName: '提取音频', name: '提取音频',
              filePath: media.extractedAudio, projectId: state.projectId, mediaId,
              createdAt: new Date().toISOString(),
            });
          }
        }

        state.setMediaItems(updatedMediaItems);

        if (mediaId) {
          try {
            await API.media.update(mediaId, {
              extractedAudio: media.extractedAudio,
              extractedVocals: media.extractedVocals,
              extractedBgm: media.extractedBgm,
              frames: media.frames,
              frameCount,
            });
          } catch { }
        }
      } else if (asrLines.length > 0) {
        state.setAsrLines(asrLines);
      }

      if (shots.length > 0) {
        state.hydrateProjectData({
          shots,
          aiShots: payload.aiShots || state.aiShots,
          roles: payload.roles || state.roles,
        });
      }

      const latestState = useStore.getState();
      if (latestState.projectId) {
        try {
          await API.project.saveData(latestState.projectId, {
            shots: latestState.shots, aiShots: latestState.aiShots,
            roles: latestState.roles, mediaItems: latestState.mediaItems,
            asrLines: latestState.asrLines, frameCount: latestState.frameCount,
            framePaths: latestState.extractedData?.framePaths || [],
            audioSeparated: latestState.audioSeparated,
            subStepStatuses: latestState.subStepStatuses,
            subStepProgresses: latestState.subStepProgresses,
            stepStatuses: latestState.stepStatuses,
            stepCompleted: latestState.stepCompleted,
            currentStep: latestState.currentStep,
            storyboardMode: latestState.storyboardMode,
            extractionConfig: latestState.extractionConfig,
            vlmFrames: latestState.vlmFrames,
          });
        } catch { }
      }

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
