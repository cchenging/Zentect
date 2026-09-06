// Module: pipeline/step5-match - View
// 纯 Props 组件：镜头匹配卡片列表 + 拖拽排序 + 替换弹窗 + 成品预览弹窗（视频+配音+台词）

import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, RefreshCw, Film, X, Play, Pause, Volume2, VolumeX, Music, Music2, Upload, Trash2, Sparkles, Loader2, Copy, Search, Clock, FileText, Heart, ListMusic, Download, ListPlus, AlertTriangle } from "lucide-react";
import { getSafeMediaUrl } from "@renderer/utils/formatUrl";
import { Badge, StatHeader, EmptyState } from "@renderer/components/shared";
import { DragReorderList } from "@renderer/components/shared/drag-reorder-list";
import { API } from "@renderer/api";
import { AppNotifier } from "@renderer/core/AppNotifier";
import type { StepShotMatchingProps } from "../types";
import { useStep5Store } from "../../stores/useStep5Store";
import type { BgmTrack, BgmRecommendation } from "../../stores/useStep5Store";

/** 时长毫秒 → 整数秒文案（去掉小数点，如 3500ms → "4s"） */
const formatIntSeconds = (ms?: number | null): string => {
  if (!ms || ms <= 0) return "";
  return `${Math.round(ms / 1000)}s`;
};

