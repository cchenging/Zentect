// Module: editor/preview/frontend/components/PlayerControls
// 原 editor/components/player/PlayerControls.tsx — 已迁移

import React, { useState, useEffect } from 'react';
import { Play, Pause, Volume2, VolumeX, MonitorPlay, ZoomIn, Maximize, Check } from 'lucide-react';

import { Slider } from '../../../../../renderer/src/components/ui/slider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../../../renderer/src/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../../renderer/src/components/ui/popover';
import { Button } from '../../../../../renderer/src/components/ui/button';

import { useEditorStore } from '../../../../../renderer/src/store/useStore';
import { PlaybackEngine } from '../../../../../renderer/src/pages/editor/core/PlaybackEngine';
import { useI18n } from '../../../../../renderer/src/store/useI18n';

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
  const [volume, setVolume] = useState(80);

  const handleVolumeChange = (value: number[]) => {
    if (!value || value.length === 0) return;
    const v = value[0];
    setVolume(v);
    setIsMuted(v === 0);
    const videoEl = document.querySelector('video') as HTMLVideoElement | null;
    if (videoEl) videoEl.volume = v / 100;
  };

  const handleMuteToggle = () => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    const videoEl = document.querySelector('video') as HTMLVideoElement | null;
    if (videoEl) videoEl.muted = newMuted;
  };

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
    <div className="relative h-10 shrink-0 bg-[var(--bg-secondary)] border-t border-[var(--border-default)] flex items-center px-4 select-none z-10 w-full">
      <div className="absolute top-0 left-0 right-0 z-20 px-0 -translate-y-1/2 group">
        <Slider
          value={[currentTime]}
          max={displayDuration > 0 ? displayDuration : 100}
          step={0.01}
          onValueChange={handleSeek}
          className="w-full cursor-pointer"
        />
      </div>

      <div className="shrink-0 flex items-center justify-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={handlePlayToggle}
          className="w-8 h-8 rounded-md text-[var(--foreground)] hover:bg-muted focus-visible:ring-1 focus-visible:ring-primary shadow-none transition-colors"
        >
          {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
        </Button>
      </div>

      <div className="flex items-center gap-2 font-mono tabular-nums tracking-wider whitespace-nowrap min-w-max">
        <span className="text-[var(--foreground)] text-[11px] font-semibold shrink-0">{formatTimecode(currentTime)}</span>
        <span className="text-[var(--muted-foreground)] text-[10px] shrink-0">/ {formatTimecode(displayDuration)}</span>
      </div>

      <div className="flex-1" />

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="w-8 h-8 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-muted data-[state=open]:bg-muted transition-colors" title={t.editor?.tooltip_zoom || '缩放'}>
            <ZoomIn size={14} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-[200px] p-4 z-50 flex flex-col gap-4 bg-[var(--bg-tertiary)] border-[var(--border-default)]">
          <div className="flex justify-between items-center">
            <span className="text-[var(--foreground)] text-[11px] font-medium">{t.editor?.zoom_title || '画布缩放'}</span>
            <span className="font-mono text-[10px] text-[var(--muted-foreground)] bg-black/40 border border-[var(--border-default)] px-1.5 py-0.5 rounded">{isCanvasFit ? t.editor?.zoom_fit_short || '自适应' : `${canvasZoom}%`}</span>
          </div>
          <Slider value={[isCanvasFit ? 100 : canvasZoom]} min={25} max={400} step={1} onValueChange={handleZoomSliderChange} className="w-full cursor-pointer" />
          <div className="flex gap-2 mt-1">
             <Button variant={isCanvasFit ? "default" : "outline"} size="sm" onClick={() => { setIsCanvasFit(true); setCanvasZoom(100); }} className={`flex-1 h-7 text-[10px] ${isCanvasFit ? 'bg-primary text-primary-foreground' : 'bg-black/40 text-[var(--muted-foreground)] border-[var(--border-default)] hover:bg-muted hover:text-[var(--foreground)]'}`}>{t.editor?.zoom_fit || '自适应'}</Button>
             <Button variant={!isCanvasFit && canvasZoom === 100 ? "default" : "outline"} size="sm" onClick={() => { setIsCanvasFit(false); setCanvasZoom(100); }} className={`flex-1 h-7 text-[10px] ${!isCanvasFit && canvasZoom === 100 ? 'bg-primary text-primary-foreground' : 'bg-black/40 text-[var(--muted-foreground)] border-[var(--border-default)] hover:bg-muted hover:text-[var(--foreground)]'}`}>{t.editor?.zoom_100 || '100%'}</Button>
          </div>
        </PopoverContent>
      </Popover>

      <div className="w-[1px] h-4 bg-[var(--border-default)] mx-1" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="w-8 h-8 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-muted data-[state=open]:bg-muted transition-colors" title={`${t.editor?.tooltip_ratio || '画幅'}: ${projectRatio}`}>
            <MonitorPlay size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-32 z-50 bg-[var(--bg-tertiary)] border-[var(--border-default)]">
          {['16:9','9:16','4:3','1:1'].map(opt => (
            <DropdownMenuItem key={opt} onClick={() => setProjectRatio(opt as any)} className={`flex items-center justify-between cursor-pointer focus:bg-muted ${projectRatio === opt ? 'text-primary font-medium' : 'text-[var(--foreground)]/80'}`}>
              <span className="text-[11px]">{opt}</span>
              {projectRatio === opt && <Check size={12} className="text-primary" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="w-[1px] h-4 bg-[var(--border-default)] mx-1" />

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" onClick={handleMuteToggle} className="w-8 h-8 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-muted transition-colors">
            {isMuted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-[140px] p-3 z-50 flex flex-col gap-2 bg-[var(--bg-tertiary)] border-[var(--border-default)]">
          <div className="flex justify-between items-center">
            <span className="text-[var(--foreground)] text-[11px] font-medium">音量</span>
            <span className="font-mono text-[10px] text-[var(--muted-foreground)]">{isMuted ? '0' : volume}%</span>
          </div>
          <Slider value={[isMuted ? 0 : volume]} min={0} max={100} step={1} onValueChange={handleVolumeChange} className="w-full cursor-pointer" />
        </PopoverContent>
      </Popover>

      <div className="w-[1px] h-4 bg-[var(--border-default)] mx-1" />

      <Button variant="ghost" size="icon" onClick={handleFullscreen} className="w-8 h-8 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-muted transition-colors" title={t.editor?.tooltip_fullscreen || '全屏'}>
        <Maximize size={14} />
      </Button>
    </div>
  );
};
