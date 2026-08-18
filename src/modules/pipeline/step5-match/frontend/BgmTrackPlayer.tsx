// Module: pipeline/step5-match - BgmTrackPlayer
// BGM 曲目卡内的自定义试听播放器 + 应用按钮
// 替代原生 <audio controls>：自绘播放/暂停、可点击 seek 进度条、mm:ss 时长，贴合全局设计语言

import React, { useRef, useState, useCallback, useEffect } from "react";
import { Play, Pause, Download, Loader2 } from "lucide-react";
import { getSafeMediaUrl } from "@renderer/utils/formatUrl";
import type { BgmTrack } from "../../stores/useStep5Store";

/** 秒 → mm:ss（不足 60 分钟场景够用） */
const formatTime = (sec: number): string => {
  if (!sec || sec <= 0 || !Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

interface BgmTrackPlayerProps {
  track: BgmTrack;
  isProcessing: boolean;
  applying: boolean;
  onApply: (t: BgmTrack) => void;
}

export const BgmTrackPlayer: React.FC<BgmTrackPlayerProps> = ({
  track, isProcessing, applying, onApply,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  const src = track.previewUrl ? getSafeMediaUrl(track.previewUrl) : "";

  // 切曲目时复位播放态
  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [src]);

  // 卸载时停止，避免残留声音
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a || !src) return;
    if (playing) {
      a.pause();
    } else {
      a.play().catch(() => {});
    }
  }, [playing, src]);

  const handleTimeUpdate = useCallback(() => {
    const a = audioRef.current;
    if (a) setCurrent(a.currentTime);
  }, []);

  const handleLoaded = useCallback(() => {
    const a = audioRef.current;
    if (a && Number.isFinite(a.duration)) setDuration(a.duration);
  }, []);

  const handleEnded = useCallback(() => {
    setPlaying(false);
    setCurrent(0);
    const a = audioRef.current;
    if (a) a.currentTime = 0;
  }, []);

  /** 点击进度条 seek（含轨道与 thumb 的点击） */
  const seek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    const bar = barRef.current;
    if (!a || !bar || !src) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = ratio * (a.duration || 0);
    if (Number.isFinite(target) && target >= 0) {
      a.currentTime = target;
      setCurrent(target);
    }
  }, [src]);

  const progressPct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const hasApply = !!(track.downloadUrl || track.libraryId);

  return (
    <div className="flex flex-col gap-1.5 mt-1.5">
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoaded}
          onEnded={handleEnded}
        />
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={!src}
          className="w-7 h-7 rounded-full bg-accent text-accent-foreground flex items-center justify-center shrink-0 hover:bg-accent/90 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          aria-label={playing ? '暂停试听' : '试听'}
        >
          {playing ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
        </button>
        <div
          ref={barRef}
          onClick={seek}
          className="relative flex-1 h-4 flex items-center cursor-pointer group"
        >
          <div className="relative w-full h-1 rounded-full bg-border/70 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-accent rounded-full"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div
            className="absolute top-1/2 w-2.5 h-2.5 rounded-full bg-accent shadow-sm ring-2 ring-accent/20 pointer-events-none transition-opacity"
            style={{ left: `${progressPct}%`, transform: 'translate(-50%, -50%)', opacity: playing ? 1 : 0 }}
          />
        </div>
        <span className="text-[10px] text-muted-foreground font-mono tabular-nums shrink-0 min-w-[52px] text-right">
          {formatTime(current)}/{formatTime(duration)}
        </span>
      </div>
      {hasApply && (
        <button
          type="button"
          disabled={isProcessing || applying}
          onClick={() => onApply(track)}
          className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent hover:text-accent-foreground rounded-md transition-all cursor-pointer disabled:opacity-50"
        >
          {applying ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          {applying ? '下载中' : '应用'}
        </button>
      )}
    </div>
  );
};
