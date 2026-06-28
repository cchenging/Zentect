import React, { useState, useCallback } from "react";
import { ChevronLeft, ChevronRight, X, Maximize2, BookOpen } from "lucide-react";
import { getSafeMediaUrl } from "../../../../utils/formatUrl";
import { StatHeader, EmptyState } from "../../../../components/shared";
import type { VlmFrame } from "../../../../../../shared/types/entities/editor";

export interface StepVisionDescriptionProps {
  vlmFrames: VlmFrame[];
  onUpdateDescription: (index: number, description: string) => void;
  onSetEditing: (index: number, editing: boolean) => void;
  onGoToStep1?: () => void;
}

export const StepVisionDescriptionView: React.FC<StepVisionDescriptionProps> = ({
  vlmFrames, onUpdateDescription, onSetEditing, onGoToStep1,
}) => {
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);

  const openZoom = useCallback((index: number) => setZoomIndex(index), []);
  const closeZoom = useCallback(() => setZoomIndex(null), []);
  const prevFrame = useCallback(() => {
    setZoomIndex((prev) => (prev !== null && prev > 0 ? prev - 1 : prev));
  }, []);
  const nextFrame = useCallback(() => {
    setZoomIndex((prev) => (prev !== null && prev < vlmFrames.length - 1 ? prev + 1 : prev));
  }, [vlmFrames.length]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") closeZoom();
    if (e.key === "ArrowLeft") prevFrame();
    if (e.key === "ArrowRight") nextFrame();
  }, [closeZoom, prevFrame, nextFrame]);

  const storyLineText = vlmFrames
    .filter((f) => f.description && f.description.trim())
    .map((f) => f.description.trim())
    .join("\n\n");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold">VLM 画面描述</div>
        {vlmFrames.length > 0 && (
          <StatHeader value={vlmFrames.length} unit="帧已分析" secondary={`已确认 ${vlmFrames.filter((f) => f.confirmed).length} 帧`} />
        )}
      </div>
      {vlmFrames.length > 0 ? (
        <div className="flex flex-col gap-3">
          {vlmFrames.map((frame, idx) => (
            <div key={idx} className="glass-card-sm p-3 flex gap-3">
              <div className="w-[100px] h-[68px] rounded-md bg-bg-secondary overflow-hidden shrink-0 cursor-pointer relative group/img hover:ring-1 hover:ring-accent/40 transition-all"
                onClick={() => openZoom(idx)} title="点击放大查看">
                {frame.url ? (
                  <img src={getSafeMediaUrl(frame.url)} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] text-muted-foreground">帧 {idx + 1}</div>
                )}
                <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
                  <Maximize2 size={16} className="text-white" />
                </div>
              </div>
              <div className="flex-1 flex flex-col gap-1">
                {frame.editing ? (
                  <textarea value={frame.description}
                    onChange={(e) => onUpdateDescription(idx, e.target.value)}
                    onBlur={() => onSetEditing(idx, false)}
                    className="flex-1 text-[12px] bg-bg-secondary px-2 py-1.5 rounded border border-accent/30 outline-none resize-none min-h-[40px]" autoFocus />
                ) : (
                  <div className="text-[12px] text-foreground leading-relaxed cursor-pointer hover:text-accent transition-colors"
                    onClick={() => onSetEditing(idx, true)}>
                    {frame.description || "点击添加描述"}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground">帧 {idx + 1}</div>
              </div>
            </div>
          ))}
          {storyLineText && (
            <div className="p-3 rounded-lg bg-gradient-to-br from-accent-purple/10 via-accent/5 to-transparent border border-accent-purple/20">
              <div className="text-[12px] font-semibold mb-2 flex items-center gap-2 text-accent-purple">
                <BookOpen size={14} /> 故事脉络
              </div>
              <div className="text-[12px] text-foreground leading-relaxed whitespace-pre-wrap">{storyLineText}</div>
            </div>
          )}
        </div>
      ) : (
        <EmptyState title="VLM 画面描述待生成" description="执行素材分析后，VLM 画面描述将在此展示，支持逐帧编辑和修正" iconType="media" size="md" className="glass-card-sm"
          action={onGoToStep1 ? <button onClick={onGoToStep1} className="text-[11px] px-3 py-1 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors cursor-pointer outline-none">前往素材分析</button> : undefined} />
      )}
      {zoomIndex !== null && vlmFrames[zoomIndex] && (
        <div className="fixed inset-0 z-[500] bg-black/85 flex items-center justify-center" onClick={closeZoom} onKeyDown={handleKeyDown} tabIndex={-1}>
          <button onClick={closeZoom} className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors cursor-pointer z-10"><X size={28} /></button>
          <div className="text-white/60 text-[13px] absolute top-4 left-4 z-10">{zoomIndex + 1} / {vlmFrames.length}</div>
          {vlmFrames[zoomIndex].description && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-[600px] text-white/80 text-[13px] text-center bg-black/50 px-4 py-2 rounded z-10">{vlmFrames[zoomIndex].description}</div>
          )}
          {zoomIndex > 0 && <button onClick={(e) => { e.stopPropagation(); prevFrame(); }} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white cursor-pointer z-10"><ChevronLeft size={36} /></button>}
          <img src={getSafeMediaUrl(vlmFrames[zoomIndex].url)} className="max-w-[90vw] max-h-[80vh] object-contain rounded" onClick={(e) => e.stopPropagation()} alt={`帧 ${zoomIndex + 1}`} />
          {zoomIndex < vlmFrames.length - 1 && <button onClick={(e) => { e.stopPropagation(); nextFrame(); }} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white cursor-pointer z-10"><ChevronRight size={36} /></button>}
        </div>
      )}
    </div>
  );
};