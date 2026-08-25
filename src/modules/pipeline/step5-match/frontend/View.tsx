// Module: pipeline/step5-match - View
// 纯 Props 组件：镜头匹配卡片列表 + 拖拽排序 + 替换弹窗 + 成品预览弹窗（视频+配音+台词）

import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Check, RefreshCw, Film, X, Play, Pause, Volume2, VolumeX, Music, Music2, Upload, Trash2, Sparkles, Loader2, Copy } from "lucide-react";
import { getSafeMediaUrl } from "@renderer/utils/formatUrl";
import { Badge, StatHeader, EmptyState } from "@renderer/components/shared";
import { DragReorderList } from "@renderer/components/shared/drag-reorder-list";
import { API } from "@renderer/api";
import type { StepShotMatchingProps } from "../types";
import { useStep5Store } from "../../stores/useStep5Store";
import type { BgmTrack, BgmRecommendation } from "../../stores/useStep5Store";
import { BgmTrackPlayer } from "./BgmTrackPlayer";

/** 时长毫秒 → 整数秒文案（去掉小数点，如 3500ms → "4s"） */
const formatIntSeconds = (ms?: number | null): string => {
  if (!ms || ms <= 0) return "";
  return `${Math.round(ms / 1000)}s`;
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

export const StepShotMatchingView: React.FC<StepShotMatchingProps> = ({
  matchResults, videoChunks, mediaItems, ttsResults, hasBgm, isProcessing,
  activeBgm, scriptParagraphs, emotionTone, frameEmotions, shotTypes, videoDurationMs, bgmOptions,
  onSetBgm, onRemoveBgm, onUploadBgm,
  onConfirm, onReplace, onRematch, onReorder,
}) => {
  const [replacingShotId, setReplacingShotId] = useState<string | null>(null);
  /** 预览弹窗状态：当前预览的 shotId + 播放/暂停 */
  const [previewShotId, setPreviewShotId] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  /** 复制文案成功反馈：记录当前已复制的 shotId（1.5s 后复位） */
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const chunkPool = useMemo(() => {
    return videoChunks.length > 0 ? videoChunks : mediaItems.filter((m) => m.type === "video_chunk" || m.type === "frame");
  }, [videoChunks, mediaItems]);

  /** AI 深度推荐状态：LLM 依据文案语义生成的推荐（提升到 useStep5Store，随快照落盘不丢失） */
  const deepRecommendation = useStep5Store((s) => s.deepRecommendation);
  const setDeepRecommendation = useStep5Store((s) => s.setDeepRecommendation);
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

  /** 按分类过滤 + 分页 */
  const filteredLocalTracks = useMemo(() => {
    if (localTone === 'all') return localTracks;
    return localTracks.filter((t) => (t.mood || '').includes(localTone));
  }, [localTracks, localTone]);
  const localTotalPages = Math.max(1, Math.ceil(filteredLocalTracks.length / LOCAL_PAGE_SIZE));
  const pageLocalTracks = useMemo(() => {
    const start = localPage * LOCAL_PAGE_SIZE;
    return filteredLocalTracks.slice(start, start + LOCAL_PAGE_SIZE);
  }, [filteredLocalTracks, localPage]);

  /** 当前展示的推荐：AI 生成结果优先，未生成时为占位空对象 */
  const currentRecommendation = deepRecommendation || EMPTY_RECOMMENDATION;

  /** 调用后端 LLM 生成深度 BGM 推荐 */
  const handleDeepRecommend = useCallback(async () => {
    setDeepLoading(true);
    setDeepError('');
    try {
      const payload = {
        scriptParagraphs: scriptParagraphs.map((p) => p.text).filter(Boolean),
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
      {/* 🎵 BGM 设置面板：个性化推荐 + 上传本地 + 已分离伴奏选择 + 当前状态 */}
      <div className="glass-card-sm p-3 flex flex-col gap-3">
        {/* 标题 + 当前状态 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[14px] font-semibold">
            <Music size={14} className="text-accent" /> BGM 背景音乐
            {activeBgm && <Badge variant="success" className="flex items-center gap-0.5">已选</Badge>}
          </div>
          {activeBgm && (
            <button onClick={onRemoveBgm} disabled={isProcessing}
              className="flex items-center gap-1 px-2 py-1 text-[12px] text-accent-rose hover:bg-accent-rose/10 rounded transition-all cursor-pointer disabled:opacity-50">
              <Trash2 size={12} /> 移除
            </button>
          )}
        </div>

        {/* 当前 BGM 文件 */}
        {activeBgm ? (
          <div className="text-[12px] flex items-center gap-2">
            <span className="bg-accent/15 text-accent px-2 py-0.5 rounded truncate max-w-[320px]" title={activeBgm.filePath}>
              {activeBgm.name || activeBgm.filePath}
            </span>
          </div>
        ) : (
          <div className="text-[12px] text-muted-foreground">未选择 BGM，画面切换将不卡音乐节奏</div>
        )}

        {/* 个性化推荐（AI 深度生成，依据解说文案语义） */}
          <div className="flex flex-col gap-2">
            {/* 标题行 + AI 深度推荐按钮 */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <Sparkles size={13} className="text-accent" /> 个性化推荐
                <span className="text-muted-foreground font-normal text-[11px]">
                  {deepRecommendation ? '（AI 深度 · 依据文案语义）' : '（点击生成）'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleDeepRecommend} disabled={deepLoading || isProcessing}
                  className="flex items-center gap-1 px-2.5 py-1 text-[12px] bg-accent/15 text-accent hover:bg-accent hover:text-accent-foreground rounded-md transition-all cursor-pointer disabled:opacity-50">
                  {deepLoading
                    ? <><Loader2 size={12} className="animate-spin" /> 生成中...</>
                    : <><Sparkles size={12} /> {deepRecommendation ? '重新AI推荐' : 'AI 深度推荐'}</>}
                </button>
              </div>
            </div>
            {deepError && (
              <div className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-md bg-accent-rose/10 border border-accent-rose/30 text-accent-rose text-[12px]">
                <X size={13} className="mt-0.5 shrink-0" />
                <span>AI 深度推荐失败：{deepError}</span>
              </div>
            )}
            {currentRecommendation.tracks.length > 0 ? (
              <>
                <div className="text-[12px] text-muted-foreground">{currentRecommendation.toneDesc}</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {currentRecommendation.tracks.map((t) => (
                    <div key={t.name} className="border border-border rounded-lg p-2.5 flex flex-col gap-1 bg-bg-secondary/30">
                      <div className="text-[12px] font-medium truncate" title={t.name}>{t.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{t.artist} · {t.source}</div>
                      <div className="flex items-center gap-1 flex-wrap">
                        <Badge variant="warning" className="text-[10px]">{t.mood}</Badge>
                        <Badge variant="success" className="text-[10px]">卡点 {t.beatFit}</Badge>
                      </div>
                      {(t.previewUrl || t.downloadUrl || t.libraryId) && (
                        <BgmTrackPlayer
                          track={t}
                          isProcessing={isProcessing}
                          applying={applyingTrackKey === trackKey(t)}
                          onApply={handleApplyBgm}
                        />
                      )}
                    </div>
                  ))}
                </div>
                {applyError && (
                  <div className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-md bg-accent-rose/10 border border-accent-rose/30 text-accent-rose text-[12px]">
                    <X size={13} className="mt-0.5 shrink-0" />
                    <span>BGM 应用失败：{applyError}</span>
                  </div>
                )}
                <div className="text-[11px] text-muted-foreground">以上为全网搜索推荐，请自行在音乐平台搜索下载后上传使用</div>
              </>
            ) : !deepLoading && (
              <div className="text-[12px] text-muted-foreground">点击「AI 深度推荐」，AI 将依据解说文案语义生成全网选曲建议</div>
            )}
          </div>

        {/* 本地曲库：分类分页自选 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 text-[13px] font-medium">
              <Music2 size={13} className="text-accent" /> 本地曲库
              <span className="text-muted-foreground font-normal text-[11px]">（{localTracks.length} 首 · 免费商用）</span>
            </div>
          </div>
          {/* 分类标签 */}
          <div className="flex items-center gap-1 flex-wrap">
            {LOCAL_TONE_TABS.map((tab) => (
              <button key={tab.value}
                onClick={() => { setLocalTone(tab.value); setLocalPage(0); }}
                className={`px-2.5 py-1 text-[12px] rounded-md transition-all cursor-pointer ${
                  localTone === tab.value
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-bg-secondary text-muted-foreground hover:text-foreground'
                }`}>
                {tab.label}
              </button>
            ))}
          </div>
          {/* 曲目列表 + 分页 */}
          {localLoading ? (
            <div className="text-[12px] text-muted-foreground">加载中...</div>
          ) : pageLocalTracks.length > 0 ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {pageLocalTracks.map((t) => (
                  <div key={t.libraryId} className="border border-border rounded-lg p-2.5 flex flex-col gap-1 bg-bg-secondary/30">
                    <div className="text-[12px] font-medium truncate" title={t.name}>{t.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{t.artist} · {t.source}</div>
                    <div className="flex items-center gap-1 flex-wrap">
                      <Badge variant="warning" className="text-[10px]">{t.mood}</Badge>
                      {t.bpm ? <Badge variant="success" className="text-[10px]">{t.bpm} BPM</Badge> : null}
                    </div>
                    <BgmTrackPlayer
                      track={t}
                      isProcessing={isProcessing}
                      applying={applyingTrackKey === trackKey(t)}
                      onApply={handleApplyBgm}
                    />
                  </div>
                ))}
              </div>
              {localTotalPages > 1 && (
                <div className="flex items-center justify-center gap-2">
                  <button onClick={() => setLocalPage((p) => Math.max(0, p - 1))} disabled={localPage === 0}
                    className="px-2.5 py-1 text-[12px] bg-bg-secondary text-muted-foreground hover:text-foreground rounded-md transition-all cursor-pointer disabled:opacity-40">
                    上一页
                  </button>
                  <span className="text-[11px] text-muted-foreground">{localPage + 1} / {localTotalPages}</span>
                  <button onClick={() => setLocalPage((p) => Math.min(localTotalPages - 1, p + 1))} disabled={localPage >= localTotalPages - 1}
                    className="px-2.5 py-1 text-[12px] bg-bg-secondary text-muted-foreground hover:text-foreground rounded-md transition-all cursor-pointer disabled:opacity-40">
                    下一页
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="text-[12px] text-muted-foreground">本地曲库为空或加载失败</div>
          )}
        </div>

        {/* 操作：上传本地 / 使用已分离伴奏 */}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={onUploadBgm} disabled={isProcessing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/15 text-accent hover:bg-accent hover:text-accent-foreground rounded-md text-[12px] font-medium transition-all cursor-pointer disabled:opacity-50">
            <Upload size={12} /> 上传本地BGM
          </button>
          {bgmOptions.map((m) => (
            <button key={m.id} onClick={() => onSetBgm({ id: m.id, filePath: (m as any).extractedBgm, name: (m as any).name || '伴奏' })} disabled={isProcessing}
              className="flex items-center gap-1 px-3 py-1.5 bg-bg-secondary text-muted-foreground hover:text-foreground rounded-md text-[12px] transition-all cursor-pointer disabled:opacity-50">
              <Music2 size={12} /> 用伴奏：{(m as any).name || '已分离伴奏'}
            </button>
          ))}
        </div>
        {bgmOptions.length === 0 && (
          <div className="text-[11px] text-muted-foreground">小提示：对原视频执行「音频分离」后，可在此直接选用分离出的纯伴奏作为 BGM</div>
        )}
        <div className="text-[11px] text-muted-foreground">选择 BGM 后会自动重新匹配，将镜头切换吸附到鼓点，避免夹帧</div>
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
                      <span className="text-[13px] font-medium break-words min-w-0 flex items-start gap-1.5" title={m.text || m.shotId}>
                        {m.text || m.shotId}
                        {m.keepOriginalAudio && <Badge variant="warning" className="text-[11px] shrink-0">原声</Badge>}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {m.text && (
                          <button onClick={() => handleCopyText(m.text, m.shotId)}
                            className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-accent rounded transition-all cursor-pointer" title="复制文案">
                            {copiedId === m.shotId ? <Check size={11} /> : <Copy size={11} />}
                            {copiedId === m.shotId ? "已复制" : "复制"}
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
                  <div className="flex items-center gap-2">
                    {previewMatch.appliedSpeedFactor && previewMatch.appliedSpeedFactor !== 1 && !isOriginalAudio && (
                      <span className="text-accent-rose">变速 {previewMatch.appliedSpeedFactor.toFixed(2)}x</span>
                    )}
                    {previewMatch.text && (
                      <button onClick={() => handleCopyText(previewMatch.text, previewMatch.shotId)}
                        className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-accent rounded transition-all cursor-pointer" title="复制文案">
                        {copiedId === previewMatch.shotId ? <Check size={11} /> : <Copy size={11} />}
                        {copiedId === previewMatch.shotId ? "已复制" : "复制"}
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