/** 时长毫秒 → 分:秒（如 214000ms → "3:34"） */
const formatDuration = (ms?: number | null): string => {
  if (!ms || ms <= 0) return "--:--";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

/**
 * 替换面板单格（2026-09-05）：封面优先；封面缺失或加载失败时回退"编号+源时间窗+时长"文字占位，
 * 杜绝"空黑框盲选"。已由其它段落占用的镜头显示右上角"已用 N"计数。
 * 每格底部固定显示「名称 + 源时间窗 + 时长」，即使封面因缓存/加载问题为黑也可辨识选择。
 * 封面渲染与主卡片 100% 同构：绝对路径 coverPath → getSafeMediaUrl → magic://local/... → <img>。
 * 主卡片已验证该链路在此应用正常上屏；不再走 data URL/IPC 通道（曾引入二次解码变量）。
 * @param chunk   镜头级切片（videoChunks 元素，含 parentChunkId=scene_XXX 用于归并命中）
 * @param usedCount 该镜头当前被多少个匹配段占用（0 不显示角标）
 * @param onPick   点击选中回调
 */
function ChunkPoolTile({ chunk, usedCount, onPick }: { chunk: any; usedCount: number; onPick: () => void }) {
  // 🔧 封面与主卡片同源：coverPath(绝对路径) → getSafeMediaUrl → magic://（已验证能上屏）
  const coverSrc = chunk.coverPath || chunk.thumbnail ? getSafeMediaUrl(chunk.coverPath || chunk.thumbnail) : "";
  const startMs = typeof chunk.startMs === 'number' ? chunk.startMs : null;
  const endMs = typeof chunk.endMs === 'number' ? chunk.endMs : startMs;
  return (
    <div onClick={onPick} className="cursor-pointer border border-border hover:border-accent rounded-lg overflow-hidden transition-all bg-bg-secondary p-1.5 flex flex-col gap-1">
      <div className="w-full aspect-video rounded bg-black overflow-hidden relative">
        {coverSrc ? (
          <img
            src={coverSrc}
            className="w-full h-full object-cover"
            alt=""
            draggable={false}
            decoding="async"
            onError={() => console.error('[替换弹窗] <img> magic:// 封面加载失败', coverSrc)}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1 px-1.5 text-center">
            <Film size={20} className="text-muted-foreground/30 shrink-0" />
            <span className="text-[11px] text-muted-foreground leading-tight break-all line-clamp-2" title={`coverPath=${chunk.coverPath || '(空)'}`}>{chunk.name || chunk.id || "片段"}</span>
          </div>
        )}
        {usedCount > 0 && (
          <span className="absolute top-1 left-1 bg-accent/90 px-1.5 py-0.5 rounded text-[10px] text-white font-medium">已用 {usedCount}</span>
        )}
        {startMs != null && endMs != null && (
          <span className="absolute bottom-1 right-1 bg-black/80 px-1 text-[11px] text-white font-mono rounded">{formatDuration(endMs - startMs)}</span>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="text-[12px] font-medium truncate px-1 text-center">{chunk.name || chunk.id || "片段"}</div>
        {startMs != null && endMs != null && (
          <div className="text-[10px] text-muted-foreground/75 font-mono text-center truncate px-1">
            源 {formatDuration(startMs)}–{formatDuration(endMs)} · {formatIntSeconds(endMs - startMs)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 替换面板每次滚动追加渲染的格子数。
 * 🔧 2026-09-06 根因修复：单张封面是 1920×1080 全尺寸大图（daemon 直接抽源视频帧），
 *   解码后每张约 8MB 显存纹理，24 张/批 ≈ 200MB 同时驻留 GPU，直接触发合成过载——
 *   图片虽已解码成功（naturalWidth=1920）但位图上屏为黑（"只看到镜头号文案"的真相）。
 *   主卡片仅 5 张故不受影响；弹窗一次 24 张必然黑。降到 6 张/批（约 50MB，安全水位），
 *   配合滚动分批追加 + decoding=async 异步解码，杜绝 GPU 纹理瞬时峰值。
 */
const REPLACE_PAGE_SIZE = 6;

/** 卡点契合度 → 示意条宽度百分比（对齐原型 fit-fill：默认 80 / .med 60 / .high 92） */
const beatFitPct = (fit?: string): number => {
  const v = (fit || '').trim().toLowerCase();
  if (v.includes('高') || v === 'high') return 92;
  if (v.includes('低') || v === 'low') return 60;
  return 80; // 中/默认
};

/** 卡点契合度是否为高档（高档示意条使用主题 accent 渐变，其余用 cyan 渐变） */
const beatFitHigh = (fit?: string): boolean => {
  const v = (fit || '').trim().toLowerCase();
  return v.includes('高') || v === 'high';
};

/** 默认推荐占位：未生成前的空推荐（不硬编码曲目，全部由 AI 生成） */
const EMPTY_RECOMMENDATION: BgmRecommendation = {
  toneLabel: '',
  toneDesc: '',
  tracks: [],
};

/** 本地曲库分类标签页 */
const LOCAL_TONE_TABS = [
  { value: 'all', label: '全部' },
  { value: 'neutral', label: '中性' },
  { value: 'emotional', label: '情感' },
  { value: 'suspense', label: '悬疑' },
  { value: 'epic', label: '史诗' },
  { value: 'comedy', label: '喜剧' },
];
/** 本地曲库每页展示数量 */
const LOCAL_PAGE_SIZE = 6;

/** ---------- BGM 原型还原 · 文件级样式常量 ---------- */
/** 徽章基础样式：对齐 step5-bgm-prototype 的 CSS 徽章 */
const bgmBadgeBase = "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold leading-none whitespace-nowrap";
const bgmBadgeAccent = `${bgmBadgeBase} bg-accent/15 text-accent border border-accent/30`;
const bgmBadgeSuccess = `${bgmBadgeBase} bg-accent-green/15 text-accent-green border border-accent-green/30`;
const bgmBadgeWarm = `${bgmBadgeBase} bg-amber-500/15 text-amber-400 border border-amber-500/30`;
const bgmBadgeCyan = `${bgmBadgeBase} bg-cyan-500/10 text-[#00e5ff] border border-cyan-500/30`;
const bgmBadgeMuted = `${bgmBadgeBase} bg-bg-secondary/70 text-muted-foreground border border-border`;
/** 情绪基调枚举 → 中文徽章文案（hero 横幅情绪徽章） */
const EMOTION_TONE_ZH: Record<string, string> = {
  neutral: "中性", emotional: "情感", suspense: "悬疑", epic: "史诗",
  comedy: "喜剧", happy: "欢快", warm: "温暖", sad: "伤感", calm: "平静", action: "热血",
};

/** 曲库封面 6 色渐变轮换（对齐原型 .cover.c1–c6，135° 渐变、圆形呈现） */
const BGM_COVER_GRADIENTS = [
  "from-[#6366f1] to-[#8b5cf6]", "from-[#00e5ff] to-[#6366f1]", "from-[#f59e0b] to-[#e11d48]",
  "from-[#22c55e] to-[#00e5ff]", "from-[#e11d48] to-[#f59e0b]", "from-[#8b5cf6] to-[#00e5ff]",
];

/** 原型 .eq 均衡器动画（4 根跳动竖条，播放中显示） */
const EqBars: React.FC = () => (
  <span className="eq shrink-0" aria-hidden="true"><i /><i /><i /><i /></span>
);

export const StepShotMatchingView: React.FC<StepShotMatchingProps> = ({
  matchResults, videoChunks, mediaItems, ttsResults, hasBgm, isProcessing,
  activeBgm, scriptParagraphs, emotionTone, frameEmotions, shotTypes, videoDurationMs, bgmOptions,
  onSetBgm, onRemoveBgm, onUploadBgm,
  onConfirm, onReplace, onRematch, onClearCacheAndRematch, onReorder,
}) => {
  /** 🔧 2026-09-05：「清空切片缓存」二次确认态（armed 后 3s 未点自动复位，防误触触发 80s 重切） */
  const [clearCacheArmed, setClearCacheArmed] = useState(false);
  useEffect(() => {
    if (!clearCacheArmed) return;
    const t = setTimeout(() => setClearCacheArmed(false), 3000);
    return () => clearTimeout(t);
  }, [clearCacheArmed]);
  /** ---------- BGM 原型还原 · 面板级试听播放条 ---------- */
  /** 当前试听中的本地曲目（AI 推荐无 URL 不参与试听；未选择时为 null） */
  const [playingTrack, setPlayingTrack] = useState<BgmTrack | null>(null);
  const [playCur, setPlayCur] = useState(0);
  const [playDur, setPlayDur] = useState(0);
  /** 是否处于暂停态（audio play/pause 事件驱动，保证卡片/播放条图标与实际播放状态一致） */
  const [playPaused, setPlayPaused] = useState(false);
  const playerAudioRef = useRef<HTMLAudioElement | null>(null);
  /** 「找歌」已复制的曲名（反馈 1.6s） */
  const [copiedBgm, setCopiedBgm] = useState("");
  const playPct = playDur > 0 ? Math.min(100, (playCur / playDur) * 100) : 0;
  /** 播放条是否处于活跃播放态（有曲目且未暂停） */
  const isPlayerActive = !!playingTrack && !playPaused;
  /** 解说词段数（顶部信息） */
  const narrationCount = scriptParagraphs.filter((p: any) => p.type === "narration").length;
  /** 试听/暂停：统一走面板底部播放条（切曲目时换源续播） */
  const toggleBgmPreview = useCallback((t: BgmTrack) => {
    const a = playerAudioRef.current;
    const src = t.previewUrl ? getSafeMediaUrl(t.previewUrl) : "";
    if (!src || !a) return;
    if (playingTrack && playingTrack.libraryId === t.libraryId) {
      if (!a.paused) { a.pause(); } else { a.play().catch(() => {}); }
      return;
    }
    setPlayingTrack(t);
    setPlayCur(0);
    setPlayDur(0);
    requestAnimationFrame(() => { a.play().catch(() => {}); });
  }, [playingTrack]);
  /** 播放条进度 seek（点击进度条跳转） */
  const seekPlayer = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = playerAudioRef.current;
    if (!a || !playingTrack) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (a.duration > 0 && Number.isFinite(a.duration)) {
      a.currentTime = ratio * a.duration;
      setPlayCur(a.currentTime);
    }
  }, [playingTrack]);
  const handlePlayerTime = useCallback(() => {
    const a = playerAudioRef.current;
    if (a) setPlayCur(a.currentTime);
  }, []);
  const handlePlayerLoaded = useCallback(() => {
    const a = playerAudioRef.current;
    if (a && Number.isFinite(a.duration)) setPlayDur(a.duration);
  }, []);
  const handlePlayerEnded = useCallback(() => {
    const a = playerAudioRef.current;
    if (a) a.currentTime = 0;
    setPlayCur(0);
    setPlayDur(0);
    setPlayingTrack(null);
  }, []);
  /** 找歌：复制「曲名 + 歌手」到剪贴板，请到音乐平台自行搜索（AI 推荐不提供试听/下载） */
  const handleFindSong = useCallback(async (t: any) => {
    const text = `${t.name}${t.artist ? " " + t.artist : ""}`;
    const curName = t.name || "";
    setCopiedBgm(curName);
    const done = () => setTimeout(() => setCopiedBgm((c) => (c === curName ? "" : c)), 1600);
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch { /* 忽略 */ }
      document.body.removeChild(ta);
    }
  }, []);

  const [replacingShotId, setReplacingShotId] = useState<string | null>(null);
  /** 预览弹窗状态：当前预览的 shotId + 播放/暂停 */
  const [previewShotId, setPreviewShotId] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  /** 复制文案成功反馈：记录当前已复制的 shotId（1.5s 后复位） */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** 替换弹窗分批渲染：当前已加载的批数（打开时重置为 1，滚动到底部追加） */
  const [poolPage, setPoolPage] = useState(1);
  /** 底部加载哨兵 ref（列表末尾占位元素，始终渲染） */
  const poolSentinelRef = useRef<HTMLDivElement | null>(null);

  const chunkPool = useMemo(() => {
    return videoChunks.length > 0 ? videoChunks : mediaItems.filter((m) => m.type === "video_chunk" || m.type === "frame");
  }, [videoChunks, mediaItems]);

  // 🔧 每次打开替换弹窗都从第一页开始渲染，避免残留上一轮的滚动加载进度
  useEffect(() => {
    if (replacingShotId) setPoolPage(1);
  }, [replacingShotId]);

  // 🔧 2026-09-06 修复「不能下滑」：REPLACE_PAGE_SIZE 降到 6 后首批内容不满容器高度，
  //   改用 IntersectionObserver 以默认视口为 root 监听底部哨兵，哨兵进入视口（提前 200px）即追加下一批。
  //   不依赖滚动容器高度（flex 子项 min-h-0 缺失时容器高度会塌缩），从根上规避"无滚动条就不触发"。
  useEffect(() => {
    if (!replacingShotId) return;
    const sentinel = poolSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPoolPage((p) => (chunkPool.length > p * REPLACE_PAGE_SIZE ? p + 1 : p));
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [replacingShotId, chunkPool.length]);

  /** 替换面板"已用"角标：按 parentChunkId(scene_XXX) 归并各镜头当前被多少个匹配段占用 */
  const usedChunkCount = useMemo(() => {
    const cnt = new Map<string, number>();
    for (const it of matchResults) {
      if (it.id === replacingShotId) continue;
      const pid = (it.chunkData as any)?.parentChunkId;
      if (!pid) continue;
      cnt.set(String(pid), (cnt.get(String(pid)) || 0) + 1);
    }
    return cnt;
  }, [matchResults, replacingShotId]);

  /** AI 深度推荐状态：LLM 依据文案语义生成的推荐（提升到 useStep5Store，随快照落盘不丢失） */
  const deepRecommendation = useStep5Store((s) => s.deepRecommendation);
  const setDeepRecommendation = useStep5Store((s) => s.setDeepRecommendation);
  /** 最近一次匹配诊断（后端根因提示：切片池空 / 全未命中 / 原声定位失败），有 warnings 时显示黄条 */
  const matchDiagnostics = useStep5Store((s) => s.matchDiagnostics);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepError, setDeepError] = useState('');
  /** 一键应用：正在下载的曲目 key（用于按钮 loading 态） */
  const [applyingTrackKey, setApplyingTrackKey] = useState<string | null>(null);
  /** 一键应用失败提示 */
  const [applyError, setApplyError] = useState('');

  /** 本地曲库：分类分页自选 */
  const [localTracks, setLocalTracks] = useState<BgmTrack[]>([]);
  const [localTone, setLocalTone] = useState('all');
  const [localPage, setLocalPage] = useState(0);
  const [localSearch, setLocalSearch] = useState('');
  const [localLoading, setLocalLoading] = useState(false);

  /** 加载本地曲库全量列表（分类分页自选） */
  const loadLocalLibrary = useCallback(async () => {
    setLocalLoading(true);
    try {
      const res: any = await API.ai.bgmLocalList();
      if (res && (res as any).success === false) return;
      const data = (res as any)?.data;
      if (Array.isArray(data)) {
        setLocalTracks(data.map((t: any) => ({
          name: t.name,
          artist: t.artist,
          mood: (t.tags || []).join(','),
          source: `本地曲库 · ${t.license || '免费商用'}`,
          beatFit: '中',
          bpm: t.bpm,
          durationMs: t.durationMs,
          previewUrl: t.previewUrl,
          downloadUrl: t.downloadUrl,
          libraryId: t.id,
        })));
      }
    } catch { /* 忽略 */ } finally {
      setLocalLoading(false);
    }
  }, []);

  useEffect(() => { loadLocalLibrary(); }, [loadLocalLibrary]);

  /** 按分类过滤 + 关键词搜索（name/artist/mood）+ 分页 */
  const filteredLocalTracks = useMemo(() => {
    let list = localTone === 'all' ? localTracks : localTracks.filter((t) => (t.mood || '').includes(localTone));
    const kw = localSearch.trim().toLowerCase();
    if (kw) {
      list = list.filter((t) =>
        (t.name || '').toLowerCase().includes(kw) ||
        (t.artist || '').toLowerCase().includes(kw) ||
        (t.mood || '').toLowerCase().includes(kw)
      );
    }
    return list;
  }, [localTracks, localTone, localSearch]);
  const localTotalPages = Math.max(1, Math.ceil(filteredLocalTracks.length / LOCAL_PAGE_SIZE));
  const pageLocalTracks = useMemo(() => {
    const start = localPage * LOCAL_PAGE_SIZE;
    return filteredLocalTracks.slice(start, start + LOCAL_PAGE_SIZE);
  }, [filteredLocalTracks, localPage]);

  /** 当前展示的推荐：AI 生成结果优先，未生成时为占位空对象 */
  const currentRecommendation = deepRecommendation || EMPTY_RECOMMENDATION;
  /** hero 聚合统计：从 AI 推荐计算 BPM 区间与卡点强度 */
  const recTracks = currentRecommendation.tracks || [];
  const heroStats = (() => {
    const bpms = recTracks.map((t: any) => Number(t.bpm)).filter((n: number) => n > 0);
    const fits = recTracks.map((t: any) => String(t.beatFit || "").trim()).filter(Boolean);
    const highFits = fits.filter((f) => f.includes("高")).length;
    const beatStrength = fits.length ? (highFits >= Math.ceil(fits.length / 2) ? "强" : "中") : "中";
    return {
      bpmMin: bpms.length ? Math.min(...bpms) : 0,
      bpmMax: bpms.length ? Math.max(...bpms) : 0,
      beatStrength,
    };
  })();

  /** 调用后端 LLM 生成深度 BGM 推荐 */
  const handleDeepRecommend = useCallback(async () => {
    setDeepLoading(true);
    setDeepError('');
    try {
      const payload = {
        // 判别联合收窄：text 仅存在于解说段，BGM 语义推荐只消费解说词文本
        scriptParagraphs: scriptParagraphs.flatMap((p) => (p.type === 'narration' && p.text ? [p.text] : [])),
        emotionTone,
        frameEmotions,
        shotTypes,
        videoDurationMs,
      };
      const res: any = await API.ai.recommendBgm(payload);
      // 后端明确失败（配置缺失 / LLM 调用异常）→ 透传真实原因，而非笼统提示
      if (res && (res as any).success === false) {
        setDeepError((res as any).error || 'AI 深度推荐失败');
        return;
      }
      const data = (res as any)?.data;
      if (data && Array.isArray(data.tracks) && data.tracks.length > 0) {
        setDeepRecommendation({ ...data });
      } else {
        /** 解析退化（LLM 有响应但结构异常）时给出针对性提示，并尽量带出原始内容片段 */
        const hasRaw = typeof (res as any)?.raw === 'string' && (res as any).raw.length > 0;
        setDeepError(hasRaw ? 'AI 已返回内容但格式无法解析，请重试或换个模型' : 'AI 未能生成有效推荐，请确认 LLM 通道可用后重试');
      }
    } catch (e: any) {
      setDeepError(e?.message || 'AI 深度推荐失败');
    } finally {
      setDeepLoading(false);
    }
  }, [scriptParagraphs, emotionTone, frameEmotions, shotTypes, videoDurationMs]);

  const handleReplaceSelect = (shotId: string, chunk: any) => {
    onReplace(shotId, chunk);
    setReplacingShotId(null);
  };

  /** 复制文案到剪贴板（navigator.clipboard 优先，不可用时回退 textarea 选择复制），带 1.5s 成功反馈 */
  const handleCopyText = useCallback(async (text: string | undefined, id: string) => {
    if (!text) return;
    const done = () => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    };
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch { /* 忽略 */ }
      document.body.removeChild(ta);
    }
  }, []);

  /** 曲目唯一 key：libraryId 优先，退化为 name+artist */
  const trackKey = (t: BgmTrack) => `${t.libraryId || ''}|${t.name}|${t.artist}`;

  /** P1 一键应用：下载曲目到本地缓存 → onSetBgm 携带 bpm 应用 */
  const handleApplyBgm = useCallback(async (t: BgmTrack) => {
    const key = trackKey(t);
    setApplyingTrackKey(key);
    setApplyError('');
    try {
      const res: any = await API.ai.bgmDownload({
        downloadUrl: t.downloadUrl,
        libraryId: t.libraryId,
        name: t.name,
      });
      if (!res || (res as any).success === false) {
        setApplyError((res as any)?.error || 'BGM 下载失败');
        return;
      }
      const filePath = (res as any)?.filePath;
      if (!filePath) {
        setApplyError('下载成功但未返回本地路径');
        return;
      }
      onSetBgm({ id: t.libraryId || filePath, filePath, name: t.name, bpm: t.bpm });
    } catch (e: any) {
      setApplyError(e?.message || 'BGM 下载失败');
    } finally {
      setApplyingTrackKey(null);
    }
  }, [onSetBgm]);

  /** 当前预览的匹配项、切片、配音音频 */
  const previewMatch = useMemo(
    () => matchResults.find((m) => m.id === previewShotId) || null,
    [matchResults, previewShotId],
  );
  const previewChunk = (previewMatch?.chunkData as any) || null;
  /** 原声段落不走 TTS：音频来自切片视频自带原声轨，不额外找配音 */
  const isOriginalAudio = previewMatch?.keepOriginalAudio === true;
  /** 🔧 预览素材与坐标同源（2026-09-05 模式 A）：候选切片坐标与其 filePath 恒为同一文件参照——
   *  普通段：素材 = 命中切片自身（新数据 filePath=源视频 + 源坐标；老数据 body 文件 + body 坐标，各自同源自洽），
   *  预览起点 = chunkData.startMs（相对该素材），画面即命中切片，**不做任何 body/源 坐标系猜测**；
   *  原声段：素材恒为源视频，起点 = videoTimeline（=audioSource 源坐标台词窗），从台词窗开始播放原片原声。 */
  const primaryVideoPathRaw = String((mediaItems as any[])?.[0]?.filePath || '');
  /** 🔧 2026-09-05 预览素材准入：只有命中切片（chunkData 非空）才加载视频素材——
   *  未命中段（KM 变速超限重选耗尽/原声定位失败且语义未命中）没有可播画面，绝不回退到
   *  「源视频 + 起点 0」从片头空播。普通段素材=命中切片自身 filePath；原声段=源视频+台词窗。 */
  const hasMatchedChunk = !!previewChunk;
  const previewVideoPath = isOriginalAudio
    ? (hasMatchedChunk ? primaryVideoPathRaw : '')
    : (hasMatchedChunk ? (previewChunk?.filePath || primaryVideoPathRaw) : '');
  const previewVideoUrl = previewVideoPath ? getSafeMediaUrl(previewVideoPath) : "";
  /** 🎬 起点/终点（2026-09-05 B6：去掉普通段的 videoTimeline 坐标猜测回退）——
   *  普通段素材=命中切片自身，起点必须= chunkData.startMs（同源直取）；videoTimeline 是流程时间轴
   *  （累计解说线），绝不是画面起点，回退它=把播放 seek 到错误画面。
   *  原声段素材=源视频，起点=videoTimeline（=audioSource 源坐标台词窗），原声正确用。 */
  const previewStartMs = isOriginalAudio
    ? (previewMatch?.videoTimelineStartMs ?? previewChunk?.startMs ?? 0)
    : (previewChunk?.startMs ?? 0);
  const previewEndMs = isOriginalAudio
    ? (previewMatch?.videoTimelineEndMs ?? previewChunk?.endMs ?? 0)
    : (previewChunk?.endMs ?? 0);
  /** ✅ 身份键统一：TTS 产物 id 与 MatchResult id / 段落主键同源，按 id 对齐 */
  const previewTts = isOriginalAudio ? undefined : ttsResults.find((t) => t.id === previewShotId);
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
        /** 当前时间不在切片时间窗内（开头/播完），先 seek 到切片起点；
         *  🔧 2026-09-05：仅在 metadata 已就绪（readyState≥1）时设 currentTime，
         *  否则赋值为无效等待（可能被忽略→从 0 播），依赖 onLoadedMetadata 统一定位。 */
        if (v.readyState >= 1) {
          if (v.currentTime < startSec - 0.3 || (endSec > 0 && v.currentTime >= endSec)) {
            v.currentTime = startSec;
          }
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

  /** 🔧 2026-09-05 清空切片缓存：未确认 → 进入红态 armed（3s 自动复位）；
   *  已 armed → 清空当前视频切片缓存并强制重切重匹配（提示文案已说明会耗时重切） */
  const handleClearCacheClick = useCallback(() => {
    if (clearCacheArmed) {
      setClearCacheArmed(false);
      onClearCacheAndRematch?.();
    } else {
      setClearCacheArmed(true);
    }
  }, [clearCacheArmed, onClearCacheAndRematch]);

  return (
    <div className="flex flex-col gap-4">
      {/* 🎵 BGM 设置面板 · 按 step5-bgm-prototype 原型 1:1 还原 */}
      <div className="glass-card-sm p-4 flex flex-col gap-4">
        {/* 面板顶部：标题 + 视频信息 */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded bg-gradient-to-br from-accent to-accent-purple" />
            <div className="flex items-center gap-1.5 text-[14px] font-semibold">
              <Music size={14} className="text-accent" /> BGM 背景音乐
              {activeBgm && <span className={bgmBadgeSuccess}>已选</span>}
            </div>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><Clock size={11} /> 视频时长 {formatDuration(videoDurationMs)}</span>
            <span className="flex items-center gap-1"><FileText size={11} /> 解说词 {narrationCount} 段</span>
          </div>
        </div>

        {/* 当前 BGM 芯片 + 移除 */}
        <div className="flex items-center gap-2 flex-wrap">
          {activeBgm ? (
            <>
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-accent-green/15 text-accent-green border border-accent-green/30 text-[12px] truncate max-w-[340px]" title={activeBgm.filePath}>
                <Music2 size={12} /> {activeBgm.name || activeBgm.filePath}
              </span>
              <button onClick={onRemoveBgm} disabled={isProcessing}
                className="flex items-center gap-1 px-2 py-1 text-[12px] text-accent-rose hover:bg-accent-rose/10 rounded transition-all cursor-pointer disabled:opacity-50">
                <Trash2 size={12} /> 移除
              </button>
            </>
          ) : (
            <div className="text-[12px] text-muted-foreground">未选择 BGM，画面切换将不卡音乐节奏</div>
          )}
        </div>

        {/* 模式说明：AI 仅输出智能清单（不附带下载），搜索下载后上传导入 */}
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ListMusic size={12} className="text-accent/70 shrink-0" />
          <span>AI 仅输出「歌名 + 歌手 + 来源」智能清单：在音乐平台搜索下载后，通过「上传本地BGM」导入即可</span>
        </div>

        {/* ① AI 深度推荐区 */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              <Sparkles size={13} className="text-accent" /> 个性化推荐
              <span className="text-muted-foreground font-normal text-[11px]">
                {deepRecommendation && !!deepRecommendation.tracks?.length ? "（AI 深度 · 依据文案语义）" : "（点击生成）"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {deepRecommendation && !!deepRecommendation.tracks?.length ? (
                <span className={bgmBadgeAccent}>{deepRecommendation.tracks.length} 首推荐</span>
              ) : null}
              <button onClick={handleDeepRecommend} disabled={deepLoading || isProcessing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-accent text-accent-foreground hover:opacity-90 rounded-md transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-sm">
                {deepLoading
                  ? <><Loader2 size={12} className="animate-spin" /> 生成中...</>
                  : <><Sparkles size={12} /> {deepRecommendation?.tracks?.length ? "重新AI推荐" : "AI 深度推荐"}</>}
              </button>
            </div>
          </div>

          {deepError && (
            <div className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-md bg-accent-rose/10 border border-accent-rose/30 text-accent-rose text-[12px]">
              <X size={13} className="mt-0.5 shrink-0" />
              <span>AI 深度推荐失败：{deepError}</span>
            </div>
          )}

          {!!currentRecommendation.tracks?.length ? (
            <>
              {/* 情绪基调 hero 横幅 + 聚合统计 */}
              {(currentRecommendation.toneLabel || currentRecommendation.toneDesc) && (
                <div className="relative overflow-hidden rounded-xl border border-accent/25 px-4 py-3 flex items-center gap-3 flex-wrap bg-gradient-to-r from-accent/15 via-accent-purple/10 to-accent-rose/15">
                  <div className="absolute -right-6 -top-8 w-24 h-24 rounded-full bg-accent/15 blur-2xl pointer-events-none" />
                  <div className="absolute -left-4 -bottom-10 w-28 h-24 rounded-full bg-cyan-500/15 blur-2xl pointer-events-none" />
                  <div className="hero-tone w-[52px] h-[52px] rounded-full shrink-0 flex items-center justify-center text-white bg-gradient-to-br from-accent to-accent-rose shadow-[0_0_24px_rgba(225,29,72,0.35)]">
                    <Heart size={22} />
                  </div>
                  <div className="hero-info flex-1 min-w-[220px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={bgmBadgeWarm}>{EMOTION_TONE_ZH[emotionTone] || currentRecommendation.toneLabel || "情感向"}</span>
                      {currentRecommendation.toneLabel && (
                        <span className="text-[13px] font-semibold text-foreground">情绪基调 · {currentRecommendation.toneLabel}</span>
                      )}
                    </div>
                    {currentRecommendation.toneDesc && (
                      <div className="text-[11px] leading-relaxed text-muted-foreground mt-1">{currentRecommendation.toneDesc}</div>
                    )}
                  </div>
                  <div className="hero-stats flex items-center gap-2 flex-wrap">
                    {heroStats.bpmMin > 0 && heroStats.bpmMax > 0 && (
                      <span className={bgmBadgeCyan}>推荐 BPM {heroStats.bpmMin}–{heroStats.bpmMax}</span>
                    )}
                    <span className={bgmBadgeCyan}>卡点强度 {heroStats.beatStrength}</span>
                  </div>
                </div>
              )}

              {/* 推荐卡片网格（t-no / 曲名 / 歌手+来源 / 卡点·BPM·时长 / 契合度条 / 找歌）
                  容器查询自适应：原型三列按 1240px 页面设计，本软件步骤内容区实测约 738px，
                  故 ≥680px 时两列（单卡约 363px，最接近原型单卡观感），更窄自动退一列 */}
              <div className="@container">
                <div className="grid grid-cols-1 @[680px]:grid-cols-2 gap-3">
                {currentRecommendation.tracks.map((t, i) => (
                  <div key={`${t.name}-${i}`} className="bgm-track-card relative border border-border rounded-[14px] p-3.5 flex flex-col gap-2.5 hover:border-accent/45 hover:-translate-y-0.5 hover:shadow-[var(--glow-accent)] transition-all">
                    <span className="absolute top-2.5 right-3 text-[13px] font-bold text-foreground/10 select-none">0{i + 1}</span>
                    <div className="text-[14px] font-semibold truncate pr-[26px]" title={t.name}>{t.name}</div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {t.mood ? <span className={bgmBadgeWarm}>{t.mood}</span> : null}
                      <span className="text-[11px] text-muted-foreground truncate">{t.artist} · {t.source}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={bgmBadgeSuccess}>卡点 {t.beatFit || "中"}</span>
                      {t.bpm ? <span className={bgmBadgeMuted}>{t.bpm} BPM</span> : null}
                      <span className={bgmBadgeMuted}>{formatDuration(t.durationMs)}</span>
                    </div>
                    {/* 卡点契合度示意条（对齐原型 .t-fit：间距 12px；高档 accent 渐变，其余 cyan 渐变） */}
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[10px] text-muted-foreground shrink-0">卡点契合</span>
                      <div className="flex-1 h-1 rounded-full bg-border/70 overflow-hidden" title={`卡点契合度：${t.beatFit}`}>
                        <div className={`h-full rounded-full ${beatFitHigh(t.beatFit) ? "bg-gradient-to-r from-accent to-accent-purple" : "bg-gradient-to-r from-accent to-[#00e5ff]"}`} style={{ width: `${beatFitPct(t.beatFit)}%` }} />
                      </div>
                    </div>
                    {/* 动作区：试听（AI 无音源禁用）+ 找歌 + 应用 */}
                    <div className="mt-auto pt-1 flex items-center gap-2">
                      <button type="button" disabled
                        className="w-[30px] h-[30px] rounded-full flex items-center justify-center shrink-0 bg-bg-secondary/80 text-muted-foreground/50 cursor-not-allowed transition-all"
                        title="AI 推荐暂无试听音源">
                        <Play size={12} className="ml-0.5" />
                      </button>
                      <button onClick={() => handleFindSong(t)}
                        className="flex items-center justify-center gap-1.5 flex-1 px-2 py-1.5 text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent hover:text-accent-foreground rounded-lg transition-all cursor-pointer">
                        {copiedBgm === t.name ? <><Check size={12} /> 已复制</> : <><Search size={12} /> 找歌</>}
                      </button>
                      <button type="button"
                        onClick={() => { handleFindSong(t); AppNotifier.info("已复制曲目信息：请在音乐平台搜索下载后，通过「上传本地BGM」导入使用"); }}
                        className="flex items-center justify-center gap-1.5 flex-1 px-3 py-1.5 text-[11px] font-semibold text-white bg-gradient-to-r from-accent to-accent-purple rounded-lg shadow-[var(--glow-accent)] hover:brightness-110 transition-all cursor-pointer">
                        <ListPlus size={12} /> 应用
                      </button>
                    </div>
                  </div>
                ))}
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground">以上为全网搜索推荐，点击「找歌」复制曲目后请到音乐平台自行搜索下载上传</div>
            </>
          ) : !deepLoading && (
            <div className="text-[12px] text-muted-foreground">点击「AI 深度推荐」，将依据解说文案语义生成全网选曲建议</div>
          )}
        </div>

        {/* ② 本地曲库区 */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              <Music2 size={13} className="text-accent" /> 本地曲库
              <span className="text-muted-foreground font-normal text-[11px]">（{localTracks.length} 首 · 免费商用）</span>
            </div>
            <button onClick={onUploadBgm} disabled={isProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-bg-secondary/80 rounded-md transition-all cursor-pointer disabled:opacity-50">
              <ListPlus size={12} /> 导入曲库
            </button>
          </div>

          {/* 搜索 + 分类 tabs（带计数角标） */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-[340px]">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
              <input
                value={localSearch}
                onChange={(e) => { setLocalSearch(e.target.value); setLocalPage(0); }}
                placeholder="搜索曲名 / 歌手 / 情绪"
                className="w-full pl-8 pr-8 py-1.5 text-[12px] bg-bg-secondary/50 border border-border rounded-md outline-none placeholder:text-muted-foreground/50 focus:border-accent/60 focus:ring-1 focus:ring-accent/30 transition-all"
              />
              {localSearch && (
                <button onClick={() => { setLocalSearch(""); setLocalPage(0); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer" aria-label="清空搜索">
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {LOCAL_TONE_TABS.map((tab) => {
                const cnt = tab.value === "all" ? localTracks.length : localTracks.filter((t) => (t.mood || "").includes(tab.value)).length;
                return (
                  <button key={tab.value}
                    onClick={() => { setLocalTone(tab.value); setLocalPage(0); }}
                    className={`flex items-center gap-1 px-2.5 py-1 text-[12px] rounded-full border transition-all cursor-pointer ${
                      localTone === tab.value
                        ? "bg-accent/15 text-accent border-accent/35"
                        : "bg-bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-bg-secondary/80 border-transparent"
                    }`}>
                    {tab.label}
                    <span className={`text-[10px] ${localTone === tab.value ? "text-accent/70" : "text-muted-foreground/50"}`}>{cnt}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 曲库网格 + 统计 + 分页 */}
          {applyError && (
            <div className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-md bg-accent-rose/10 border border-accent-rose/30 text-accent-rose text-[12px]">
              <X size={13} className="mt-0.5 shrink-0" />
              <span>BGM 下载失败：{applyError}</span>
            </div>
          )}
          {localLoading ? (
            <div className="text-[12px] text-muted-foreground flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> 加载中...</div>
          ) : pageLocalTracks.length > 0 ? (
            <>
              {/* 曲库网格：容器查询自适应（原型三列按 1240px 设计；本内容区约 738px → 两列，
                  单卡约 363px ≈ 原型单卡 407px 观感；拖窄左栏时 ≥880px 仍可三列） */}
              <div className="@container">
                <div className="grid grid-cols-1 @[560px]:grid-cols-2 @[880px]:grid-cols-3 gap-2.5">
                {pageLocalTracks.map((t, ci) => (
                  <div key={t.libraryId} className="flex items-center gap-3 rounded-[10px] border border-border px-3 py-2.5 bg-bg-secondary/50 hover:border-accent/40 hover:bg-bg-hover/60 hover:-translate-y-0.5 hover:shadow-md transition-all">
                    {/* 圆形渐变封面（对齐原型 .cover，6 色轮换） */}
                    <div className={`w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-white/95 bg-gradient-to-br ${BGM_COVER_GRADIENTS[ci % BGM_COVER_GRADIENTS.length]}`}>
                      <Music2 size={15} />
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      {/* 行1：曲名 + 播放中 EQ 动画 */}
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div className="text-[12px] font-semibold truncate" title={t.name}>{t.name}</div>
                        {playingTrack?.libraryId === t.libraryId && !playPaused && <EqBars />}
                      </div>
                      {/* 行2：歌手 · 本地曲库（对齐原型 lc-artist） */}
                      <div className="text-[10px] text-muted-foreground truncate">{t.artist} · 本地曲库</div>
                      {/* 行3：情绪 + BPM（绿色 success）+ 时长徽章（对齐原型 lc-meta） */}
                      <div className="flex items-center gap-1 flex-wrap">
                        {t.mood ? <span className={bgmBadgeWarm}>{t.mood.split(",")[0]}</span> : null}
                        {t.bpm ? <span className={bgmBadgeSuccess}>{t.bpm} BPM</span> : null}
                        <span className={bgmBadgeMuted}>{formatDuration(t.durationMs)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {t.previewUrl && (
                        <button type="button" onClick={() => toggleBgmPreview(t)}
                          className={`w-[30px] h-[30px] rounded-full flex items-center justify-center transition-all cursor-pointer ${
                            playingTrack?.libraryId === t.libraryId && !playPaused
                              ? "bg-gradient-to-r from-accent to-accent-purple text-white shadow-[var(--glow-accent)] ring-2 ring-accent/30"
                              : "bg-bg-tertiary/80 text-muted-foreground hover:text-accent hover:bg-bg-hover"
                          }`}
                          title={playingTrack?.libraryId === t.libraryId && !playPaused ? "暂停试听" : "试听"} aria-label="试听">
                          {playingTrack?.libraryId === t.libraryId && !playPaused ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
                        </button>
                      )}
                      <button type="button"
                        disabled={isProcessing || applyingTrackKey === trackKey(t)}
                        onClick={() => handleApplyBgm(t)}
                        className="flex items-center justify-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-white bg-gradient-to-r from-accent to-accent-purple rounded-md shadow-[var(--glow-accent)] hover:brightness-110 transition-all cursor-pointer disabled:opacity-50 disabled:hover:brightness-100 disabled:shadow-none">
                        {applyingTrackKey === trackKey(t) ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                        {applyingTrackKey === trackKey(t) ? "应用中" : "应用"}
                      </button>
                    </div>
                  </div>
                ))}
                </div>
              </div>
              <div className="flex flex-col items-center gap-2">
                <div className="text-[10px] text-muted-foreground">
                  {filteredLocalTracks.length > 0
                    ? `第 ${localPage * LOCAL_PAGE_SIZE + 1}–${Math.min((localPage + 1) * LOCAL_PAGE_SIZE, filteredLocalTracks.length)} 首 · 共 ${filteredLocalTracks.length} 首`
                    : ""}
                </div>
                {localTotalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => setLocalPage((pg) => Math.max(0, pg - 1))} disabled={localPage === 0}
                      className="min-w-7 h-7 flex items-center justify-center rounded-[7px] text-[12px] bg-bg-secondary text-muted-foreground hover:text-foreground transition-all cursor-pointer disabled:opacity-40">‹</button>
                    {Array.from({ length: localTotalPages }, (_, pi) => (
                      <button key={pi} onClick={() => setLocalPage(pi)}
                        className={`min-w-7 h-7 flex items-center justify-center rounded-[7px] text-[11px] transition-all cursor-pointer ${
                          localPage === pi
                            ? "bg-accent text-accent-foreground shadow-sm"
                            : "bg-bg-secondary text-muted-foreground hover:text-foreground hover:bg-bg-secondary/80"
                        }`}>{pi + 1}</button>
                    ))}
                    <button onClick={() => setLocalPage((pg) => Math.min(localTotalPages - 1, pg + 1))} disabled={localPage >= localTotalPages - 1}
                      className="min-w-7 h-7 flex items-center justify-center rounded-[7px] text-[12px] bg-bg-secondary text-muted-foreground hover:text-foreground transition-all cursor-pointer disabled:opacity-40">›</button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-[12px] text-muted-foreground">
              {localSearch.trim() ? `未找到匹配「${localSearch.trim()}」的曲目` : "本地曲库为空或加载失败"}
            </div>
          )}
        </div>

        {/* ③ 底部操作：上传本地 / 使用已分离伴奏 */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <button onClick={onUploadBgm} disabled={isProcessing}
            className="flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-medium bg-accent/10 text-accent border border-accent/25 hover:bg-accent/20 hover:border-accent/40 rounded-md transition-all cursor-pointer disabled:opacity-50">
            <Upload size={13} /> 上传本地BGM
          </button>
          {bgmOptions.map((m) => (
            <button key={m.id} onClick={() => onSetBgm({ id: m.id, filePath: (m as any).extractedBgm, name: (m as any).name || "伴奏" })} disabled={isProcessing}
              className="flex items-center gap-1.5 px-3 py-2 bg-bg-secondary text-muted-foreground hover:text-foreground rounded-md text-[12px] transition-all cursor-pointer disabled:opacity-50">
              <Music2 size={12} /> 用伴奏：{(m as any).name || "已分离伴奏"}
            </button>
          ))}
          <div className="text-[10px] text-muted-foreground ml-auto">选择 BGM 后自动重匹配，镜头切换吸附鼓点避免夹帧</div>
        </div>
        {bgmOptions.length === 0 && (
          <div className="text-[11px] text-muted-foreground">小提示：对原视频执行「音频分离」后，可在此直接选用分离出的纯伴奏作为 BGM</div>
        )}

        {/* 面板级试听播放条（还原原型 player：常驻深色玻璃条、渐变进度 + 白点滑块） */}
        <div className="rounded-xl bg-[rgba(10,10,30,0.85)] border border-white/10 px-3.5 py-2.5 flex items-center gap-3 text-white/90 shadow-lg">
          <button type="button" disabled={!playingTrack} onClick={() => playingTrack && toggleBgmPreview(playingTrack)}
            className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-all ${
              isPlayerActive
                ? "bg-gradient-to-r from-accent to-accent-purple text-white shadow-[var(--glow-accent)] cursor-pointer hover:brightness-110"
                : "bg-white/10 text-white/40"
            } ${playingTrack ? "cursor-pointer" : "cursor-not-allowed"}`}
            title={isPlayerActive ? "暂停" : playingTrack ? "继续播放" : "暂无试听曲目"}>
            {isPlayerActive ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
          </button>
          <div className={`text-[12px] font-medium truncate max-w-[220px] ${playingTrack ? "" : "text-white/40"}`} title={playingTrack?.name}>
            {playingTrack?.name ?? "点击本地曲库卡片的「试听」开始预览"}
          </div>
          {isPlayerActive && <EqBars />}
          <div className={`flex-1 h-1 rounded-full bg-white/15 overflow-visible cursor-pointer ${playingTrack ? "" : "pointer-events-none"}`} onClick={seekPlayer} title="点击跳转">
            <div className="relative h-full rounded-full bg-gradient-to-r from-accent to-[#00e5ff] after:content-[''] after:absolute after:-right-1 after:top-1/2 after:-translate-y-1/2 after:w-[7px] after:h-[7px] after:bg-white after:rounded-full after:shadow"
              style={{ width: `${playPct}%`, opacity: playingTrack ? 1 : 0 }} />
          </div>
          <span className="text-[11px] text-white/60 font-mono tabular-nums shrink-0">
            {playingTrack && playDur > 0
              ? `${Math.floor(playCur / 60)}:${String(Math.floor(playCur % 60)).padStart(2, "0")} / ${Math.floor(playDur / 60)}:${String(Math.floor(playDur % 60)).padStart(2, "0")}`
              : "--:-- / --:--"}
          </span>
        </div>
        {/* 播放条音频载体（隐藏 audio，源随 playingTrack 变化；无曲目/无 URL 时不挂 src，避免空字符串告警） */}
        <audio
          ref={playerAudioRef}
          src={playingTrack?.previewUrl ? getSafeMediaUrl(playingTrack.previewUrl) : undefined}
          preload="none"
          onTimeUpdate={handlePlayerTime}
          onLoadedMetadata={handlePlayerLoaded}
          onEnded={handlePlayerEnded}
          onPlay={() => setPlayPaused(false)}
          onPause={() => setPlayPaused(true)}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[14px] font-semibold flex items-center gap-1.5">
          <span>镜头匹配</span>
          {hasBgm && <Badge variant="success" className="flex items-center gap-0.5">BGM</Badge>}
        </div>
        <div className="flex items-center gap-3">
          {matchResults.length > 0 && (
            <StatHeader value={matchResults.length} unit="个镜头" secondary={`已确认 ${matchResults.filter((m) => m.confirmed).length}/${matchResults.length}`} />
          )}
          {typeof onClearCacheAndRematch === "function" && (
            <button onClick={handleClearCacheClick} disabled={isProcessing}
              title="删除当前视频的切片缓存并强制重新检测切片后匹配（需重新切片，约 80 秒；不破坏步骤1~4 结果）"
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[13px] font-medium border transition-all disabled:opacity-50 cursor-pointer ${
                clearCacheArmed
                  ? "border-red-500/60 bg-red-500/15 text-red-400"
                  : "border-border bg-bg-secondary/60 text-muted-foreground hover:text-foreground hover:border-border/80"
              }`}>
              <Trash2 size={12} className={clearCacheArmed ? "animate-pulse" : ""} />
              {clearCacheArmed ? "确认清空并重切？" : "清空切片缓存"}
            </button>
          )}
          <button onClick={onRematch} disabled={isProcessing}
            className="flex items-center gap-1.5 px-3 py-1 bg-accent text-accent-foreground rounded-md text-[13px] font-medium transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer">
            <RefreshCw size={12} className={isProcessing ? "animate-spin" : ""} />
            {isProcessing ? "匹配中..." : "重新匹配"}
          </button>
        </div>
      </div>
      {/* 🔧 匹配诊断警告条：后端 SemanticAnalyzeStrategy 透出的根因（切片池空/全未命中/原声定位失败），
          有 warnings 才显示；无异常时为空数组不渲染，避免干扰正常卡片区。 */}
      {matchDiagnostics && Array.isArray(matchDiagnostics.warnings) && matchDiagnostics.warnings.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-warning/10 border border-warning/30 text-[12.5px] leading-snug">
          <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1">
            {matchDiagnostics.warnings.map((w, i) => (
              <span key={i} className="text-warning">{w}</span>
            ))}
          </div>
        </div>
      )}
      {matchResults.length > 0 ? (
        <>
          <DragReorderList items={matchResults} getItemId={(m) => m.id} onReorder={onReorder}
            renderItem={(m, index, isDragging) => (
              <div className={`w-full glass-card-sm p-3 flex flex-col gap-2 transition-all border-l-4 ${isDragging ? "opacity-50" : ""} ${m.confirmed ? "border-l-accent-green" : m.score >= 0.85 ? "border-l-accent-green" : m.score >= 0.6 ? "border-l-warning" : "border-l-accent-rose"}`}>
                <div className="flex gap-3">
                  {/* 排列序号：取自 DragReorderList 实时 index（拖拽重排即更新），独立列不随内容伸缩 */}
                  <div className="w-7 h-[90px] flex items-center justify-center shrink-0 text-muted-foreground/70 font-mono text-sm select-none">{index + 1}</div>
                  <div className="w-[140px] h-[90px] rounded-md bg-bg-secondary overflow-hidden shrink-0 relative">
                    {m.thumbnail ? <img src={getSafeMediaUrl(m.thumbnail)} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center"><Film size={24} className="text-muted-foreground/20" /></div>}
                    {m.chunkData && <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-[11px] text-white font-mono">{formatIntSeconds((m.chunkData as any).endMs - (m.chunkData as any).startMs)}</div>}
                    {m.appliedSpeedFactor !== 1 && m.appliedSpeedFactor !== undefined && <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-accent-rose/80 text-[11px] text-white">{m.appliedSpeedFactor.toFixed(2)}x</div>}
                  </div>
                  <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                    {/* 台词（替代技术化 shotId），无台词时回退显示 shotId；原声段落加"原声"标记 */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium break-words min-w-0 flex items-start gap-1.5" title={m.id}>
                        {m.text || m.id}
                        {m.keepOriginalAudio && <Badge variant="warning" className="text-[11px] shrink-0">原声</Badge>}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {m.text && (
                          <button onClick={() => handleCopyText(m.text, m.id)}
                            className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-accent rounded transition-all cursor-pointer" title="复制文案">
                            {copiedId === m.id ? <Check size={11} /> : <Copy size={11} />}
                            {copiedId === m.id ? "已复制" : "复制"}
                          </button>
                        )}
                        <Badge variant={m.score > 0.8 ? "success" : m.score > 0.5 ? "warning" : "danger"} className="text-[11px] shrink-0">{Math.round(m.score * 100)}%</Badge>
                      </div>
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
                      <button onClick={() => openPreview(m.id)} className="px-2.5 py-1 text-[12px] bg-accent/15 text-accent hover:bg-accent hover:text-accent-foreground rounded transition-all cursor-pointer flex items-center gap-1"><Play size={10} /> 预览</button>
                      {m.confirmed ? (
                        <span className="text-[12px] text-accent-green flex items-center gap-0.5"><Check size={12} /> 已确认</span>
                      ) : (
                        <>
                          <button onClick={() => onConfirm(m.id)} className="px-2.5 py-1 text-[12px] bg-accent-green/20 text-accent-green hover:bg-accent-green hover:text-white rounded transition-all cursor-pointer">确认</button>
                          <button onClick={() => setReplacingShotId(m.id)} className="px-2.5 py-1 text-[12px] bg-bg-secondary text-muted-foreground hover:text-foreground rounded transition-all cursor-pointer">替换</button>
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
      {/* 替换弹窗：createPortal 挂到 document.body，脱离 glass-card(backdrop-filter)/滚动容器的
          特殊合成上下文 —— 修复 fixed 浮层内图片解码成功但上屏黑（与主卡片普通流渲染对齐） */}
      {replacingShotId && createPortal(
        <div className="fixed inset-0 z-[500] bg-black/60 flex items-center justify-center" onClick={() => setReplacingShotId(null)}>
          <div className="bg-bg-primary border border-border rounded-xl shadow-lg w-[640px] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary/60">
              <span className="text-[14px] font-semibold">选择视频片段</span>
              <button onClick={() => setReplacingShotId(null)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X size={18} /></button>
            </div>
            <div
              className="overflow-y-auto p-4 grid grid-cols-3 gap-3 content-start max-h-[516px]"
              onScroll={(e) => {
                // 滚动接近底部时追加下一批（兜底；主机制是底部哨兵 IntersectionObserver）
                const el = e.currentTarget;
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
                  setPoolPage((p) => (chunkPool.length > p * REPLACE_PAGE_SIZE ? p + 1 : p));
                }
              }}
            >
              {chunkPool.length > 0 ? chunkPool.slice(0, poolPage * REPLACE_PAGE_SIZE).map((chunk: any) => (
                <ChunkPoolTile
                  key={chunk.id || `t-${chunk.startMs ?? 0}-${chunk.endMs ?? 0}`}
                  chunk={chunk}
                  usedCount={usedChunkCount.get(String(chunk.parentChunkId || chunk.id)) || 0}
                  onPick={() => handleReplaceSelect(replacingShotId, chunk)}
                />
              )) : <div className="col-span-3"><EmptyState title="暂无片段素材" description="请先执行管线生成视频片段" iconType="search" size="md" /></div>}
              {/* 底部哨兵：始终渲染，IntersectionObserver 监听其进入可视区即加载下一批（与滚动条是否出现解耦） */}
              <div ref={poolSentinelRef} className="col-span-3 py-2 text-center text-[12px] text-muted-foreground/70">
                {chunkPool.length > poolPage * REPLACE_PAGE_SIZE
                  ? `已加载 ${Math.min(chunkPool.length, poolPage * REPLACE_PAGE_SIZE)}/${chunkPool.length}，向下滚动继续加载`
                  : (chunkPool.length > 0 ? '已加载全部片段' : '')}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {/* 预览弹窗：视频片段 + 配音音频 + 台词，评估匹配度 */}
      {previewMatch && (
        <div className="fixed inset-0 z-[500] bg-black/60 flex items-center justify-center" onClick={closePreview}>
          <div className="bg-bg-primary border border-border rounded-xl shadow-lg w-[640px] max-h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary/60">
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
                  // key=id：切换预览目标时强制重建元素，重新触发 onLoadedMetadata 定位到新起点
                  <video
                    key={previewMatch.id}
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
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground/40">
                    <Film size={40} />
                    <span className="text-[12px]">该段落未匹配到画面切片</span>
                  </div>
                )}
                {/* 播放控制条 */}
                <div className="absolute bottom-0 inset-x-0 px-3 py-2 bg-gradient-to-t from-black/80 to-transparent flex items-center gap-3">
                  {/** 🔧 2026-09-05：未命中切片的段落无可播画面（video/audio 均空）→ 播放钮禁用并提示，不再从源视频片头空播 */}
                  <button onClick={togglePreviewPlay} disabled={!previewVideoUrl && !previewAudioUrl}
                    className="w-9 h-9 rounded-full bg-accent text-accent-foreground flex items-center justify-center hover:opacity-90 transition-all cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed">
                    {previewPlaying ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <div className="flex items-center gap-1.5 text-[12px] text-white/90">
                    {!previewVideoUrl && !previewAudioUrl ? (
                      <>
                        <VolumeX size={13} />
                        <span>未匹配到画面切片，暂不可播放</span>
                      </>
                    ) : isOriginalAudio ? (
                      <>
                        <Volume2 size={13} />
                        <span>原声播放（切片自带音轨）</span>
                      </>
                    ) : previewAudioUrl ? (
                      <>
                        <Volume2 size={13} />
                        <span>配音同步播放</span>
                      </>
                    ) : (
                      <>
                        <VolumeX size={13} />
                        <span>无配音音频</span>
                      </>
                    )}
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
                  <div className="flex items-center gap-2">
                    {previewMatch.appliedSpeedFactor && previewMatch.appliedSpeedFactor !== 1 && !isOriginalAudio && (
                      <span className="text-accent-rose">变速 {previewMatch.appliedSpeedFactor.toFixed(2)}x</span>
                    )}
                    {previewMatch.text && (
                      <button onClick={() => handleCopyText(previewMatch.text, previewMatch.id)}
                        className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-accent rounded transition-all cursor-pointer" title="复制文案">
                        {copiedId === previewMatch.id ? <Check size={11} /> : <Copy size={11} />}
                        {copiedId === previewMatch.id ? "已复制" : "复制"}
                      </button>
                    )}
                  </div>
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
