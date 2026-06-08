// 📁 路径: src/renderer/src/pages/Editor/components/Player/hooks/useMediaRouter.ts
import { useMemo } from 'react';
import { useEditorStore } from '../../../store/useStore';
import { getSafeMediaUrl } from '../../../utils/formatUrl';
import type {} from 'react';

export const useMediaRouter = () => {
  const { activePlaySource, mediaItems: mediaItemsStore, storyboardMode, shots, aiShots, globalFocusMode, currentTime } = useEditorStore();

  // 💥 防御性编程：确保 mediaItems 是数组
  const mediaItems = Array.isArray(mediaItemsStore) ? mediaItemsStore : [];

  const activeShotsList = useMemo(() => storyboardMode === 'ai' ? aiShots : shots, [shots, aiShots, storyboardMode]);
  const activeShotForSource = shots.find(s => currentTime >= (s.start||0) && currentTime < (s.end||0)) || shots[0];
  const activeShot = activeShotsList.find(s => currentTime >= s.start && currentTime < s.end);

  // 💥 1. 轨道模式下的信号判定
  const isTimelineAudioOnly = activeShotForSource?.type === 'audio';
  const isTimelineStaticImage = activeShotForSource?.type === 'image';
  const timelineSubtitle = storyboardMode === 'ai' ? activeShot?.aiText : activeShot?.originalText;
  const currentMediaFromTimeline = mediaItems.find(m => m.id === activeShotForSource?.mediaId);

  // 💥 2. 素材焦点模式下的信号判定
  const isSourceAudio = globalFocusMode === 'media' && activePlaySource?.type === 'audio';
  const isSourceImage = globalFocusMode === 'media' && activePlaySource?.type === 'image';
  const isSourceVideo = globalFocusMode === 'media' && (activePlaySource?.type === 'video' || activePlaySource?.type === 'frame');

  // 💥 3. 终极信号熔断器：根据焦点选择输出源
  const finalIsAudioOnly = globalFocusMode === 'media' ? isSourceAudio : isTimelineAudioOnly;
  const finalIsStaticImage = globalFocusMode === 'media' ? isSourceImage : isTimelineStaticImage;
  const finalSubtitle = globalFocusMode === 'media' ? '' : (timelineSubtitle || '');
  const finalCurrentMedia = globalFocusMode === 'media' ? activePlaySource : currentMediaFromTimeline;

  const renderTracks = useMemo(() => {
    // 🚦 路线 A：如果在源素材监视器模式，强行旁路输出，不看轨道
    if (globalFocusMode === 'media') {
       return {
          videoLayer: (isSourceVideo || isSourceImage) && activePlaySource ? { src: getSafeMediaUrl(activePlaySource.filePath) } : null,
          audioLayer: isSourceAudio && activePlaySource ? { src: getSafeMediaUrl(activePlaySource.filePath) } : null
       };
    }

    // 🚦 路线 B：轨道模式混合渲染
    return {
      videoLayer: activeShotForSource ? { src: getSafeMediaUrl(activeShotForSource.filePath) } : null,
      audioLayer: null // 预留给复杂混音器
    };
  }, [globalFocusMode, activePlaySource, activeShotForSource, isSourceVideo, isSourceImage, isSourceAudio]);

  return {
    currentMedia: finalCurrentMedia,
    isStaticImage: finalIsStaticImage,
    isAudioOnly: finalIsAudioOnly,
    activeShotsList,
    activeShot,
    renderTracks,
    currentSubtitle: finalSubtitle
  };
};
