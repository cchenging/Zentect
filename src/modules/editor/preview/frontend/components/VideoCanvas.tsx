// Module: editor/preview/frontend/components/VideoCanvas
// 原 editor/components/player/VideoCanvas.tsx — 已迁移

import { useRef, useEffect } from 'react';
import { Video, Music } from 'lucide-react';
import { getSafeMediaUrl } from '@renderer/utils/formatUrl';
import { usePlayerStore } from '@modules/editor/stores/usePlayerStore';

export const VideoCanvas = () => {
  const activePlaySource = usePlayerStore((s) => s.activePlaySource);
  const activeScript = usePlayerStore((s) => s.activeScript);
  const activeShots = usePlayerStore((s) => s.activeShots);
  const manualSeekTime = usePlayerStore((s) => s.manualSeekTime);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setVideoDuration = usePlayerStore((s) => s.setVideoDuration);
  const setManualSeekTime = usePlayerStore((s) => s.setManualSeekTime);
  // 💥 统一媒体引用：兼容 <video> 和 <audio>，避免音频源无法播放
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** 进度条拖拽 → 实际跳转媒体位置（视频/音频通用） */
  useEffect(() => {
    if (manualSeekTime === null) return;
    const media = videoRef.current || audioRef.current;
    if (!media) return;
    media.currentTime = manualSeekTime;
    setManualSeekTime(null);
  }, [manualSeekTime, setManualSeekTime]);

  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const prevIsPlayingRef = useRef(isPlaying);

  /** 播放/暂停控制：根据当前活跃媒体类型选择对应元素 */
  useEffect(() => {
    const media = videoRef.current || audioRef.current;
    if (!media) return;
    if (isPlaying && !prevIsPlayingRef.current) {
      media.play().catch(() => {});
    } else if (!isPlaying && prevIsPlayingRef.current) {
      media.pause();
    }
    prevIsPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // 💥 当前活跃媒体的 URL（视频或音频统一处理）
  const activeMediaUrl = activePlaySource
    ? getSafeMediaUrl(activePlaySource.path || activePlaySource.filePath)
    : null;

  return (
    <div className="relative w-full flex-1 min-h-0 bg-[var(--bg-deepest)] flex items-center justify-center overflow-hidden">
      {/* 📐 空状态：根据容器尺寸自适应缩放 */}
      {!activePlaySource && !activeScript && (
        <div className="flex flex-col items-center justify-center gap-[clamp(6px,2%,16px)] text-[var(--muted-foreground)] p-4 animate-in fade-in duration-300">
          <Video className="w-[clamp(28px,8%,56px)] h-[clamp(28px,8%,56px)] opacity-20" strokeWidth={1.2} />
          <span className="text-[clamp(11px,2.5vw,14px)] opacity-40 font-medium tracking-wider select-none">NO SIGNAL</span>
        </div>
      )}
      {activePlaySource?.type === 'video' && (
        <video 
          ref={videoRef}
          preload="auto"
          src={activeMediaUrl || undefined}
          className="w-full h-full object-contain" 
          controls={false}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
        />
      )}

      {/* 💥 新增：音频渲染分支 — 修复"分离音频不能播放"
          原因：原代码只渲染 <video>，type='audio' 时无任何媒体元素，
                导致 usePlayerStore.play() 找不到媒体对象而无法发声。
          修复：新增 <audio> 元素，复用 usePlayerStore 的播放状态与进度控制。
          UI：显示音频文件名 + 波形图标占位，让用户感知正在播放音频 */}
      {activePlaySource?.type === 'audio' && (
        <>
          <div className="flex flex-col items-center justify-center gap-3 text-[var(--muted-foreground)] p-6 animate-in fade-in duration-300 w-full max-w-md">
            <Music className="w-[clamp(40px,10%,72px)] h-[clamp(40px,10%,72px)] opacity-60" strokeWidth={1.2} />
            <span className="text-[13px] font-medium text-center truncate max-w-full">
              {activePlaySource.fileName || activePlaySource.name || 'Audio'}
            </span>
            {/* 隐藏的 audio 元素：由 usePlayerStore.isPlaying 控制 play/pause */}
            <audio
              ref={audioRef}
              preload="auto"
              src={activeMediaUrl || undefined}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
            />
          </div>
        </>
      )}

      {activeScript && (
        <div className="absolute bottom-24 left-0 w-full px-10 flex justify-center pointer-events-none animate-in fade-in slide-in-from-bottom-4 duration-500">
           <div className="bg-black/60 backdrop-blur-md px-4 py-2 rounded border border-[var(--border-default)] shadow-2xl">
              <p className="text-[14px] text-[var(--foreground)] font-bold leading-relaxed text-center">
                 {activeScript} 
              </p>
           </div>
        </div>
      )}

      {activeShots && activeShots.length > 0 && (
        <div className="absolute bottom-0 left-0 w-full h-20 bg-[var(--bg-deepest)]/80 border-t border-[var(--border-default)] flex items-center gap-2 px-3 overflow-x-auto no-scrollbar">
           {activeShots.map((shot: any, idx: number) => (
             <div 
              key={idx} 
              onClick={() => usePlayerStore.getState().seek(shot.start)}
              className="h-14 aspect-video bg-[var(--bg-secondary)] rounded border border-[var(--border-default)] hover:border-accent cursor-pointer transition-all flex-shrink-0 overflow-hidden relative group"
             >
                <img src={getSafeMediaUrl(shot.coverPath || shot.imagePath)} className="w-full h-full object-cover opacity-60 group-hover:opacity-100" />
                <span className="absolute bottom-0.5 right-1 text-[9px] font-mono text-[var(--muted-foreground)] bg-black/40 px-1 rounded">
                  {idx + 1} 
                </span>
             </div>
           ))}
        </div>
      )}

    </div>
  );
};
