// Module: pipeline/step1-material - View

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Edit3, Music, Play, UndoDot, RotateCcw, Square, AlertTriangle, GitMerge, Split, Trash2, X, Globe, Users } from "lucide-react";
import { getSafeMediaUrl } from "@renderer/utils/formatUrl";
import { Badge, StatusIcon, StatHeader, EmptyState, CollapsibleCard } from "@renderer/components/shared";
import { FrameExtractConfig } from "./components/FrameExtractConfig";
import { AudioSeparationConfig } from "./components/AudioSeparationConfig";
import { ASRConfig } from "./components/ASRConfig";
// 🎬 OP/ED 片头片尾裁剪（P1 音视频启发/P2 指纹/P3 VLM 4 级落地总成）
import { OpEdTrimConfig } from "./components/OpEdTrimConfig";
import { useStep1Store } from "@modules/pipeline/stores/useStep1Store";
import { useI18n } from "@renderer/store/useI18n";
import { usePlayerStore } from "@modules/editor/stores/usePlayerStore";
import { useProjectStore } from "@modules/editor/stores/useProjectStore";
import type { AsrLine } from "../../../../shared/types/entities/editor";
import type { SubStepTiming } from "../../../../renderer/src/store/usePipelineStore";
import type { StepMaterialAnalysisViewProps } from "../types";

/**
 * 角色列表确定性整理（前端兜底）：按自动编号"角色_N"升序排序 + 自动名去重。
 * 后端 Strategy 已做过同一清洗，这里再兜底一层，保证任何数据来源（DB 回读、
 * 历史数据、SSE 增量）渲染时都按编号排列且不出现重复"角色_N"。
 * @param roles 原始角色数组
 * @returns 整理后的新数组
 */
