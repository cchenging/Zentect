import React, { useState, useEffect } from 'react';
import { Play, Pause, Volume2, VolumeX, MonitorPlay, ZoomIn, Maximize, Check } from 'lucide-react';

import { Slider } from '../ui/slider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';

import { useEditorStore } from '../../store/useStore';
import { PlaybackEngine } from '../../pages/editor/core/PlaybackEngine';
import { useI18n } from '../../store/useI18n';

const formatTimecode = (seconds: number) => {
  if (isNaN(seconds) || seconds < 0) return '00:00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const f = Math.floor((seconds % 1) * 30);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
};

const parseDuration = (dur: any) => {
  if (typeof dur === 'number') return dur;
  if (typeof dur === 'string') {
    const parts = dur.split(':').map(Number);
    if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
    if (parts.length === 2) return parts[0]*60 + parts[1];
    return Number(dur) || 10;
  }
  return 10;
};

export const PlayerControls: React.FC = () => {
  const {
    setCurrentTime, videoDuration,
    projectRatio, setProjectRatio, canvasZoom, setCanvasZoom, isCanvasFit, setIsCanvasFit,
    globalFocusMode, activePlaySource,
    isPlaying, currentTime, seek, setDuration
  } = useEditorStore();
  const { t } = useI18n();

  const displayDuration = globalFocusMode === 'media' && activePlaySource ?
    parseDuration(activePlaySource.duration) : videoDuration;

  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    if (displayDuration > 0) setDuration(displayDuration);
  }, [displayDuration, setDuration]);

  useEffect(() => {
    setCurrentTime(currentTime);
  }, [currentTime, setCurrentTime]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        PlaybackEngine.togglePlay();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handlePlayToggle = () => {
    if (!isPlaying && currentTime >= displayDuration && displayDuration > 0) {
      useEditorStore.setState({ currentTime: 0 });
      setCurrentTime(0);
    }
    PlaybackEngine.togglePlay();
  };

  const handleSeek = (value: number[]) => {
    if (!value || value.length === 0) return;
    setCurrentTime(value[0]);
    seek(value[0]);
  };

  const handleZoomSliderChange = (value: number[]) => {
    if (!value || value.length === 0) return;
    setIsCanvasFit(false);
    setCanvasZoom(value[0]);
  };

  const handleFullscreen = () => {
    const playerNode = document.getElementById('player-container');
    if (!document.fullscreenElement && playerNode) playerNode.requestFullscreen();
    else if (document.fullscreenElement) document.exitFullscreen();
  };

  return (
    <div className="relative h-10 shrink-0 bg-[#121212] border-t border-white/5 flex items-center px-4 select-none z-10 w-full">
      {/* 极细进度条悬浮于分界线 */}
      <div className="absolute top-0 left-0 right-0 z-20 px-0 -translate-y-1/2 group">
        <Slider
          value={[currentTime]}
          max={displayDuration > 0 ? displayDuration : 100}
          step={0.01}
          onValueChange={handleSeek}
          className="w-full cursor-pointer"
        />
      </div>

      <div className="flex-1 flex items-center gap-2 font-mono tabular-nums tracking-wider whitespace-nowrap min-w-max">
        <span className="text-white/90 text-[11px] font-semibold shrink-0">{formatTimecode(currentTime)}</span>
        <span className="text-white/40 text-[10px] shrink-0">/ {formatTimecode(displayDuration)}</span>
      </div>

      <div className="shrink-0 flex items-center justify-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={handlePlayToggle}
          className="w-8 h-8 rounded-md text-white hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-primary shadow-none transition-colors"
        >
          {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
        </Button>
      </div>

      <div className="flex-1 flex justify-end items-center gap-1.5">
        <Button
          variant="ghost" size="icon"
          onClick={() => setIsMuted(!isMuted)}
          className="w-8 h-8 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors"
        >
          {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </Button>

        <div className="w-[1px] h-4 bg-white/10 mx-1" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="w-8 h-8 rounded-md text-white/40 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10 transition-colors" title={`${t.editor?.tooltip_ratio || '画幅'}: ${projectRatio}`}>
              <MonitorPlay size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="w-32 z-50 bg-[#1a1a1a] border-white/10">
            {
              [
                { v: '16:9', l: t.editor?.ratio_16_9 || '16:9' },
                { v: '9:16', l: t.editor?.ratio_9_16 || '9:16' },
                { v: '4:3', l: t.editor?.ratio_4_3 || '4:3' },
                { v: '1:1', l: t.editor?.ratio_1_1 || '1:1' }
              ].map(opt => (
                <DropdownMenuItem
                  key={opt.v}
                  onClick={() => setProjectRatio(opt.v as any)}
                  className={`flex items-center justify-between cursor-pointer focus:bg-white/10 ${projectRatio === opt.v ? 'text-primary font-medium' : 'text-white/80'}`}
                >
                  <span className="text-[11px]">{opt.l}</span>
                  {projectRatio === opt.v && <Check size={12} className="text-primary" />}
                </DropdownMenuItem>
              ))
            }
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="w-[1px] h-4 bg-white/10 mx-1" />

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="w-8 h-8 rounded-md text-white/40 hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10 transition-colors" title={t.editor?.tooltip_zoom || '缩放'}>
              <ZoomIn size={14} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={8} className="w-[200px] p-4 z-50 flex flex-col gap-4 bg-[#1a1a1a] border-white/10">
            <div className="flex justify-between items-center">
              <span className="text-white/90 text-[11px] font-medium">{t.editor?.zoom_title || '画布缩放'}</span>
              <span className="font-mono text-[10px] text-white/40 bg-black/40 border border-white/5 px-1.5 py-0.5 rounded">{isCanvasFit ? t.editor?.zoom_fit_short || '自适应' : `${canvasZoom}%`}</span>
            </div>

            <Slider
              value={[isCanvasFit ? 100 : canvasZoom]}
              min={25} max={400} step={1}
              onValueChange={handleZoomSliderChange}
              className="w-full cursor-pointer"
            />

            <div className="flex gap-2 mt-1">
               <Button
                 variant={isCanvasFit ? "default" : "outline"}
                 size="sm"
                 onClick={() => { setIsCanvasFit(true); setCanvasZoom(100); }}
                 className={`flex-1 h-7 text-[10px] ${isCanvasFit ? 'bg-primary text-primary-foreground' : 'bg-black/40 text-white/60 border-white/10 hover:bg-white/10 hover:text-white'}`}
               >
                 {t.editor?.zoom_fit || '自适应'}
               </Button>
               <Button
                 variant={!isCanvasFit && canvasZoom === 100 ? "default" : "outline"}
                 size="sm"
                 onClick={() => { setIsCanvasFit(false); setCanvasZoom(100); }}
                 className={`flex-1 h-7 text-[10px] ${!isCanvasFit && canvasZoom === 100 ? 'bg-primary text-primary-foreground' : 'bg-black/40 text-white/60 border-white/10 hover:bg-white/10 hover:text-white'}`}
               >
                 {t.editor?.zoom_100 || '100%'}
               </Button>
            </div>
          </PopoverContent>
        </Popover>

        <div className="w-[1px] h-4 bg-white/10 mx-1" />

        <Button variant="ghost" size="icon" onClick={handleFullscreen} className="w-8 h-8 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors" title={t.editor?.tooltip_fullscreen || '全屏'}>
          <Maximize size={14} />
        </Button>

      </div>
    </div>
  );
};
