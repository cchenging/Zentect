// Module: editor/preview/frontend/components/VideoCanvas
// 原 editor/components/player/VideoCanvas.tsx — 已迁移

import { useRef } from 'react';
import { useEditorStore } from '../../../../../../renderer/src/store/useStore';
import { getSafeMediaUrl } from '../../../../../../renderer/src/utils/formatUrl';

export const VideoCanvas = () => {
  const { activePlaySource, activeScript, activeShots, setCurrentTime, setVideoDuration } = useEditorStore();
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <div className="relative w-full h-full bg-[#050505] flex items-center justify-center overflow-hidden">
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
           <div className="bg-black/60 backdrop-blur-md px-4 py-2 rounded border border-white/10 shadow-2xl">
              <p className="text-[14px] text-zinc-100 font-bold leading-relaxed text-center">
                 {activeScript} 
              </p>
           </div>
        </div>
      )}

      {activeShots && activeShots.length > 0 && (
        <div className="absolute bottom-0 left-0 w-full h-20 bg-zinc-950/80 border-t border-zinc-800 flex items-center gap-2 px-3 overflow-x-auto no-scrollbar">
           {activeShots.map((shot: any, idx: number) => (
             <div 
               key={idx} 
               onClick={() => videoRef.current && (videoRef.current.currentTime = shot.start)}
               className="h-14 aspect-video bg-zinc-900 rounded border border-zinc-700 hover:border-blue-500 cursor-pointer transition-all flex-shrink-0 overflow-hidden relative group"
             >
                <img src={getSafeMediaUrl(shot.coverPath || shot.imagePath)} className="w-full h-full object-cover opacity-60 group-hover:opacity-100" />
                <span className="absolute bottom-0.5 right-1 text-[9px] font-mono text-zinc-400 bg-black/40 px-1 rounded">
                  {idx + 1} 
                </span>
             </div>
           ))}
        </div>
      )}

      {!activePlaySource && <div className="text-zinc-600 font-mono tracking-widest text-[11px]">NO SIGNAL</div>}
    </div>
  );
};
