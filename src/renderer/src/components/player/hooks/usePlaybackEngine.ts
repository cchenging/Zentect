// 📁 路径：src/renderer/src/pages/Editor/components/Player/hooks/usePlaybackEngine.ts
import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { useEditorStore } from '../../../store/useStore';

export const usePlaybackEngine = (videoRef: MutableRefObject<HTMLVideoElement | null>) => {

  // =========================================================
  // 💥 引擎核心：权威时间轴与画面柔性同步 (Play & Drift Correction)
  // 彻底告别卡顿！主发条永远以 EditorStore 为准。
  // <video> 自己播放，本引擎负责防滑点监控：只要漂移 > 150ms 才会出手干预！
  // =========================================================
  useEffect(() => {
    let animationFrameId: number;

    const syncLoop = () => {
      const { isPlaying, currentTime } = useEditorStore.getState();
      const { globalFocusMode, shots, aiShots, storyboardMode } = useEditorStore.getState();

      if (videoRef.current) {
         let expectedLocalTime = -1;

         // 1. 判断是播素材还是播轨道
         if (globalFocusMode === 'media') {
             expectedLocalTime = currentTime;
         } else {
             const activeShotsList = storyboardMode === 'ai' ? aiShots : shots;
             const activeShot = activeShotsList.find(s => currentTime >= (s.start||0) && currentTime < (s.end||0));
             if (activeShot) {
                 expectedLocalTime = currentTime - (activeShot.start||0);
             }
         }

         // 2. 误差探测系统（防互殴机制）
         if (expectedLocalTime >= 0) {
             const drift = Math.abs(videoRef.current.currentTime - expectedLocalTime);

             // 💥 只有漂移超过 0.15 秒（约 4 帧），或者是暂停状态下被拖拽进度条时，才强行更新物理时间
             // 这保障了 HTML5 原生播放的流畅性，彻底终结了"疯狂闪第一帧"的惨案！
             if (drift > 0.15 || !isPlaying) {
                 videoRef.current.currentTime = expectedLocalTime;
             }
         }
      }

      if (isPlaying) {
        animationFrameId = requestAnimationFrame(syncLoop);
      }
    };

    const unsub = useEditorStore.subscribe(
      (state) => ({ isPlaying: state.isPlaying, currentTime: state.currentTime }),
      (state, prevState) => {
        // 核心点火开关：监听用户点击播放/暂停
        if (state.isPlaying !== prevState.isPlaying) {
            if (state.isPlaying && videoRef.current) {
                videoRef.current.play().catch(console.error);
                animationFrameId = requestAnimationFrame(syncLoop);
            } else if (!state.isPlaying && videoRef.current) {
                videoRef.current.pause();
                cancelAnimationFrame(animationFrameId);
                syncLoop(); // 刹车时追加一次精确对齐
            }
        }

        // 当视频处于暂停状态，用户拖拽游标时：触发一帧的高精度同步更新画面
        if (!state.isPlaying && state.currentTime !== prevState.currentTime) {
           syncLoop();
        }
      }
    );

    return () => {
        unsub();
        cancelAnimationFrame(animationFrameId);
    };
  }, []);
};