function sortAndDedupeRoles(roles: any[]): any[] {
  const autoIndex = (r: any): number => {
    const m = /角色_(\d+)/.exec(r?.name || '');
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  const seen = new Set<number>();
  const result: any[] = [];
  for (const r of roles) {
    const idx = autoIndex(r);
    if (idx !== Number.MAX_SAFE_INTEGER && seen.has(idx)) continue; // 自动名去重
    if (idx !== Number.MAX_SAFE_INTEGER) seen.add(idx);
    result.push(r);
  }
  return result.sort((a, b) => autoIndex(a) - autoIndex(b));
}

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
 * 人脸来源秒数：人脸识别用 1fps 均匀抽帧，来源帧文件名 frame_NNNNNNNN.jpg 的序号即视频秒。
 * ⚠️ 不能用 face.frame_index 直接当秒：超过 120 帧会被均匀采样，frame_index 是采样后下标，失去秒含义；
 *    而文件名序号保留原始 1fps 帧号，始终等于视频秒，故从帧路径解析最可靠。
 * @param face 人脸对象（含来源帧路径 frame / frame_path / framePath）
 * @returns 视频秒数；无法解析（如回退到 VLM 帧）时返回 undefined
 */
function parseFaceSeconds(face: any): number | undefined {
  const framePath = face.frame || face.frame_path || face.framePath;
  if (!framePath) return undefined;
  const m = /frame_(\d+)\.jpg$/i.exec(String(framePath));
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * 人脸来源帧时间：把秒格式化为 mm:ss，用于在缩略图上标注"这张脸来自视频哪个时间点"。
 * @param faceSec 人脸来源秒数（parseFaceSeconds 的返回值）
 * @returns mm:ss 字符串；无有效秒数时返回空串
 */
function formatFaceTime(faceSec: number | undefined): string {
  if (typeof faceSec !== 'number' || !isFinite(faceSec) || faceSec < 0) return '';
  const total = Math.floor(faceSec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

/**
 * 🎭 P1.5 角色分级徽章：显示 主角/配角/背景路人 标注
 * - main      主角：金色强调
 * - supporting配角：紫色强调
 * - extra     背景路人：灰色弱化
 * - 未标注    ：显示「未标注」，点击可补标
 * 点击徽章可循环切换分级（手动标注），持久化到 DB tiers 列。
 */
const TierBadge: React.FC<{
  tier?: 'main' | 'supporting' | 'extra';
  onClick?: (e: React.MouseEvent) => void;
}> = ({ tier, onClick }) => {
  const config: Record<string, { label: string; cls: string }> = {
    main: { label: '主角', cls: 'bg-accent/15 text-accent border-accent/30' },
    supporting: { label: '配角', cls: 'bg-accent-purple/15 text-accent-purple border-accent-purple/30' },
    extra: { label: '背景路人', cls: 'bg-muted/40 text-muted-foreground border-border/40' },
  };
  const c = tier ? config[tier] : { label: '未标注', cls: 'bg-muted/20 text-muted-foreground/70 border-dashed border-border/40' };
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      title={tier ? `当前：${c.label}（点击切换分级）` : '点击标注角色分级（主角/配角/背景路人）'}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[12px] font-medium border leading-none whitespace-nowrap shrink-0 cursor-pointer hover:opacity-80 transition-opacity ${c.cls}`}
    >
      {c.label}
    </button>
  );
};

export const StepMaterialAnalysisView: React.FC<StepMaterialAnalysisViewProps> = (props) => {
  const { t } = useI18n();
  const {
    asrLines, frameCount, vocalsIsFallback, mediaItems, roles,
    subStepStatuses, subStepProgresses, subStepTimings,
    onUpdateAsrLine, onSetAsrLines, onSetCurrentTime, onSetActivePlaySource,
    onUpdateRole, onMergeRoles, onUnmergeRole, onDeleteRole, onRemoveAsrLine, onRetrySubStep, onAbortSubStep,
  } = props;

  const [expandedSubSteps, setExpandedSubSteps] = useState<Record<string, boolean>>({
    frames: true, audio: false, whisper: false, faces: false, oped: true,
  });
  const toggleSubStep = (key: string) => setExpandedSubSteps((prev) => ({ ...prev, [key]: !prev[key] }));

  /**
   * 🎬 OP/ED 配置用：
   *   ① projectId 取 useProjectStore（step1 专属 store 不存 projectId），兼容旧项目即使 store 字段名不同的情况
   *   ② 视频素材：优先 m.type==='video'（最新 MediaItem），找不到则按扩展名兜底识别常见视频格式，最后退化取 mediaItems[0]（旧项目兼容）
   */
  const storeProjectId = useProjectStore((s) => s.projectId);
  const step1ProjectIdFallback: string | undefined = useStep1Store((s) =>
    (s as any).projectId || (s as any).project_id || (s as any).currentProjectId || (s as any).current_project_id
  );
  const opedProjectId: string | undefined = storeProjectId || step1ProjectIdFallback;
  const videoItems = useMemo(() => {
    const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.m4v', '.flv', '.wmv', '.ts', '.webm', '.mpg', '.mpeg', '.3gp', '.mts', '.m2ts']);
    const isVideoExt = (name?: string) => {
      if (!name) return false;
      const ext = name.split('.').pop()?.toLowerCase();
      return !!ext && VIDEO_EXTS.has(`.${ext}`);
    };
    // 1) type 严格等于 video
    const strict = mediaItems.filter((m) => (m.type as any) === 'video');
    if (strict.length > 0) return strict;
    // 2) 兼容：video_chunk 或 frame 但其实是父视频（只要扩展名是视频就视为可裁剪视频素材）
    const byExt = mediaItems.filter((m) => isVideoExt(m.filePath) || isVideoExt(m.name) || isVideoExt((m as any).fileName));
    if (byExt.length > 0) return byExt;
    // 3) 退化：把所有非音频类型都算上，最后取第一项
    const fallback = mediaItems.filter((m) => m.type !== 'audio');
    return fallback;
  }, [mediaItems]);
  const firstVideo = videoItems[0] || mediaItems[0] || null;
  const opedSetIsRunning = (subStepStatuses.frames || subStepStatuses.audio || subStepStatuses.whisper || subStepStatuses.faces) === "running";

  /** 🎬 自动联动：订阅播放器当前时间，用于高亮当前播放的台词并滚动到可见区域 */
  const playerCurrentTime = usePlayerStore((s) => s.currentTime);
  const asrRowRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** 悬停暂停联动：鼠标悬停在台词列表上时停止自动滚动，避免"滚到别处又被拽回去" */
  const [hoverPaused, setHoverPaused] = useState(false);

  /** 计算当前播放时间对应的台词行索引：
   *   仅当时间严格落在某行 [startMs, endMs) 内才高亮该行（间隙态不吸附）；
   *   落在两行之间的静音/留白时返回 -1，不高亮也不滚动，避免误高亮没在说话的台词 */
  const activeAsrIndex = useMemo(() => {
    if (asrLines.length === 0) return -1;
    const tMs = playerCurrentTime * 1000;
    for (let i = 0; i < asrLines.length; i++) {
      const ls = asrLines[i].startMs ?? 0;
      const le = asrLines[i].endMs ?? ls;
      // 严格落在 [start, end) 内才算当前行；end 未定义时视为单点时刻落到该行
      if (tMs >= ls && (asrLines[i].endMs !== undefined ? tMs < le : tMs <= ls)) return i;
    }
    return -1;
  }, [asrLines, playerCurrentTime]);

  /** 联动滚动：仅在非悬停暂停且存在当前行时滚动到可见区域（block:'nearest' 最小化跳动） */
  useEffect(() => {
    if (hoverPaused || activeAsrIndex < 0) return;
    const row = asrRowRefs.current[activeAsrIndex];
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeAsrIndex, hoverPaused]);

  /** 展开的角色卡片 ID（默认展开第一个角色，让用户一进来就能看到详情示例） */
  const [expandedRole, setExpandedRole] = useState<string | null>(roles[0]?.id ?? null);
  /** 🎭 P0.5+ 合并模式：mergeSourceId 非 null 时进入"选择目标"模式，点击其他角色完成合并 */
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);
  /** 🎭 背景路人折叠区：extra 级角色默认收纳，点击展开查看 */
  const [showExtras, setShowExtras] = useState(false);
  /** 🎭 角色主次分组：main 主角 + supporting 配角平铺主体区，extra 背景路人折叠收纳 */
  const sortedRoles = useMemo(() => sortAndDedupeRoles(roles), [roles]);
  const mainRoles = sortedRoles.filter((r) => r.tier !== 'extra');
  const extraRoles = sortedRoles.filter((r) => r.tier === 'extra');

  /**
   * 获取角色可显示的头像路径（修复黑头像）
   * 优先级：avatarPath → representative.facePath/face_path → avatar → faces 中第一个有效路径
   * 旧版只读 avatarPath，一旦该字段为空（历史数据/路径缺失）就显示黑块；
   * 实际上 faces 数组里通常有可用的人脸路径，可回退显示。
   */
  const getRoleAvatar = useCallback((role: any): string => {
    if (!role) return '';
    const direct =
      role.avatarPath || role.avatar
      || role.representative?.facePath || role.representative?.face_path || '';
    if (direct && String(direct).trim()) return direct;
    const face = (role.faces || []).find(
      (x: any) => x && String(x.face_path || x.facePath || '').trim() !== ''
    );
    return face ? (face.face_path || face.facePath || '') : '';
  }, []);
  /** 🎭 P1.5 手动标注：点击分级徽章循环切换 main→supporting→extra→main，并持久化 */
  const cycleTier = (role: any) => {
    const order: Array<'main' | 'supporting' | 'extra'> = ['main', 'supporting', 'extra'];
    const cur = role.tier as 'main' | 'supporting' | 'extra' | undefined;
    const next = order[(order.indexOf(cur as 'main' | 'supporting' | 'extra') + 1) % order.length];
    onUpdateRole(role.id, { tier: next });
  };

  /** 🕐 解析时间：兼容 "mm:ss" / "hh:mm:ss" 字符串与纯秒数字（ASR 行 start 字段历史形态不统一，防御性兜底） */
  const parseTime = (timeStr: string | number): number => {
    if (timeStr === undefined || timeStr === null || timeStr === '') return 0;
    if (typeof timeStr === 'number') return isFinite(timeStr) ? timeStr : 0;
    const parts = timeStr.split(":");
    return parts.length >= 2 ? parseInt(parts[0], 10) * 60 + parseFloat(parts[1]) : parseFloat(timeStr) || 0;
  };

  /** 🎞 帧率：优先取视频素材真实 fps（ffprobe r_frame_rate，如 23.976/25/30/50/60），缺失或非法时回退固定 30fps */
  const ASR_TC_FPS = (() => {
    const fps = firstVideo?.fps;
    return fps && Number.isFinite(fps) && fps > 0 ? fps : 30;
  })();
  /**
   * 🕐 台词时间显示：毫秒 → **HH:MM:SS:FF（时:分:秒:帧）4 段式 SMPTE 时间码**
   * 帧号按素材真实帧率计算（非整数帧率如 23.976 会向下取整到当前帧）：
   *   0ms        → "00:00:00:00"
   *   65_300ms   → "00:01:05:09"  （30fps 下 0.3s×30=第9帧；60fps 下 0.3s×60=第18帧）
   *   85_000ms   → "00:01:25:00"
   */
  const formatAsrTime = (line: AsrLine): string => {
    let ms = line.startMs;
    if (ms === undefined) {
      ms = Math.round(parseTime(line.start) * 1000) || 0;
    }
    if (!ms || ms <= 0) return '00:00:00:00';
    const sec = ms / 1000;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const f = Math.floor((sec % 1) * ASR_TC_FPS);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
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
      {/* 0. OP/ED 片头片尾裁剪（P1 音视频启发/P2 指纹/P3 VLM 4 级落地总成） */}
      <CollapsibleCard
        expanded={expandedSubSteps.oped}
        onExpandedChange={() => toggleSubStep("oped")}
        title={
          <div className="flex flex-col items-start gap-0.5">
            <div className="flex items-center gap-2">
              <GitMerge size={16} className="text-purple-600 shrink-0" />
              <span className="font-medium">OP/ED 片头片尾裁剪</span>
              <Badge variant="default" className="text-[11px] leading-[18px] px-1.5 py-0 normal-case rounded">
                4 级落地：手动锁 {">"} 黑场静音 {"<"} 指纹对齐 {"<"} VLM 分类
              </Badge>
            </div>
            <span className="text-[12px] text-muted-foreground leading-[18px]">
              自动 / 手动去除片头曲(OP)与片尾曲(ED)，避免 Whisper 将片头曲幻听为台词并修正时间轴错位
            </span>
          </div>
        }
        extra={
          <div className="flex items-center gap-1.5">
            {opedSetIsRunning ? (
              <div className="flex items-center gap-1">
                <StatusIcon status="running" size={14} />
                <span className="text-[12px] text-muted-foreground">子任务运行中，检测可后台进行</span>
              </div>
            ) : null}
            {opedProjectId && firstVideo ? (
              <div className="flex items-center gap-1">
                <StatusIcon status="completed" size={14} />
                <span className="text-[12px] text-muted-foreground">就绪</span>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <StatusIcon status="warning" size={14} />
                <span className="text-[12px] text-muted-foreground">
                  {!opedProjectId ? '缺少项目' : !firstVideo ? '缺少视频素材' : '缺少项目或视频素材'}
                </span>
              </div>
            )}
          </div>
        }
      >
        {(!opedProjectId || !firstVideo) ? (
          <EmptyState
            title="缺少可用上下文"
            description={
              !opedProjectId
                ? "当前项目未初始化（projectId 为空），无法读取 OP/ED 裁剪配置。请先打开一个项目。"
                : "当前项目没有可识别的视频类型素材。OP/ED 裁剪仅针对视频素材生效，请先导入视频。"
            }
          />
        ) : (
          <OpEdTrimConfig
            projectId={opedProjectId}
            mediaId={firstVideo.id}
            mediaName={firstVideo.name || firstVideo.fileName || `素材 ${firstVideo.id.slice(0, 8)}`}
            durationMs={firstVideo.duration ? Math.round(Number(firstVideo.duration) * 1000) : 0}
            sourcePath={firstVideo.filePath || ""}
            onJumpVideoMs={(ms) => {
              try {
                // 🔧 与 Container.seekTo 对齐：只写 currentTime 只更新进度条 state，
                // 必须同时写 manualSeekTime 让 VideoCanvas 真正 seek 媒体到目标位置。
                const t = Math.max(0, Number(ms) / 1000);
                usePlayerStore.setState({ currentTime: t, manualSeekTime: t });
              } catch (e) {
                // ignore
              }
            }}
          />
        )}
      </CollapsibleCard>

      {/* 1. 关键帧提取 */}
      <CollapsibleCard expanded={expandedSubSteps.frames} onExpandedChange={() => toggleSubStep("frames")}
        title={<><StatusIcon status={framesStatus === "idle" ? "pending" : framesStatus} /><span className={`text-[14px] font-semibold ${framesStatus === "completed" ? "text-accent-green" : framesStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.frames.title"]}</span></>}
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
        title={<><StatusIcon status={audioStatus === "idle" ? "pending" : audioStatus} /><span className={`text-[14px] font-semibold ${audioStatus === "completed" ? "text-accent-green" : audioStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.audio.title"]}</span></>}
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
        title={<><StatusIcon status={whisperStatus === "idle" ? "pending" : whisperStatus} /><span className={`text-[14px] font-semibold ${whisperStatus === "completed" ? "text-accent-green" : whisperStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.asr.title"]}</span></>}
        extra={<>
          {whisperStatus === "completed" ? <StatHeader value={asrLines.length} unit={t["editor.step1.asr.sentenceCount"]?.replace("{count}", String(asrLines.length)) || ''} secondary={t["editor.step1.asr.confirmedCount"]?.replace("{count}", String(confirmed)) || ''} /> : <span className="text-[13px] text-muted-foreground">{statusText(whisperStatus, "editor.step1.asr.statusRunning", "whisper", "editor.step1.asr.statusFailed", "editor.step1.asr.statusIdle")}</span>}
          <DurationBadge status={whisperStatus} timing={subStepTimings.whisper} progress={subStepProgresses.whisper || 0} durationLabel={t["editor.step1.durationLabel"]} remainingLabel={t["editor.step1.remainingLabel"]} preparingLabel={t["editor.step1.preparingLabel"]} />
          {whisperStatus === "running"
            ? <button onClick={(e) => { e.stopPropagation(); onAbortSubStep("whisper"); }} className="ml-auto text-accent-rose hover:text-accent-rose/80 transition-colors cursor-pointer" title="停止"><Square size={13} /></button>
            : <button onClick={(e) => { e.stopPropagation(); onRetrySubStep("whisper"); }} className="ml-auto text-muted-foreground hover:text-primary transition-colors cursor-pointer" title={t["editor.step1.asr.title"]}><RotateCcw size={13} /></button>}
        </>}
        borderColor={whisperStatus === "failed" ? "var(--accent-rose)" : undefined}>
        {/* ASR 引擎 + faster-whisper 模型大小配置 */}
        <ASRConfig isRunning={whisperStatus === "running"} />
        {whisperStatus === "completed" && asrLines.length > 0 && (
          <div className="rounded-md bg-bg-secondary border border-border/20 overflow-hidden"
            onMouseEnter={() => setHoverPaused(true)}
            onMouseLeave={() => setHoverPaused(false)}>
            {asrLines.map((line, idx) => {
              const isModified = line.originalText !== undefined && line.text !== line.originalText;
              const isActive = idx === activeAsrIndex;
              return (
                <div key={idx} ref={(el) => { asrRowRefs.current[idx] = el; }}
                  className={`flex items-center gap-2 px-3 py-2 border-b border-border/10 last:border-0 group ${isModified ? "bg-accent/5 border-l-2 border-l-accent-rose" : ""} ${isActive ? "bg-accent/15 border-l-2 border-l-accent" : ""}`}>
                  <span className={`text-[13px] font-mono shrink-0 w-24 ${isActive ? "text-accent font-semibold" : "text-accent"}`}>{formatAsrTime(line)}</span>
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
                    <button onClick={() => onRemoveAsrLine(idx)} className="text-muted-foreground hover:text-accent-rose transition-colors cursor-pointer opacity-0 group-hover:opacity-100" title="删除该条台词"><Trash2 size={12} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleCard>

      {/* 4. 人物识别 */}
      <CollapsibleCard expanded={expandedSubSteps.faces} onExpandedChange={() => toggleSubStep("faces")}
        title={<><StatusIcon status={facesStatus === "idle" ? "pending" : facesStatus} /><span className={`text-[14px] font-semibold ${facesStatus === "completed" ? "text-accent-purple" : facesStatus === "failed" ? "text-accent-rose" : ""}`}>{t["editor.step1.faces.title"]}</span></>}
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
            <div className="grid grid-cols-2 gap-3">
              {mainRoles.map((role) => {
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
                /** 💥 修复黑头像：用 getRoleAvatar 回退获取可显示的头像路径 */
                const avatarUrl = getRoleAvatar(role);
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
                      {/* 方形大头像 80x80，让角色脸清晰可辨的同时给角色名/属性留足横向空间 */}
                      <div className="relative w-20 h-20 rounded-md bg-bg-primary overflow-hidden shrink-0 border border-border/30">
                        {avatarUrl
                          ? <img src={getSafeMediaUrl(avatarUrl)} className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                          : <div className="w-full h-full flex items-center justify-center text-muted-foreground/40"><Users size={28} /></div>}
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
                        <div className="flex items-center gap-1.5">
                          <input
                            value={role.name}
                            onChange={(e) => onUpdateRole(role.id, { name: e.target.value })}
                            onClick={(e) => e.stopPropagation()}
                            className="text-[14px] font-medium bg-transparent outline-none border-b border-transparent focus:border-accent/30 w-full min-w-0"
                          />
                          {/* 🎭 P1.5 角色分级标注徽章：显示并支持手动切换 主角/配角 */}
                          <TierBadge tier={role.tier} onClick={() => cycleTier(role)} />
                        </div>
                        <div className="flex flex-col gap-0.5 mt-1 text-[12px] text-muted-foreground">
                          {faceCount > 0 && <span>出现 {faceCount} 次</span>}
                          {gender !== undefined && gender !== null && <span>{gender === 1 ? '男' : '女'}</span>}
                          {typeof age === 'number' && age > 0 && <span>约 {age} 岁</span>}
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
                    {/* 人脸印象条：未展开时也展示该角色多张真实人脸缩略图（最多 5 张）
                        目的：单张头像有时是远景/侧脸看不清，一排多张能直观看出"这是同一人"，
                        也便于对比不同角色是否重复，缓解"分不清谁是谁"的问题 */}
                    {!isExpanded && !mergeSourceId && allFaces.length > 1 && (
                      <div className="px-2 pb-2 pt-0.5 flex gap-1">
                        {allFaces.slice(0, 5).map((face: any, idx: number) => {
                          const fUrl = face.face_path || face.facePath;
                          if (!fUrl) return null;
                          // 🎬 来源帧可追溯：从帧文件名解析真实视频秒（帧序号），点击可跳转播放器到该帧核对剧情上下文
                          const faceSec = parseFaceSeconds(face);
                          const faceTime = formatFaceTime(faceSec);
                          return (
                            <button
                              key={idx}
                              type="button"
                              disabled={typeof faceSec !== 'number'}
                              onClick={() => { if (typeof faceSec === 'number') onSetCurrentTime(faceSec); }}
                              className="relative w-10 h-10 rounded border border-border/20 overflow-hidden shrink-0 bg-bg-primary group/face cursor-pointer hover:border-accent/40 transition-colors disabled:cursor-default disabled:hover:border-border/20"
                              title={faceTime ? `跳转到该帧 ${faceTime}` : '该人脸无来源帧信息'}
                            >
                              <img src={getSafeMediaUrl(fUrl)} className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                              {faceTime && (
                                <span className="absolute bottom-0 right-0 px-0.5 text-[9px] leading-tight bg-black/60 text-white rounded-tl">{faceTime}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
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
                            <div className="text-[11px] text-muted-foreground mb-1.5">检测到的人脸 ({role.faces?.length || 0})（点击可跳转到来源帧）</div>
                            <div className="grid grid-cols-3 gap-1.5">
                              {allFaces.map((face: any, idx: number) => {
                                const faceUrl = face.face_path || face.facePath;
                                if (!faceUrl) return null;
                                // 🎬 来源帧可追溯：从帧文件名解析真实视频秒（帧序号），点击跳转播放器到该帧核对
                                const faceSec = parseFaceSeconds(face);
                                const faceTime = formatFaceTime(faceSec);
                                return (
                                  <button
                                    key={idx}
                                    type="button"
                                    disabled={typeof faceSec !== 'number'}
                                    onClick={() => { if (typeof faceSec === 'number') onSetCurrentTime(faceSec); }}
                                    className="relative aspect-square rounded bg-bg-primary overflow-hidden border border-border/20 group/face cursor-pointer hover:border-accent/40 transition-colors disabled:cursor-default disabled:hover:border-border/20"
                                    title={faceTime ? `跳转到该帧 ${faceTime}` : '该人脸无来源帧信息'}
                                  >
                                    <img src={getSafeMediaUrl(faceUrl)} className="w-full h-full object-cover" />
                                    {faceTime && (
                                      <span className="absolute bottom-0 right-0 px-1 text-[10px] leading-tight bg-black/60 text-white rounded-tl">{faceTime}</span>
                                    )}
                                  </button>
                                );
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
            {/* 🎭 P1.5 背景路人折叠区：extra 级角色（只出现1次）收纳于此，不喧宾夺主 */}
            {extraRoles.length > 0 && (
              <div className="rounded-lg border border-dashed border-border/30 bg-muted/20 overflow-hidden">
                <button
                  onClick={() => setShowExtras((v) => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground hover:bg-muted/40 transition-colors cursor-pointer"
                >
                  <Users size={13} className="shrink-0 text-muted-foreground/70" />
                  <span className="flex-1 text-left">背景路人（{extraRoles.length}）</span>
                  <span className={`transition-transform ${showExtras ? 'rotate-180' : ''}`}>▾</span>
                </button>
                {showExtras && (
                  <div className="grid grid-cols-4 gap-2 px-2 pb-2">
                    {extraRoles.map((role) => {
                      const faceUrl = getRoleAvatar(role);
                      const faceCount = role.faceCount ?? (role.faces?.length || 0);
                      return (
                        <div key={role.id} className="rounded-lg bg-bg-secondary border border-border/20 p-1.5 flex flex-col items-center gap-1">
                          <div className="w-14 h-14 rounded-md bg-bg-primary overflow-hidden shrink-0 border border-border/30">
                            {faceUrl
                              ? <img src={getSafeMediaUrl(faceUrl)} className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                              : <div className="w-full h-full flex items-center justify-center text-muted-foreground/40"><Users size={16} /></div>}
                          </div>
                          <span className="text-[12px] text-muted-foreground truncate w-full text-center">{role.name}</span>
                          {/* 🎭 P1.5 路人徽章：点击可循环切换分级（升级为配角/主角） */}
                          <TierBadge tier={role.tier} onClick={() => cycleTier(role)} />
                          <span className="text-[11px] text-muted-foreground/70">{faceCount}次</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {facesStatus === "completed" && roles.length === 0 && (
          <EmptyState title={t["editor.step1.faces.emptyTitle"]} description={t["editor.step1.faces.emptyDesc"]} iconType="user" size="sm" />
        )}
      </CollapsibleCard>
    </div>
  );
};
