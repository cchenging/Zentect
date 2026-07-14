// Module: editor/preview/frontend/components/VideoCanvas
// 原 editor/components/player/VideoCanvas.tsx — 已迁移

import { useRef, useEffect } from 'react';
import { Video } from 'lucide-react';
import { getSafeMediaUrl } from '../../../../../renderer/src/utils/formatUrl';
import { usePlayerStore } from '../../../stores/usePlayerStore';

export const VideoCanvas = () => {
  const activePlaySource = usePlayerStore((s) => s.activePlaySource);
  const activeScript = usePlayerStore((s) => s.activeScript);
  const activeShots = usePlayerStore((s) => s.activeShots);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setVideoDuration = usePlayerStore((s) => s.setVideoDuration);
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useEffect(() => {
    const unsub = usePlayerStore.subscribe(
      (state) => state.isPlaying,
      (isPlaying) => {
        const video = videoRef.current;
        if (!video) return;
        if (isPlaying) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      }
    );
    return unsub;
  }, []);

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
          src={getSafeMediaUrl(activePlaySource.path || activePlaySource.filePath)} 
          className="w-full h-full object-contain" 
          controls={false}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
        />
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
               onClick={() => videoRef.current && (videoRef.current.currentTime = shot.start)}
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
