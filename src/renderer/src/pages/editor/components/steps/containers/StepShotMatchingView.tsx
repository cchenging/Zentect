import React, { useState, useMemo } from "react";
import { Check, RefreshCw, Film, X } from "lucide-react";
import { getSafeMediaUrl } from "../../../../../utils/formatUrl";
import { Badge, StatHeader, EmptyState } from "../../../../../components/shared";
import { DragReorderList } from "../../../../../components/shared/DragReorderList";
import type { MatchResult, MediaItem, VideoChunk } from "../../../../../../../shared/types/entities/editor";

export interface StepShotMatchingProps {
  matchResults: MatchResult[];
  videoChunks: VideoChunk[];
  mediaItems: MediaItem[];
  hasBgm: boolean;
  isProcessing: boolean;
  onConfirm: (shotId: string) => void;
  onReplace: (shotId: string, chunkItem: any) => void;
  onRematch: () => void;
  onReorder: (reordered: MatchResult[]) => void;
}

export const StepShotMatchingView: React.FC<StepShotMatchingProps> = ({
  matchResults, videoChunks, mediaItems, hasBgm, isProcessing,
  onConfirm, onReplace, onRematch, onReorder,
}) => {
  const [replacingShotId, setReplacingShotId] = useState<string | null>(null);

  const chunkPool = useMemo(() => {
    return videoChunks.length > 0 ? videoChunks : mediaItems.filter((m) => m.type === "video_chunk" || m.type === "frame");
  }, [videoChunks, mediaItems]);

  const handleReplaceSelect = (shotId: string, chunk: any) => {
    onReplace(shotId, chunk);
    setReplacingShotId(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold flex items-center gap-1.5">
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
                    {m.chunkData && <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-[9px] text-white font-mono">{((m.chunkData as any).endMs - (m.chunkData as any).startMs) / 1000}s</div>}
                    {m.appliedSpeedFactor !== 1 && m.appliedSpeedFactor !== undefined && <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-accent-rose/80 text-[9px] text-white">{m.appliedSpeedFactor.toFixed(2)}x</div>}
                  </div>
                  <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold truncate">{m.shotId}</span>
                      <Badge variant={m.score > 0.8 ? "success" : m.score > 0.5 ? "warning" : "danger"} className="text-[9px] shrink-0">{Math.round(m.score * 100)}%</Badge>
                    </div>
                    {m.audioDurationMs && m.audioDurationMs > 0 && <div className="text-[10px] text-muted-foreground bg-bg-secondary/40 px-1.5 py-0.5 rounded">{(m.audioDurationMs / 1000).toFixed(2)}s</div>}
                    <div className="flex items-center gap-2 mt-auto">
                      {m.confirmed ? (
                        <span className="text-[10px] text-accent-green flex items-center gap-0.5"><Check size={12} /> 已确认</span>
                      ) : (
                        <>
                          <button onClick={() => onConfirm(m.shotId)} className="px-2.5 py-1 text-[10px] bg-accent-green/20 text-accent-green hover:bg-accent-green hover:text-white rounded transition-all cursor-pointer">确认</button>
                          <button onClick={() => setReplacingShotId(m.shotId)} className="px-2.5 py-1 text-[10px] bg-bg-secondary text-muted-foreground hover:text-foreground rounded transition-all cursor-pointer">替换</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          />
          <div className="text-[10px] text-muted-foreground text-center">拖拽卡片可调整顺序</div>
        </>
      ) : (
        <EmptyState title="智能匹配待生成" description="算法将自动结合 BGM 节奏、台词时长、通过全局搜索匹配算法获取动态视频片段" iconType="media" size="md" className="glass-card-sm" />
      )}
      {replacingShotId && (
        <div className="fixed inset-0 z-[500] bg-overlay-mask flex items-center justify-center" onClick={() => setReplacingShotId(null)}>
          <div className="bg-bg-base border border-border rounded-xl shadow-lg w-[500px] max-h-[550px] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary/30">
              <span className="text-[13px] font-semibold">选择视频片段</span>
              <button onClick={() => setReplacingShotId(null)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-3">
              {chunkPool.length > 0 ? chunkPool.map((chunk: any) => (
                <div key={chunk.id} onClick={() => handleReplaceSelect(replacingShotId, chunk)} className="cursor-pointer border border-border hover:border-accent rounded-lg overflow-hidden transition-all bg-bg-secondary p-1.5 flex flex-col gap-1">
                  <div className="w-full aspect-video rounded bg-black overflow-hidden relative">
                    <img src={getSafeMediaUrl(chunk.coverPath || chunk.thumbnail)} className="w-full h-full object-cover" />
                    {chunk.endMs && chunk.startMs !== undefined && <span className="absolute bottom-1 right-1 bg-black/80 px-1 text-[9px] text-white font-mono rounded">{((chunk.endMs - chunk.startMs) / 1000).toFixed(1)}s</span>}
                  </div>
                  <div className="text-[10px] font-medium truncate px-1 text-center">{chunk.name || "片段"}</div>
                </div>
              )) : <div className="col-span-2"><EmptyState title="暂无片段素材" description="请先执行管线生成视频片段" iconType="search" size="md" /></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};