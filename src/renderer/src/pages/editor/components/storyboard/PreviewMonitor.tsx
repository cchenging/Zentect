/**
 * @deprecated 已迁移至 src/modules/editor/preview/frontend/View.tsx
 * 请使用 import { PreviewMonitor } from '@/modules/editor/preview'
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import {
  Play, Pause, Volume2, VolumeX, ZoomIn, Maximize,
  MonitorPlay, Check,
} from 'lucide-react';
import { Slider } from '../../../../components/ui/slider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../../../components/ui/popover';

/** PreviewMonitor 组件 Props */
interface PreviewMonitorProps {
  /** 视频/图片路径 — 支持视频和图片两种模式 */
  mediaPath?: string | null;
  /** 视频切片起始时间（毫秒），用于动态视频切片预览 */
  startTimeMs?: number;
  /** 视频切片结束时间（毫秒），用于动态视频切片预览 */
  endTimeMs?: number;
  onTimeUpdate?: (t: number) => void;
  onImportClick?: () => void;
}

/** 判断路径是否为图片文件 */
function isImagePath(path: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp|svg)(\?|$)/i.test(path);
}

/** 视频预览监视器组件 — 播放/暂停/进度拖拽/缩放/画幅/音量/全屏 + 图片预览 */
export default function PreviewMonitor({ mediaPath, startTimeMs, endTimeMs, onTimeUpdate, onImportClick }: PreviewMonitorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [videoZoom, setVideoZoom] = useState(100);
  const [isZoomFit, setIsZoomFit] = useState(true);
  const [projectRatio, setProjectRatio] = useState('16:9');

  const safeSrc = getSafeMediaUrl(mediaPath);
  /** 根据路径判断是否为图片模式 */
  const isImageMode = safeSrc ? isImagePath(safeSrc) : false;

  /** 视频元数据加载完成 */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !safeSrc) return;

    const handleLoadedMeta = () => setDuration(video.duration);
    const handleLoadStart = () => setIsLoading(true);
    const handleCanPlay = () => setIsLoading(false);

    video.addEventListener('loadedmetadata', handleLoadedMeta);
    video.addEventListener('loadstart', handleLoadStart);
    video.addEventListener('canplay', handleCanPlay);

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMeta);
      video.removeEventListener('loadstart', handleLoadStart);
      video.removeEventListener('canplay', handleCanPlay);
    };
  }, [safeSrc]);

  /** 视频路径变化时重新加载 */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !safeSrc) return;
    video.load();
    setIsPlaying(false);
    setCurrentTime(0);
  }, [safeSrc]);

  /** 时间更新回调 */
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    onTimeUpdate?.(video.currentTime);
  }, [onTimeUpdate]);

  /** 播放结束 */
  const handleEnded = useCallback(() => {
    setIsPlaying(false);
  }, []);

  /** 切换播放/暂停 */
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, []);

  /** 进度拖拽（Slider 回调） */
  const handleSeek = useCallback((value: number[]) => {
    const video = videoRef.current;
    if (!video || !value.length) return;
    const time = value[0];
    video.currentTime = time;
    setCurrentTime(time);
  }, []);

  /** 静音切换 */
  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }, []);

  /** 全屏切换 */
  const handleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  /** 格式化时间 m:ss */
  const fmt = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  /** 空状态：无素材 */
  if (!mediaPath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-[var(--bg-deepest)] rounded-lg border border-dashed border-[var(--border-default)] min-h-[300px] gap-4">
        <div className="text-4xl opacity-30">🎬</div>
        <p className="text-[var(--text-secondary)] text-sm">导入视频素材开始创作</p>
        {onImportClick && (
          <button
            onClick={onImportClick}
            className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm hover:opacity-90 transition-opacity"
          >
            导入视频
          </button>
        )}
      </div>
    );
  }

  const ratioOptions = [
    { v: '16:9', l: '16:9' },
    { v: '9:16', l: '9:16' },
    { v: '4:3', l: '4:3' },
    { v: '1:1', l: '1:1' },
  ];

  /** 将比例字符串转为 CSS aspect-ratio 值 */
  const ratioValue = projectRatio.replace(':', '/');

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-deepest)] rounded-lg overflow-hidden border border-[var(--border-default)]">
      {/* 视频画面区域 — 以项目画幅比为容器约束，视频 object-contain 居中 */}
      <div ref={containerRef} className="relative flex-1 flex items-center justify-center bg-black">
        {/* 画幅容器：按项目比例约束尺寸，竖版视频不会撑满 */}
        <div
          className="relative w-full flex items-center justify-center overflow-hidden"
          style={{ aspectRatio: ratioValue, maxHeight: '100%', maxWidth: '100%' }}
        >
          {isImageMode ? (
            /** 图片模式：直接展示帧图片，支持缩放 */
            <img
              src={safeSrc}
              alt="帧预览"
              className="w-full h-full object-contain"
              style={{ transform: isZoomFit ? 'none' : `scale(${videoZoom / 100})` }}
            />
          ) : (
            /** 视频模式：标准视频播放器 */
            <video
              ref={videoRef}
              src={safeSrc}
              className="w-full h-full object-contain"
              style={{ transform: isZoomFit ? 'none' : `scale(${videoZoom / 100})` }}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleEnded}
              onClick={togglePlay}
            />
          )}
        </div>

        {/* 加载指示器 */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* 中央播放/暂停按钮覆盖层 — 图片模式下隐藏 */}
        {!isImageMode && (
          <button
            onClick={togglePlay}
            className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
          >
            <div className="w-14 h-14 rounded-full bg-black/60 flex items-center justify-center">
              {isPlaying ? (
                <Pause className="w-6 h-6 text-white" />
              ) : (
                <Play className="w-6 h-6 text-white ml-0.5" />
              )}
            </div>
          </button>
        )}

        {/* 底部控制条 — 34px，绝对定位覆盖层 */}
        <div className="absolute bottom-0 left-0 right-0 h-[34px] bg-[#1a1a2e] flex items-center gap-2 px-3 z-10">
          {/* 播放/暂停按钮 — 图片模式下隐藏 */}
          {!isImageMode && (
            <button
              onClick={togglePlay}
              className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white/70 hover:text-white transition-colors flex-shrink-0"
            >
              {isPlaying ? <Pause size={11} /> : <Play size={11} />}
            </button>
          )}

          {/* 进度条 — 图片模式下隐藏 */}
          {!isImageMode && (
            <div className="flex-1 flex items-center">
              <Slider
                value={[currentTime]}
                max={duration > 0 ? duration : 100}
                step={0.1}
                onValueChange={handleSeek}
                className="w-full [&>span:first-child]:h-[2px] [&>span:first-child]:bg-white/15 [&>span>span]:bg-[var(--accent)] [&>span+span]:w-3 [&>span+span]:h-3 [&>span+span]:rounded-full [&>span+span]:bg-[var(--accent)] [&>span+span]:border-0"
              />
            </div>
          )}

          {/* 图片模式标识 */}
          {isImageMode && (
            <span className="text-[11px] text-white/60 font-medium">帧预览</span>
          )}

          {/* 时间 — 图片模式下隐藏 */}
          {!isImageMode && (
            <span className="text-[11px] text-white/60 font-mono tabular-nums whitespace-nowrap flex-shrink-0">
              {fmt(currentTime)} / {fmt(duration)}
            </span>
          )}

          {/* 缩放 */}
          <Popover>
            <PopoverTrigger asChild>
              <button className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0">
                <ZoomIn size={11} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-[180px] p-3 bg-[#1a1a1a] border-white/10">
              <div className="flex justify-between items-center mb-2">
                <span className="text-white/80 text-[11px]">画布缩放</span>
                <span className="text-[10px] text-white/40 font-mono">{isZoomFit ? '自适应' : `${videoZoom}%`}</span>
              </div>
              <Slider
                value={[isZoomFit ? 100 : videoZoom]}
                min={25} max={400} step={1}
                onValueChange={(v) => { setIsZoomFit(false); setVideoZoom(v[0]); }}
                className="w-full"
              />
              <div className="flex gap-1.5 mt-2">
                <button
                  onClick={() => { setIsZoomFit(true); setVideoZoom(100); }}
                  className={`flex-1 h-6 text-[10px] rounded ${
                    isZoomFit ? 'bg-[var(--accent)] text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'
                  }`}
                >
                  自适应
                </button>
                <button
                  onClick={() => { setIsZoomFit(false); setVideoZoom(100); }}
                  className={`flex-1 h-6 text-[10px] rounded ${
                    !isZoomFit && videoZoom === 100 ? 'bg-[var(--accent)] text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'
                  }`}
                >
                  100%
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {/* 画幅比例 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0">
                <MonitorPlay size={11} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8} className="w-28 bg-[#1a1a1a] border-white/10">
              {ratioOptions.map((opt) => (
                <DropdownMenuItem
                  key={opt.v}
                  onClick={() => setProjectRatio(opt.v)}
                  className={`flex items-center justify-between cursor-pointer text-[11px] ${
                    projectRatio === opt.v ? 'text-[var(--accent)]' : 'text-white/70'
                  }`}
                >
                  <span>{opt.l}</span>
                  {projectRatio === opt.v && <Check size={10} />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 音量 */}
          <button
            onClick={toggleMute}
            className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
          >
            {isMuted ? <VolumeX size={11} /> : <Volume2 size={11} />}
          </button>

          {/* 全屏 */}
          <button
            onClick={handleFullscreen}
            className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
          >
            <Maximize size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
