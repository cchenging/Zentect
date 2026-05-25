import React, { useRef, useState, useCallback } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Edit3, ArrowRight } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Slider } from '../../../components/ui/slider';
import { useI18n } from '../../../store/useI18n';
import { getSafeMediaUrl } from '../../../utils/formatUrl';

interface StepReviewProps {
  projectId: string;
  mediaPath: string;
  onComplete: () => void;
  onOpenRightPanel?: () => void;
}

export const StepReview: React.FC<StepReviewProps> = ({ projectId: _projectId, mediaPath, onComplete, onOpenRightPanel }) => {
  const { t } = useI18n();
  const qc = t.quickcard?.review || {};
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);

  /** 播放时更新当前时间 */
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;
    setCurrentTime(videoRef.current.currentTime);
  }, []);

  const handleLoaded = () => {
    if (videoRef.current) setDuration(videoRef.current.duration);
  };

  const videoSrc = mediaPath ? getSafeMediaUrl(mediaPath) : undefined;

  // --- 播放控制 ---
  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playing) { videoRef.current.pause(); setPlaying(false); }
    else { videoRef.current.play().then(() => setPlaying(true)).catch(() => {}); }
  };

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return '00:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Player */}
      <div className="flex-1 flex flex-col gap-3">
        <div className="flex-1 rounded-xl bg-[#050505] border border-border overflow-hidden relative flex items-center justify-center">
          {videoSrc ? (
            <>
              <video
                ref={videoRef}
                className="w-full h-full object-contain"
                src={videoSrc}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoaded}
                onEnded={() => setPlaying(false)}
                muted={muted}
              />
            </>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/40">
              <div className="text-center">
                <Play size={48} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">{qc.player_placeholder || '视频播放区域'}</p>
              </div>
            </div>
          )}
        </div>
        {/* Controls */}
        <div className="h-10 rounded-lg bg-card border border-border flex items-center gap-3 px-4">
          <Button variant="ghost" size="icon" onClick={togglePlay}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </Button>
          <span className="text-xs font-mono text-muted-foreground tabular-nums tracking-wider">
            {formatTime(currentTime)}
          </span>
          <div className="flex-1 mx-2">
            <Slider
              value={[duration > 0 ? (currentTime / duration) * 100 : 0]}
              onValueChange={([v]) => {
                if (videoRef.current && duration > 0) {
                  videoRef.current.currentTime = (v / 100) * duration;
                }
              }}
              max={100}
              step={0.1}
            />
          </div>
          <span className="text-xs font-mono text-muted-foreground tabular-nums">{formatTime(duration)}</span>
          <Button variant="ghost" size="icon" onClick={() => setMuted(!muted)}>
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => videoRef.current?.requestFullscreen()}>
            <Maximize size={16} />
          </Button>
        </div>
      </div>

      {/* 底部操作按钮 */}
      <div className="flex items-center gap-3 justify-end shrink-0">
        <Button
          variant="outline"
          onClick={onOpenRightPanel}
          className="gap-2"
        >
          <Edit3 size={16} /> 精修改稿
        </Button>
        <Button
          onClick={onComplete}
          className="gap-2"
        >
          <ArrowRight size={16} /> 下一步 → 发布素材
        </Button>
      </div>
    </div>
  );
};
