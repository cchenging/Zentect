// Module: pipeline/step1-material - View

import React, { useEffect, useState } from "react";
import { Edit3, Music, Play, UndoDot, RotateCcw, Square, AlertTriangle, GitMerge, Split, Trash2, X, Globe } from "lucide-react";
import { getSafeMediaUrl } from "@renderer/utils/formatUrl";
import { Badge, StatusIcon, StatHeader, EmptyState, CollapsibleCard } from "@renderer/components/shared";
import { FrameExtractConfig } from "./components/FrameExtractConfig";
import { AudioSeparationConfig } from "./components/AudioSeparationConfig";
import { useI18n } from "@renderer/store/useI18n";
import type { AsrLine } from "../../../../shared/types/entities/editor";
import type { SubStepTiming } from "../../../../renderer/src/store/usePipelineStore";
import type { StepMaterialAnalysisViewProps } from "../types";

/**
 * 格式化毫秒为简洁文本
 * - <1s: 显示毫秒
 * - <60s: 显示秒（保留1位小数）
 * - >=60s: 显示分秒
 */
function formatMs(ms: number): string {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${s}s`;
}

/**
 * 子步骤耗时徽标
 * - completed 状态：显示「实际耗时 Xs」（事后对比，判断是否切换引擎）
 * - running 状态：显示「预计剩余 Xs」倒计时（缓解焦虑）
 *   估算公式：剩余 = 已耗时 / 进度% × (100% - 进度%)
 *   进度 < 5% 时显示「准备中...」（避免初期估算失真）
 */
const DurationBadge: React.FC<{
  status: string;
  timing: SubStepTiming | null | undefined;
  progress: number;
  durationLabel: string;
  remainingLabel: string;
  preparingLabel: string;
}> = ({ status, timing, progress, durationLabel, remainingLabel, preparingLabel }) => {
  // running 状态下每秒触发重渲染，让倒计时实时跳动
  const [, setTick] = useState(0);
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  // completed：显示实际耗时
  if (status === 'completed') {
    const text = formatMs(timing?.durationMs || 0);
    if (!text) return null;
    return <span className="text-[12px] text-muted-foreground/80 ml-1.5" title={durationLabel}>{`${durationLabel} ${text}`}</span>;
  }

  // running：显示预计剩余时间
  if (status === 'running' && timing?.startedAt) {
    // 进度过低时不估算，避免初期失真
    if (progress < 5) {
      return <span className="text-[12px] text-muted-foreground/70 ml-1.5">{preparingLabel}</span>;
    }
    const elapsed = Date.now() - timing.startedAt;
    // 估算总耗时 = 已耗时 / (进度 / 100)
    const totalEst = elapsed / (progress / 100);
    const remaining = Math.max(0, totalEst - elapsed);
    const text = formatMs(remaining);
    if (!text) return null;
    return <span className="text-[12px] text-accent/80 ml-1.5" title={remainingLabel}>{`${remainingLabel} ${text}`}</span>;
  }

  return null;
};

export const StepMaterialAnalysisView: React.FC<StepMaterialAnalysisViewProps> = (props) => {
  const { t } = useI18n();
  const {
    asrLines, frameCount, vocalsIsFallback, mediaItems, roles,
    subStepStatuses, subStepProgresses, subStepTimings,
    onUpdateAsrLine, onSetAsrLines, onSetCurrentTime, onSetActivePlaySource,
    onUpdateRole, onMergeRoles, onUnmergeRole, onDeleteRole, onRetrySubStep, onAbortSubStep,
  } = props;

  const [expandedSubSteps, setExpandedSubSteps] = useState<Record<string, boolean>>({
    frames: true, audio: false, whisper: false, faces: false,
  });
  const toggleSubStep = (key: string) => setExpandedSubSteps((prev) => ({ ...prev, [key]: !prev[key] }));
  /** 展开的角色卡片 ID（默认展开第一个角色，让用户一进来就能看到详情示例） */
  const [expandedRole, setExpandedRole] = useState<string | null>(roles[0]?.id ?? null);
  /** 🎭 P0.5+ 合并模式：mergeSourceId 非 null 时进入"选择目标"模式，点击其他角色完成合并 */
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);

  const parseTime = (timeStr: string): number => {
    if (!timeStr) return 0;
    const parts = timeStr.split(":");
    return parts.length >= 2 ? parseInt(parts[0], 10) * 60 + parseFloat(parts[1]) : parseFloat(timeStr) || 0;
  };

  const formatAsrTime = (line: AsrLine): string => {
    if (line.startMs !== undefined) {
      const totalSec = Math.floor(line.startMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return line.start || "00:00";
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
      <CollapsibleCard expanded={expandedSubSteps.frames} onExpandedChange={() => toggleSubStep("frames")}
        title={<><StatusIcon status={framesStatus === "idle" ? "pending" : framesStatus} /><span className={`text-[13px] font-semibold ${framesStatus === "completed" ? "text-accent-green" : framesStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.frames.title"]}</span></>}
        extra={<>
          <span className="text-[13px] text-muted-foreground">{framesStatus === "completed" ? (t["editor.step1.frames.statusDone"]?.replace("{count}", String(frameCount)) || '') : statusText(framesStatus, "editor.step1.frames.statusRunning", "frames", "editor.step1.frames.statusFail", "editor.step1.frames.statusIdle")}</span>
          <DurationBadge status={framesStatus} timing={subStepTimings.frames} progress={subStepProgresses.frames || 0} durationLabel={t["editor.step1.durationLabel"]} remainingLabel={t["editor.step1.remainingLabel"]} preparingLabel={t["editor.step1.preparingLabel"]} />
          {framesStatus === "running"
            ? <button onClick={(e) => { e.stopPropagation(); onAbortSubStep("frames"); }} className="ml-auto text-accent-rose hover:text-accent-rose/80 transition-colors cursor-pointer" title="停止"><Square size={13} /></button>
            : <button onClick={(e) => { e.stopPropagation(); onRetrySubStep("frames"); }} className="ml-auto text-muted-foreground hover:text-primary transition-colors cursor-pointer" title={t["editor.step1.frames.title"]}><RotateCcw size={13} /></button>}
        </>}
        borderColor={framesStatus === "failed" ? "var(--accent-rose)" : undefined}>
        <FrameExtractConfig isRunning={framesStatus === "running"} />
      </CollapsibleCard>

      {/* 2. 音频分离 */}
      <CollapsibleCard expanded={expandedSubSteps.audio} onExpandedChange={() => toggleSubStep("audio")}
        title={<><StatusIcon status={audioStatus === "idle" ? "pending" : audioStatus} /><span className={`text-[13px] font-semibold ${audioStatus === "completed" ? "text-accent-green" : audioStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.audio.title"]}</span></>}
        extra={<>
          <span className="text-[13px] text-muted-foreground">{audioStatus === "completed" ? t["editor.step1.audio.separated"] : statusText(audioStatus, "editor.step1.audio.statusRunning", "audio", "editor.step1.audio.statusFailed", "editor.step1.audio.statusIdle")}</span>
          <DurationBadge status={audioStatus} timing={subStepTimings.audio} progress={subStepProgresses.audio || 0} durationLabel={t["editor.step1.durationLabel"]} remainingLabel={t["editor.step1.remainingLabel"]} preparingLabel={t["editor.step1.preparingLabel"]} />
          {audioStatus === "running"
            ? <button onClick={(e) => { e.stopPropagation(); onAbortSubStep("audio"); }} className="ml-auto text-accent-rose hover:text-accent-rose/80 transition-colors cursor-pointer" title="停止"><Square size={13} /></button>
            : <button onClick={(e) => { e.stopPropagation(); onRetrySubStep("audio"); }} className="ml-auto text-muted-foreground hover:text-primary transition-colors cursor-pointer" title={t["editor.step1.audio.title"]}><RotateCcw size={13} /></button>}
        </>}
        borderColor={audioStatus === "failed" ? "var(--accent-rose)" : undefined}>
        <AudioSeparationConfig isRunning={audioStatus === "running"} />
        {/* 人声分离降级提示：分离失败时降级到原始音轨，提醒用户 ASR 质量可能下降 */}
        {audioStatus === "completed" && vocalsIsFallback && (
          <div className="flex items-start gap-2 p-2 rounded-md bg-accent-rose/10 border border-accent-rose/30">
            <AlertTriangle size={14} className="text-accent-rose shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-accent-rose">{t["editor.step1.audio.fallbackTitle"]}</div>
              <div className="text-[12px] text-muted-foreground mt-0.5">{t["editor.step1.audio.fallbackDesc"]}</div>
            </div>
          </div>
        )}
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
      <CollapsibleCard expanded={expandedSubSteps.whisper} onExpandedChange={() => toggleSubStep("whisper")}
        title={<><StatusIcon status={whisperStatus === "idle" ? "pending" : whisperStatus} /><span className={`text-[13px] font-semibold ${whisperStatus === "completed" ? "text-accent-green" : whisperStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.asr.title"]}</span></>}
        extra={<>
          {whisperStatus === "completed" ? <StatHeader value={asrLines.length} unit={t["editor.step1.asr.sentenceCount"]?.replace("{count}", String(asrLines.length)) || ''} secondary={t["editor.step1.asr.confirmedCount"]?.replace("{count}", String(confirmed)) || ''} /> : <span className="text-[13px] text-muted-foreground">{statusText(whisperStatus, "editor.step1.asr.statusRunning", "whisper", "editor.step1.asr.statusFailed", "editor.step1.asr.statusIdle")}</span>}
          <DurationBadge status={whisperStatus} timing={subStepTimings.whisper} progress={subStepProgresses.whisper || 0} durationLabel={t["editor.step1.durationLabel"]} remainingLabel={t["editor.step1.remainingLabel"]} preparingLabel={t["editor.step1.preparingLabel"]} />
          {whisperStatus === "running"
            ? <button onClick={(e) => { e.stopPropagation(); onAbortSubStep("whisper"); }} className="ml-auto text-accent-rose hover:text-accent-rose/80 transition-colors cursor-pointer" title="停止"><Square size={13} /></button>
            : <button onClick={(e) => { e.stopPropagation(); onRetrySubStep("whisper"); }} className="ml-auto text-muted-foreground hover:text-primary transition-colors cursor-pointer" title={t["editor.step1.asr.title"]}><RotateCcw size={13} /></button>}
        </>}
        borderColor={whisperStatus === "failed" ? "var(--accent-rose)" : undefined}>
        {whisperStatus === "completed" && asrLines.length > 0 && (
          <div className="rounded-md bg-bg-secondary border border-border/20 overflow-hidden">
            {asrLines.map((line, idx) => {
              const isModified = line.originalText !== undefined && line.text !== line.originalText;
              return (
                <div key={idx} className={`flex items-center gap-2 px-3 py-2 border-b border-border/10 last:border-0 group ${isModified ? "bg-accent/5 border-l-2 border-l-accent-rose" : ""}`}>
                  <span className="text-[13px] font-mono text-accent shrink-0 w-12">{formatAsrTime(line)}</span>
                  {line.editing ? (
                    <input value={line.text} onChange={(e) => onUpdateAsrLine(idx, e.target.value)} onBlur={() => toggleEditing(idx, false)} onKeyDown={(e) => { if (e.key === "Enter") toggleEditing(idx, false); }} className="flex-1 text-[13px] bg-bg-secondary px-2 py-1 rounded border border-accent/30 outline-none" autoFocus />
                  ) : (
                    <span className="flex-1 text-[13px] text-foreground cursor-pointer hover:text-accent transition-colors" onClick={() => toggleEditing(idx, true)}>{line.text}</span>
                  )}
                  <Badge variant={isModified ? "danger" : "success"}>{isModified ? t["editor.step1.asr.modified"] : t["editor.step1.asr.confirmed"]}</Badge>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => onSetCurrentTime(line.startMs !== undefined ? line.startMs / 1000 : parseTime(line.start))} className="text-muted-foreground hover:text-accent-green transition-colors cursor-pointer opacity-0 group-hover:opacity-100" title="跳转"><Play size={12} /></button>
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
      <CollapsibleCard expanded={expandedSubSteps.faces} onExpandedChange={() => toggleSubStep("faces")}
        title={<><StatusIcon status={facesStatus === "idle" ? "pending" : facesStatus} /><span className={`text-[13px] font-semibold ${facesStatus === "completed" ? "text-accent-purple" : facesStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.faces.title"]}</span></>}
        extra={<>
          <span className="text-[13px] text-muted-foreground">{facesStatus === "completed" ? (t["editor.step1.faces.statusDone"]?.replace("{count}", String(roles.length)) || '') : statusText(facesStatus, "editor.step1.faces.statusRunning", "faces", "editor.step1.faces.statusFailed", "editor.step1.faces.statusIdle")}</span>
          <DurationBadge status={facesStatus} timing={subStepTimings.faces} progress={subStepProgresses.faces || 0} durationLabel={t["editor.step1.durationLabel"]} remainingLabel={t["editor.step1.remainingLabel"]} preparingLabel={t["editor.step1.preparingLabel"]} />
          {facesStatus === "running"
            ? <button onClick={(e) => { e.stopPropagation(); onAbortSubStep("faces"); }} className="ml-auto text-accent-rose hover:text-accent-rose/80 transition-colors cursor-pointer" title="停止"><Square size={13} /></button>
            : <button onClick={(e) => { e.stopPropagation(); onRetrySubStep("faces"); }} className="ml-auto text-muted-foreground hover:text-primary transition-colors cursor-pointer" title={t["editor.step1.faces.title"]}><RotateCcw size={13} /></button>}
        </>}
        borderColor={facesStatus === "failed" ? "var(--accent-rose)" : undefined}>
        {facesStatus === "completed" && roles.length > 0 && (
          <div className="flex flex-col gap-3">
            {/* 🎭 P0.5+ 合并模式提示条 */}
            {mergeSourceId && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-accent/10 border border-accent/30 text-[12px]">
                <GitMerge size={14} className="text-accent shrink-0" />
                <span className="flex-1">合并模式：请点击目标角色卡片完成合并（{roles.find(r => r.id === mergeSourceId)?.name} → ?）</span>
                <button
                  onClick={() => setMergeSourceId(null)}
                  className="text-muted-foreground hover:text-primary transition-colors p-0.5"
                  title="取消合并"
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              {roles.map((role) => {
                /** 提取角色属性：gender(1=男/0=女)、age、出现次数 */
                const rep = role.representative || {};
                const gender = rep.gender ?? role.gender;
                const age = rep.age ?? role.age;
                const faceCount = role.faceCount ?? (role.faces?.length || 0);
                const isExpanded = expandedRole === role.id;
                /** 多张人脸缩略图（最多展示 9 张） */
                const allFaces = (role.faces || []).slice(0, 9);
                /** 🎭 P0.5+ 已合并的子角色列表（用于显示拆分按钮） */
                const mergedRoles = (role as any).mergedRoles || [];
                const isMergeSource = mergeSourceId === role.id;
                /** 合并模式下的目标高亮：非源角色显示"点击合并"提示 */
                const isMergeTarget = mergeSourceId && mergeSourceId !== role.id;
                /** 🎭 P1 全局人物注册中心：role.globalCharacterId 存在表示该角色已匹配到全局人物（跨集/跨项目复用） */
                const globalCharacterId = (role as any).globalCharacterId as string | undefined;
                return (
                  <div
                    key={role.id}
                    className={`rounded-lg bg-bg-secondary border overflow-hidden transition-colors ${
                      isMergeSource ? 'border-accent/50 ring-1 ring-accent/30' :
                      isMergeTarget ? 'border-accent-green/40 cursor-pointer hover:bg-accent-green/5' :
                      'border-border/20'
                    }`}
                    /** 🎭 P0.5+ 合并模式下点击非源角色卡片触发合并 */
                    onClick={() => {
                      if (isMergeTarget && mergeSourceId) {
                        onMergeRoles(mergeSourceId, role.id);
                        setMergeSourceId(null);
                      }
                    }}
                  >
                    {/* 卡片头部：大头像（80x80）+ 名称 + 属性，点击展开/收起 */}
                    <div
                      className="flex items-center gap-2 p-2 cursor-pointer hover:bg-bg-tertiary/30 transition-colors"
                      onClick={(e) => {
                        if (isMergeTarget) return; // 合并模式下不展开
                        e.stopPropagation();
                        setExpandedRole(isExpanded ? null : role.id);
                      }}
                    >
                      {/* 方形大头像 80x80，比旧版 48x48 大 2.8 倍 */}
                      <div className="relative w-20 h-20 rounded-md bg-bg-primary overflow-hidden shrink-0 border border-border/30">
                        {role.avatarPath && <img src={getSafeMediaUrl(role.avatarPath)} className="w-full h-full object-cover" />}
                        {/* 🎭 P1 全局人物标记：右上角紫色 Globe 徽章，标识该角色已匹配到全局人物（跨集/跨项目复用） */}
                        {globalCharacterId && (
                          <span
                            className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-accent-purple/90 flex items-center justify-center ring-1 ring-bg-primary"
                            title="已匹配全局人物（跨集/跨项目复用）"
                          >
                            <Globe size={10} className="text-white" />
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <input
                          value={role.name}
                          onChange={(e) => onUpdateRole(role.id, { name: e.target.value })}
                          onClick={(e) => e.stopPropagation()}
                          className="text-[14px] font-medium bg-transparent outline-none border-b border-transparent focus:border-accent/30 w-full"
                        />
                        <div className="flex flex-col gap-0.5 mt-1 text-[11px] text-muted-foreground">
                          {faceCount > 0 && <span>出现 {faceCount} 次</span>}
                          {gender !== undefined && gender !== null && <span>{gender === 1 ? '男' : '女'}</span>}
                          {age > 0 && <span>约 {age} 岁</span>}
                          {mergedRoles.length > 0 && <span className="text-accent/80">已合并 {mergedRoles.length} 个角色</span>}
                          {/* 🎭 P1 全局人物注册中心：显示「已匹配全局人物」标记，点击可查看跨项目关联 */}
                          {globalCharacterId && (
                            <span className="inline-flex items-center gap-1 text-accent-purple/90">
                              <Globe size={10} />
                              已匹配全局人物
                            </span>
                          )}
                        </div>
                      </div>
                      {/* 🎭 P0.5+ 操作按钮组：合并/拆分/删除（仅在非合并模式时显示） */}
                      {!mergeSourceId && (
                        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => setMergeSourceId(role.id)}
                            className="text-muted-foreground hover:text-accent transition-colors p-1 rounded hover:bg-accent/10"
                            title="合并到其他角色"
                          >
                            <GitMerge size={13} />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`确定删除角色"${role.name}"吗？关联的镜头将解除角色绑定。`)) {
                                onDeleteRole(role.id);
                              }
                            }}
                            className="text-muted-foreground hover:text-accent-rose transition-colors p-1 rounded hover:bg-accent-rose/10"
                            title="删除角色"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                      {!mergeSourceId && (
                        <span className={`text-muted-foreground text-[11px] transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                      )}
                    </div>
                    {/* 展开区域：多张人脸缩略图 + 已合并角色拆分按钮 */}
                    {isExpanded && !mergeSourceId && (
                      <div className="px-2 pb-2 pt-1 border-t border-border/10">
                        {/* 🎭 P0.5+ 已合并角色列表（每个带拆分按钮） */}
                        {mergedRoles.length > 0 && (
                          <div className="mb-2">
                            <div className="text-[11px] text-muted-foreground mb-1.5">已合并的角色 ({mergedRoles.length})</div>
                            <div className="flex flex-col gap-1">
                              {mergedRoles.map((mr: any) => (
                                <div key={mr.id} className="flex items-center gap-2 p-1 rounded bg-bg-tertiary/30">
                                  <div className="w-6 h-6 rounded bg-bg-primary overflow-hidden shrink-0">
                                    {mr.avatarPath && <img src={getSafeMediaUrl(mr.avatarPath)} className="w-full h-full object-cover" />}
                                  </div>
                                  <span className="text-[12px] flex-1 truncate">{mr.name}</span>
                                  <button
                                    onClick={() => onUnmergeRole(mr.id, role.id)}
                                    className="text-muted-foreground hover:text-accent transition-colors p-1 rounded hover:bg-accent/10"
                                    title="拆分为独立角色"
                                  >
                                    <Split size={12} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* 多张人脸缩略图（3 列网格，每张较大） */}
                        {allFaces.length > 0 && (
                          <>
                            <div className="text-[11px] text-muted-foreground mb-1.5">检测到的人脸 ({role.faces?.length || 0})</div>
                            <div className="grid grid-cols-3 gap-1.5">
                              {allFaces.map((face: any, idx: number) => {
                                const faceUrl = face.face_path || face.facePath;
                                return faceUrl ? (
                                  <div key={idx} className="aspect-square rounded bg-bg-primary overflow-hidden border border-border/20">
                                    <img src={getSafeMediaUrl(faceUrl)} className="w-full h-full object-cover" />
                                  </div>
                                ) : null;
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {facesStatus === "completed" && roles.length === 0 && (
          <EmptyState title={t["editor.step1.faces.emptyTitle"]} description={t["editor.step1.faces.emptyDesc"]} iconType="user" size="sm" />
        )}
      </CollapsibleCard>
    </div>
  );
};
