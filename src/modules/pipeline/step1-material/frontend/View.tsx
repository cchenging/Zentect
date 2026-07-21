// Module: pipeline/step1-material - View

import React, { useState } from "react";
import { Edit3, User, Music, Play, UndoDot, RotateCcw } from "lucide-react";
import { getSafeMediaUrl } from "../../../../renderer/src/utils/formatUrl";
import { Badge, StatusIcon, StatHeader, EmptyState, CollapsibleCard } from "../../../../renderer/src/components/shared";
import { FrameExtractConfig } from "./components/FrameExtractConfig";
import { useI18n } from "../../../../renderer/src/store/useI18n";
import type { AsrLine, Role, MediaItem } from "../../../../shared/types";
import type { StepStatus } from "../../../../shared/types/entities/editor";
import type { StepMaterialAnalysisViewProps } from "../types";

export const StepMaterialAnalysisView: React.FC<StepMaterialAnalysisViewProps> = (props) => {
  const { t } = useI18n();
  const {
    asrLines, frameCount, audioSeparated, mediaItems, roles,
    subStepStatuses, subStepProgresses, extractionConfig, extractedData,
    onUpdateAsrLine, onSetAsrLines, onSetCurrentTime, onSetActivePlaySource,
    onUpdateRole, onSetSubStepStatus, onRetrySubStep,
  } = props;

  const [expandedSubSteps, setExpandedSubSteps] = useState<Record<string, boolean>>({
    frames: true, audio: false, whisper: false, faces: false,
  });
  const toggleSubStep = (key: string) => setExpandedSubSteps((prev) => ({ ...prev, [key]: !prev[key] }));

  const parseTime = (timeStr: string): number => {
    if (!timeStr) return 0;
    const parts = timeStr.split(":");
    return parts.length >= 2 ? parseInt(parts[0], 10) * 60 + parseFloat(parts[1]) : parseFloat(timeStr) || 0;
  };

  const toggleEditing = (idx: number, editing: boolean) => {
    const lines = asrLines.map((l, i) => (i === idx ? { ...l, editing } : l));
    onSetAsrLines(lines);
  };

  const audioItems = mediaItems.filter((m) => m.type === "audio");
  const framesStatus = subStepStatuses["frames"] || "idle";
  const audioStatus = subStepStatuses["audio"] || "idle";
  const whisperStatus = subStepStatuses["whisper"] || "idle";
  const facesStatus = subStepStatuses["faces"] || "idle";
  const confirmed = asrLines.filter((l) => l.originalText !== undefined && l.text === l.originalText).length;

  const statusText = (status: string, runningKey: string, runningProgressKey: string, failedKey: string, idleKey: string) => {
    if (status === "completed") return "";
    if (status === "running") return t[runningKey]?.replace("{progress}", String(subStepProgresses[runningProgressKey] || 0)) || '';
    if (status === "failed") return t[failedKey];
    return t[idleKey];
  };

  return (
    <div className="flex flex-col gap-1">
      {/* 1. 关键帧提取 */}
      <CollapsibleCard expanded={expandedSubSteps.frames} onExpandedChange={(v) => toggleSubStep("frames")}
        title={<><StatusIcon status={framesStatus === "idle" ? "pending" : framesStatus} /><span className={`text-[13px] font-semibold ${framesStatus === "completed" ? "text-accent-green" : framesStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.frames.title"]}</span></>}
        extra={<>
          <span className="text-[13px] text-muted-foreground">{framesStatus === "completed" ? (t["editor.step1.frames.statusDone"]?.replace("{count}", String(frameCount)) || '') : statusText(framesStatus, "editor.step1.frames.statusRunning", "frames", "editor.step1.frames.statusFail", "editor.step1.frames.statusIdle")}</span>
          {framesStatus !== "running" && <button onClick={(e) => { e.stopPropagation(); onRetrySubStep("frames"); }} className="ml-auto text-muted-foreground hover:text-primary transition-colors cursor-pointer" title={t["editor.step1.frames.title"]}><RotateCcw size={13} /></button>}
        </>}
        borderColor={framesStatus === "failed" ? "var(--accent-rose)" : undefined}>
        <FrameExtractConfig isRunning={framesStatus === "running"} />
      </CollapsibleCard>

      {/* 2. 音频分离 */}
      <CollapsibleCard expanded={expandedSubSteps.audio} onExpandedChange={(v) => toggleSubStep("audio")}
        title={<><StatusIcon status={audioStatus === "idle" ? "pending" : audioStatus} /><span className={`text-[13px] font-semibold ${audioStatus === "completed" ? "text-accent-green" : audioStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.audio.title"]}</span></>}
        extra={<span className="text-[13px] text-muted-foreground">{audioStatus === "completed" ? t["editor.step1.audio.separated"] : statusText(audioStatus, "editor.step1.audio.statusRunning", "audio", "editor.step1.audio.statusFailed", "editor.step1.audio.statusIdle")}</span>}
        borderColor={audioStatus === "failed" ? "var(--accent-rose)" : undefined}>
        {audioStatus === "completed" && (
          <div className="p-2 rounded-md bg-bg-secondary border border-border/20">
            {audioItems.length > 0 ? (
              <div className="flex flex-col gap-1">
                {audioItems.map((item) => (
                  <div key={item.id} className="flex items-center justify-between py-1.5 px-2 text-[13px] hover:bg-bg-glass/50 rounded cursor-pointer transition-colors" onClick={() => onSetActivePlaySource(item)}>
                    <Music size={14} className="text-muted-foreground shrink-0" />
                    <span className="flex-1 mx-2 truncate">{item.fileName || item.name || t["editor.step1.audio.unnamed"]}</span>
                    {item.duration && <span className="text-[13px] text-muted-foreground shrink-0">{item.duration}s</span>}
                    <button className="text-accent hover:text-accent/80 cursor-pointer ml-2 shrink-0" title={t["editor.step1.audio.play"]}><Play size={13} /></button>
                  </div>
                ))}
              </div>
            ) : (<EmptyState title={t["editor.step1.audio.emptyTitle"]} description={t["editor.step1.audio.emptyDesc"]} iconType="audio" size="sm" />)}
          </div>
        )}
      </CollapsibleCard>

      {/* 3. ASR 台词识别 */}
      <CollapsibleCard expanded={expandedSubSteps.whisper} onExpandedChange={(v) => toggleSubStep("whisper")}
        title={<><StatusIcon status={whisperStatus === "idle" ? "pending" : whisperStatus} /><span className={`text-[13px] font-semibold ${whisperStatus === "completed" ? "text-accent-green" : whisperStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.asr.title"]}</span></>}
        extra={<>
          {whisperStatus === "completed" ? <StatHeader value={asrLines.length} unit={t["editor.step1.asr.sentenceCount"]?.replace("{count}", String(asrLines.length)) || ''} secondary={t["editor.step1.asr.confirmedCount"]?.replace("{count}", String(confirmed)) || ''} /> : <span className="text-[13px] text-muted-foreground">{statusText(whisperStatus, "editor.step1.asr.statusRunning", "whisper", "editor.step1.asr.statusFailed", "editor.step1.asr.statusIdle")}</span>}
        </>}
        borderColor={whisperStatus === "failed" ? "var(--accent-rose)" : undefined}>
        {whisperStatus === "completed" && asrLines.length > 0 && (
          <div className="rounded-md bg-bg-secondary border border-border/20 overflow-hidden">
            {asrLines.map((line, idx) => {
              const isModified = line.originalText !== undefined && line.text !== line.originalText;
              return (
                <div key={idx} className={`flex items-center gap-2 px-3 py-2 border-b border-border/10 last:border-0 group ${isModified ? "bg-accent/5 border-l-2 border-l-accent-rose" : ""}`}>
                  <span className="text-[13px] font-mono text-accent shrink-0 w-12">{line.start || "00:00"}</span>
                  {line.editing ? (
                    <input value={line.text} onChange={(e) => onUpdateAsrLine(idx, e.target.value)} onBlur={() => toggleEditing(idx, false)} onKeyDown={(e) => { if (e.key === "Enter") toggleEditing(idx, false); }} className="flex-1 text-[13px] bg-bg-secondary px-2 py-1 rounded border border-accent/30 outline-none" autoFocus />
                  ) : (
                    <span className="flex-1 text-[13px] text-foreground cursor-pointer hover:text-accent transition-colors" onClick={() => toggleEditing(idx, true)}>{line.text}</span>
                  )}
                  <Badge variant={isModified ? "danger" : "success"}>{isModified ? t["editor.step1.asr.modified"] : t["editor.step1.asr.confirmed"]}</Badge>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => onSetCurrentTime(parseTime(line.start))} className="text-muted-foreground hover:text-accent-green transition-colors cursor-pointer opacity-0 group-hover:opacity-100" title="跳转"><Play size={12} /></button>
                    {isModified && <button onClick={() => onUpdateAsrLine(idx, line.originalText || "")} className="text-muted-foreground hover:text-accent transition-colors cursor-pointer opacity-0 group-hover:opacity-100" title="还原"><UndoDot size={12} /></button>}
                    <button onClick={() => toggleEditing(idx, true)} className="text-muted-foreground hover:text-accent transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><Edit3 size={12} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleCard>

      {/* 4. 人物识别 */}
      <CollapsibleCard expanded={expandedSubSteps.faces} onExpandedChange={(v) => toggleSubStep("faces")}
        title={<><StatusIcon status={facesStatus === "idle" ? "pending" : facesStatus} /><span className={`text-[13px] font-semibold ${facesStatus === "completed" ? "text-accent-purple" : facesStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.faces.title"]}</span></>}
        extra={<span className="text-[13px] text-muted-foreground">{facesStatus === "completed" ? (t["editor.step1.faces.statusDone"]?.replace("{count}", String(roles.length)) || '') : statusText(facesStatus, "editor.step1.faces.statusRunning", "faces", "editor.step1.faces.statusFailed", "editor.step1.faces.statusIdle")}</span>}
        borderColor={facesStatus === "failed" ? "var(--accent-rose)" : undefined}>
        {facesStatus === "completed" && roles.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {roles.map((role) => (
              <div key={role.id} className="flex flex-col items-center gap-1 p-2 rounded-md bg-bg-secondary border border-border/20">
                <div className="w-12 h-12 rounded-full bg-bg-primary overflow-hidden">
                  {role.avatarPath && <img src={getSafeMediaUrl(role.avatarPath)} className="w-full h-full object-cover" />}
                </div>
                <input value={role.name} onChange={(e) => onUpdateRole(role.id, { name: e.target.value })} className="text-[13px] font-medium bg-transparent text-center outline-none border-b border-transparent focus:border-accent/30" />
                {role.appearances && <span className="text-[9px] text-muted-foreground">出现 {role.appearances} 次</span>}
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>
    </div>
  );
};
