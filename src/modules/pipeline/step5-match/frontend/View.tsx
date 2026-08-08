// Module: pipeline/step5-match - View
// 纯 Props 组件：镜头匹配卡片列表 + 拖拽排序 + 替换弹窗 + 成品预览弹窗（视频+配音+台词）

import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Check, RefreshCw, Film, X, Play, Pause, Volume2, VolumeX } from "lucide-react";
import { getSafeMediaUrl } from "@renderer/utils/formatUrl";
import { Badge, StatHeader, EmptyState } from "@renderer/components/shared";
import { DragReorderList } from "@renderer/components/shared/drag-reorder-list";
import type { StepShotMatchingProps } from "../types";

/** 时长毫秒 → 整数秒文案（去掉小数点，如 3500ms → "4s"） */
const formatIntSeconds = (ms?: number | null): string => {
  if (!ms || ms <= 0) return "";
  return `${Math.round(ms / 1000)}s`;
};

export const StepShotMatchingView: React.FC<StepShotMatchingProps> = ({
  matchResults, videoChunks, mediaItems, ttsResults, hasBgm, isProcessing,
  onConfirm, onReplace, onRematch, onReorder,
}) => {
  const [replacingShotId, setReplacingShotId] = useState<string | null>(null);
  /** 预览弹窗状态：当前预览的 shotId + 播放/暂停 */
  const [previewShotId, setPreviewShotId] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const chunkPool = useMemo(() => {
    return videoChunks.length > 0 ? videoChunks : mediaItems.filter((m) => m.type === "video_chunk" || m.type === "frame");
  }, [videoChunks, mediaItems]);

  const handleReplaceSelect = (shotId: string, chunk: any) => {
    onReplace(shotId, chunk);
    setReplacingShotId(null);
  };

  /** 当前预览的匹配项、切片、配音音频 */
  const previewMatch = useMemo(
    () => matchResults.find((m) => m.shotId === previewShotId) || null,
    [matchResults, previewShotId],
  );
  const previewChunk = (previewMatch?.chunkData as any) || null;
  /** daemon 切片不生成独立文件：chunk.filePath 即原视频物理路径 → magic:// 播放 */
  const previewVideoUrl = previewChunk?.filePath ? getSafeMediaUrl(previewChunk.filePath) : "";
  /** 🎬 用切片在原片中的时间段定位画面（seek 到 startMs 播放，播到 endMs 停止），避免所有预览都停在开头画面 */
  const previewStartMs = previewChunk?.startMs ?? previewMatch?.videoTimelineStartMs ?? 0;
  const previewEndMs = previewChunk?.endMs ?? previewMatch?.videoTimelineEndMs ?? 0;
  /** 原声段落不走 TTS：音频来自切片视频自带原声轨，不额外找配音 */
  const isOriginalAudio = previewMatch?.keepOriginalAudio === true;
  const previewTts = isOriginalAudio ? undefined : ttsResults.find((t) => t.shotId === previewShotId);
  const previewAudioUrl = previewTts?.audioUrl || "";

  /** 同步播放/暂停：视频从切片起点播放（已超出片段时间窗则回到起点），配音音频从头播放 */
  const togglePreviewPlay = useCallback(() => {
    if (previewPlaying) {
      previewVideoRef.current?.pause();
      previewAudioRef.current?.pause();
      setPreviewPlaying(false);
    } else {
      if (previewVideoRef.current && previewVideoUrl) {
        const v = previewVideoRef.current;
        const startSec = previewStartMs / 1000;
        const endSec = previewEndMs / 1000;
        /** 当前时间不在切片时间窗内（开头/播完），先 seek 到切片起点 */
        if (v.currentTime < startSec - 0.3 || (endSec > 0 && v.currentTime >= endSec)) {
          v.currentTime = startSec;
        }
        v.play().catch(() => {});
      }
      if (previewAudioRef.current && previewAudioUrl) {
        previewAudioRef.current.play().catch(() => {});
      }
      setPreviewPlaying(true);
    }
  }, [previewPlaying, previewVideoUrl, previewAudioUrl, previewStartMs, previewEndMs]);

  /** 媒体播放自然结束/超时 → 停止并复位到切片起点 */
  const handlePreviewEnded = useCallback(() => {
    const v = previewVideoRef.current;
    const a = previewAudioRef.current;
    v?.pause();
    a?.pause();
    if (v && previewStartMs > 0) v.currentTime = previewStartMs / 1000;
    if (a) a.currentTime = 0;
    setPreviewPlaying(false);
  }, [previewStartMs]);

  /** 打开预览时重置播放状态 */
  const openPreview = (shotId: string) => {
    setPreviewPlaying(false);
    setPreviewShotId(shotId);
  };

  /** 关闭预览：停掉音视频，避免残留播放 */
  const closePreview = () => {
    previewVideoRef.current?.pause();
    previewAudioRef.current?.pause();
    setPreviewPlaying(false);
    setPreviewShotId(null);
  };

  /** 切换预览目标时重置播放状态（不同 shotId 时） */
  useEffect(() => {
    setPreviewPlaying(false);
  }, [previewShotId]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[14px] font-semibold flex items-center gap-1.5">
          <span>镜头匹配</span>
          {hasBgm && <Badge variant="success" className="flex items-center gap-0.5">BGM</Badge>}
        </div>
        <div className="flex items-center gap-3">
          {matchResults.length > 0 && (
            <StatHeader value={matchResults.length} unit="个镜头" secondary={`已确认 ${matchResults.filter((m) => m.confirmed).length}/${matchResults.length}`} />
          )}
          <button onClick={onRematch} disabled={isProcessing}
            className="flex items-center gap-1.5 px-3 py-1 bg-accent text-accent-foreground rounded-md text-[13px] font-medium transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer">
            <RefreshCw size={12} className={isProcessing ? "animate-spin" : ""} />
            {isProcessing ? "匹配中..." : "重新匹配"}
          </button>
        </div>
      </div>
      {matchResults.length > 0 ? (
        <>
          <DragReorderList items={matchResults} getItemId={(m) => m.shotId} onReorder={onReorder}
            renderItem={(m, _index, isDragging) => (
              <div className={`glass-card-sm p-3 flex flex-col gap-2 transition-all border-l-4 ${isDragging ? "opacity-50" : ""} ${m.confirmed ? "border-l-accent-green" : m.score >= 0.85 ? "border-l-accent-green" : m.score >= 0.6 ? "border-l-warning" : "border-l-accent-rose"}`}>
                <div className="flex gap-3">
                  <div className="w-[140px] h-[90px] rounded-md bg-bg-secondary overflow-hidden shrink-0 relative">
                    {m.thumbnail ? <img src={getSafeMediaUrl(m.thumbnail)} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center"><Film size={24} className="text-muted-foreground/20" /></div>}
                    {m.chunkData && <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-[11px] text-white font-mono">{formatIntSeconds((m.chunkData as any).endMs - (m.chunkData as any).startMs)}</div>}
                    {m.appliedSpeedFactor !== 1 && m.appliedSpeedFactor !== undefined && <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-accent-rose/80 text-[11px] text-white">{m.appliedSpeedFactor.toFixed(2)}x</div>}
                  </div>
                  <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                    {/* 台词（替代技术化 shotId），无台词时回退显示 shotId；原声段落加"原声"标记 */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium truncate flex items-center gap-1.5" title={m.text || m.shotId}>
                        {m.text || m.shotId}
                        {m.keepOriginalAudio && <Badge variant="warning" className="text-[11px] shrink-0">原声</Badge>}
                      </span>
                      <Badge variant={m.score > 0.8 ? "success" : m.score > 0.5 ? "warning" : "danger"} className="text-[11px] shrink-0">{Math.round(m.score * 100)}%</Badge>
                    </div>
                    <div className="text-[12px] text-muted-foreground flex items-center gap-2">
                      {m.keepOriginalAudio ? (
                        <span className="bg-accent-rose/15 text-accent-rose px-1.5 py-0.5 rounded">原声轨</span>
                      ) : m.audioDurationMs && m.audioDurationMs > 0 ? (
                        <span className="bg-bg-secondary/40 px-1.5 py-0.5 rounded">配音 {formatIntSeconds(m.audioDurationMs)}</span>
                      ) : null}
                      {m.chunkData && <span className="bg-bg-secondary/40 px-1.5 py-0.5 rounded">片段 {formatIntSeconds((m.chunkData as any).endMs - (m.chunkData as any).startMs)}</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-auto">
                      {/* 预览成品：视频 + 配音 + 台词 */}
                      <button onClick={() => openPreview(m.shotId)} className="px-2.5 py-1 text-[12px] bg-accent/15 text-accent hover:bg-accent hover:text-accent-foreground rounded transition-all cursor-pointer flex items-center gap-1"><Play size={10} /> 预览</button>
                      {m.confirmed ? (
                        <span className="text-[12px] text-accent-green flex items-center gap-0.5"><Check size={12} /> 已确认</span>
                      ) : (
                        <>
                          <button onClick={() => onConfirm(m.shotId)} className="px-2.5 py-1 text-[12px] bg-accent-green/20 text-accent-green hover:bg-accent-green hover:text-white rounded transition-all cursor-pointer">确认</button>
                          <button onClick={() => setReplacingShotId(m.shotId)} className="px-2.5 py-1 text-[12px] bg-bg-secondary text-muted-foreground hover:text-foreground rounded transition-all cursor-pointer">替换</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          />
          <div className="text-[12px] text-muted-foreground text-center">拖拽卡片可调整顺序，点击预览可同步播放画面与配音</div>
        </>
      ) : (
        <EmptyState title="智能匹配待生成" description="算法将自动结合 BGM 节奏、台词时长、通过全局搜索匹配算法获取动态视频片段" iconType="media" size="md" className="glass-card-sm" />
      )}
      {/* 替换弹窗 */}
      {replacingShotId && (
        <div className="fixed inset-0 z-[500] bg-overlay-mask flex items-center justify-center" onClick={() => setReplacingShotId(null)}>
          <div className="bg-bg-base border border-border rounded-xl shadow-lg w-[500px] max-h-[550px] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary/30">
              <span className="text-[14px] font-semibold">选择视频片段</span>
              <button onClick={() => setReplacingShotId(null)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-3">
              {chunkPool.length > 0 ? chunkPool.map((chunk: any) => (
                <div key={chunk.id} onClick={() => handleReplaceSelect(replacingShotId, chunk)} className="cursor-pointer border border-border hover:border-accent rounded-lg overflow-hidden transition-all bg-bg-secondary p-1.5 flex flex-col gap-1">
                  <div className="w-full aspect-video rounded bg-black overflow-hidden relative">
                    <img src={getSafeMediaUrl(chunk.coverPath || chunk.thumbnail)} className="w-full h-full object-cover" />
                    {chunk.endMs && chunk.startMs !== undefined && <span className="absolute bottom-1 right-1 bg-black/80 px-1 text-[11px] text-white font-mono rounded">{formatIntSeconds(chunk.endMs - chunk.startMs)}</span>}
                  </div>
                  <div className="text-[12px] font-medium truncate px-1 text-center">{chunk.name || "片段"}</div>
                </div>
              )) : <div className="col-span-2"><EmptyState title="暂无片段素材" description="请先执行管线生成视频片段" iconType="search" size="md" /></div>}
            </div>
          </div>
        </div>
      )}
      {/* 预览弹窗：视频片段 + 配音音频 + 台词，评估匹配度 */}
      {previewMatch && (
        <div className="fixed inset-0 z-[500] bg-overlay-mask flex items-center justify-center" onClick={closePreview}>
          <div className="bg-bg-base border border-border rounded-xl shadow-lg w-[640px] max-h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary/30">
              <span className="text-[14px] font-semibold flex items-center gap-2">
                成品预览
                <Badge variant={previewMatch.score > 0.8 ? "success" : previewMatch.score > 0.5 ? "warning" : "danger"} className="text-[12px]">
                  匹配度 {Math.round(previewMatch.score * 100)}%
                </Badge>
              </span>
              <button onClick={closePreview} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {/* 视频画面：切片视频文件；无切片文件时回退封面图 */}
              <div className="w-full aspect-video rounded-lg bg-black overflow-hidden relative shrink-0">
                {previewVideoUrl ? (
                  // key=shotId：切换预览目标时强制重建元素，重新触发 onLoadedMetadata 定位到新起点
                  <video
                    key={previewMatch.shotId}
                    ref={previewVideoRef}
                    src={previewVideoUrl}
                    className="w-full h-full object-contain"
                    onEnded={handlePreviewEnded}
                    onLoadedMetadata={(e) => {
                      /** 加载后定位到切片起点，避免停留在视频开头画面 */
                      if (previewStartMs > 0) e.currentTarget.currentTime = previewStartMs / 1000;
                    }}
                    onTimeUpdate={(e) => {
                      /** 播放超过片段时间窗 → 停止并复位 */
                      if (previewEndMs > 0 && e.currentTarget.currentTime * 1000 >= previewEndMs) {
                        handlePreviewEnded();
                      }
                    }}
                  />
                ) : previewMatch.thumbnail ? (
                  <img src={getSafeMediaUrl(previewMatch.thumbnail)} className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center"><Film size={40} className="text-muted-foreground/30" /></div>
                )}
                {/* 播放控制条 */}
                <div className="absolute bottom-0 inset-x-0 px-3 py-2 bg-gradient-to-t from-black/80 to-transparent flex items-center gap-3">
                  <button onClick={togglePreviewPlay} className="w-9 h-9 rounded-full bg-accent text-accent-foreground flex items-center justify-center hover:opacity-90 transition-all cursor-pointer shrink-0">
                    {previewPlaying ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <div className="flex items-center gap-1.5 text-[12px] text-white/90">
                    {isOriginalAudio ? <Volume2 size={13} /> : previewAudioUrl ? <Volume2 size={13} /> : <VolumeX size={13} />}
                    <span>{isOriginalAudio ? "原声播放（切片自带音轨）" : previewAudioUrl ? "配音同步播放" : "无配音音频"}</span>
                  </div>
                  <span className="ml-auto text-[12px] text-white/70">
                    {previewChunk?.endMs ? `片段 ${formatIntSeconds(previewChunk.endMs - previewChunk.startMs)}` : ""}
                  </span>
                </div>
              </div>
              {/* 隐藏配音音频：与视频同步播放 */}
              {previewAudioUrl && (
                <audio ref={previewAudioRef} src={previewAudioUrl} preload="auto" onEnded={handlePreviewEnded} />
              )}
              {/* 台词 */}
              <div className="rounded-lg bg-bg-secondary/50 border border-border p-3">
                <div className="text-[12px] text-muted-foreground mb-1.5 flex items-center justify-between">
                  <span>{isOriginalAudio ? "原声台词（保留原片原声）" : "解说台词"}</span>
                  {previewMatch.appliedSpeedFactor && previewMatch.appliedSpeedFactor !== 1 && !isOriginalAudio && (
                    <span className="text-accent-rose">变速 {previewMatch.appliedSpeedFactor.toFixed(2)}x</span>
                  )}
                </div>
                <p className="text-[13px] leading-relaxed text-foreground whitespace-pre-wrap">{previewMatch.text || "（无台词内容）"}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
