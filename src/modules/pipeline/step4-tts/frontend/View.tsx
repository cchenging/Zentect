// Module: pipeline/step4-tts - View

import React, { useRef, useEffect, useState } from "react";
import { Play, Square, Volume2, Mic, User, ChevronDown, ChevronRight } from "lucide-react";
import { Badge, Progress, StatHeader, EmptyState } from "@renderer/components/shared";
import { VoiceCard } from "@renderer/components/shared/VoiceCard";
import type { ScriptParagraph, OriginalAudioParagraph } from "../../../../shared/types/entities/editor";
import type { TTSResult, TtsVoiceOption } from "../types";

export interface StepTTSSynthesisViewProps {
  ttsEngine: string;
  ttsVoiceId: string;
  ttsProgress: number;
  ttsResults: TTSResult[];
  scriptParagraphs: ScriptParagraph[];
  isProcessing: boolean;
  voices: TtsVoiceOption[];
  speechRate: number;
  previewingVoiceId: string | null;
  playingIdx: number | null;
  successCount: number;
  failedCount: number;
  // 单段配音：当前正在合成的段落索引
  singleSynthIdx: number | null;
  // 顺序播放相关
  isSequentialPlaying: boolean;
  sequentialIdx: number | null;
  isPaused: boolean;
  onSetTtsEngine: (engine: string) => void;
  onSetTtsVoiceId: (id: string) => void;
  onSetSpeechRate: (rate: number) => void;
  onPreview: (idx: number, audioUrl: string) => void;
  onVoicePreview: (voiceId: string) => void;
  onSynthesize: () => void;
  onSingleSynthesize: (idx: number) => void;
  // 原声段试听：播放原片对应时间窗的真实台词（区别于解说段 TTS 试听）
  onOriginalAudioPreview: (idx: number, audioSource: OriginalAudioParagraph['audioSource']) => void;
  onSequentialPlay: () => void;
  onSequentialStop: () => void;
}

const ENGINE_LABELS: Record<string, string> = {
  edge: "Edge TTS", doubao: "火山引擎", kokoro: "Kokoro",
};

export const StepTTSSynthesisView: React.FC<StepTTSSynthesisViewProps> = (props) => {
  const { ttsEngine, ttsVoiceId, ttsProgress, ttsResults, scriptParagraphs, isProcessing,
    voices, speechRate, previewingVoiceId, playingIdx, successCount, failedCount,
    singleSynthIdx, isSequentialPlaying, sequentialIdx, isPaused,
    onSetTtsEngine, onSetTtsVoiceId, onSetSpeechRate, onPreview, onVoicePreview,
    onSingleSynthesize, onOriginalAudioPreview, onSequentialPlay, onSequentialStop } = props;

  const currentVoices = voices;

  // 音色选择区折叠状态（默认展开，可折叠节省纵向空间）
  const [voicesCollapsed, setVoicesCollapsed] = useState(false);

  // 顺序播放自动滚动：当前播放段变化时，滚动到对应卡片
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    if (isSequentialPlaying && sequentialIdx !== null && cardRefs.current[sequentialIdx]) {
      cardRefs.current[sequentialIdx]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isSequentialPlaying, sequentialIdx]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[14px] font-semibold">TTS 配音合成</div>
        {scriptParagraphs.length > 0 && <StatHeader value={scriptParagraphs.length} unit="段文案" secondary={ENGINE_LABELS[ttsEngine] || ttsEngine} />}
      </div>

      {/* 引擎选择 */}
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground shrink-0">引擎:</span>
        <div className="flex items-center gap-1 flex-wrap">
          {(["edge", "doubao", "kokoro"] as const).map((eng) => (
            <Badge key={eng} variant={ttsEngine === eng ? "accent" : "default"} interactive="selectable" selected={ttsEngine === eng}
              onClick={() => onSetTtsEngine(eng)} disabled={isProcessing}>
              {ENGINE_LABELS[eng] || eng}
            </Badge>
          ))}
        </div>
      </div>

      {/* 音色选择（可折叠，默认展开） */}
      <div className="glass-card-sm p-3">
        <button onClick={() => setVoicesCollapsed(!voicesCollapsed)}
          className="w-full flex items-center justify-between gap-2 mb-2 text-[13px] text-muted-foreground cursor-pointer select-none">
          <span className="flex items-center gap-2"><User size={12} /> 音色选择</span>
          {voicesCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        {!voicesCollapsed && (
          <div className="grid grid-cols-3 gap-1.5 max-h-[200px] overflow-y-auto">
            {currentVoices.map((voice) => (
              <VoiceCard key={voice.id} id={voice.id} name={voice.name} lang={voice.lang}
                selected={ttsVoiceId === voice.id} isPreviewing={previewingVoiceId === voice.id}
                // 🔧 修复 TS2322：VoiceCard onSelect 期望 () => void，用箭头函数包装 id 参数
                onSelect={() => onSetTtsVoiceId(voice.id)} onPreview={onVoicePreview} />
            ))}
            {currentVoices.length === 0 && <div className="col-span-3 text-[12px] text-muted-foreground py-1">暂无可用音色</div>}
          </div>
        )}
      </div>

      {/* 语速 */}
      <div className="glass-card-sm p-3">
        <div className="flex items-center gap-2 mb-2 text-[13px] text-muted-foreground"><Volume2 size={12} /> 语速调节</div>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-muted-foreground">0.5x</span>
          <input type="range" min={0.5} max={2.0} step={0.1} value={speechRate}
            onChange={(e) => onSetSpeechRate(parseFloat(e.target.value))}
            className="flex-1 h-1 accent-accent-cyan disabled:opacity-40" />
          <span className="text-[12px] text-accent-cyan font-mono w-8 text-right">{speechRate.toFixed(1)}x</span>
        </div>
      </div>

      {/* 进度 */}
      {scriptParagraphs.length > 0 && <Progress value={ttsProgress} color="cyan" size="sm" showLabel />}
      {ttsResults.length > 0 && (
        <div className="flex items-center gap-3 text-[12px]">
          <span className="text-accent-green">{successCount} 段成功</span>
          {failedCount > 0 && <span className="text-accent-rose">{failedCount} 段失败</span>}
        </div>
      )}
      {/* 原声保留段统计：后端只合成解说段，此处明示不参与配音的段数，避免"总段数-成功数"对不上 */}
      {(() => {
        const originalCount = scriptParagraphs.filter((p) => p.type === 'original_audio').length;
        return originalCount > 0 ? (
          <div className="flex items-center gap-1.5 text-[12px] text-accent-cyan/90">
            <Mic size={11} className="text-accent-cyan/70" />
            <span>{originalCount} 段为原声保留，将直接使用原片音轨，不参与 TTS 配音</span>
          </div>
        ) : null;
      })()}

      {/* 结果列表 */}
      {scriptParagraphs.length > 0 ? (
        <div className="flex flex-col gap-2">
          {/* 配音列表标题行：右侧常驻"全部播放"（连续播放所有已合成段落），支持暂停/继续 + 停止 + 进度 */}
          <div className="flex items-center justify-between">
            <div className="text-[14px] font-semibold flex items-center gap-2"><Mic size={14} /> 配音列表</div>
            <div className="flex items-center gap-1.5">
              <button onClick={onSequentialPlay} disabled={isProcessing || successCount === 0}
                title={successCount === 0 ? "请先合成配音，再全部播放" : "连续播放全部已合成段落"}
                className={`flex items-center justify-center gap-1.5 py-1 px-2.5 rounded-md text-[13px] font-medium cursor-pointer transition-all disabled:opacity-50 ${
                  isSequentialPlaying
                    ? (isPaused ? "bg-accent/15 text-accent hover:bg-accent/25" : "bg-accent-cyan/20 text-accent-cyan")
                    : "bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20"
                }`}>
                {isSequentialPlaying && !isPaused ? <><Square size={11} /> 暂停</>
                  : isSequentialPlaying && isPaused ? <><Play size={11} /> 继续</>
                  : <><Play size={11} /> 全部播放</>}
              </button>
              {isSequentialPlaying && (
                <button onClick={onSequentialStop}
                  className="flex items-center justify-center gap-1 py-1 px-2 rounded-md text-[13px] bg-muted/20 text-muted-foreground hover:bg-muted/30 font-medium cursor-pointer">
                  停止
                </button>
              )}
              {/* 播放进度提示：当前段/总段数 */}
              {isSequentialPlaying && sequentialIdx !== null && (
                <span className="text-[12px] text-muted-foreground">
                  第 {String(sequentialIdx + 1).padStart(2, '0')} / {successCount}
                </span>
              )}
            </div>
          </div>
          {scriptParagraphs.map((p, idx) => {
            // ✅ 身份键统一：段落主键 p.id 与产物 id 同源，严格按 id 匹配，删除旧 shotId 双门
            const result = ttsResults.find((r) => r.id === p.id) || null;
            // 四态状态判断：已完成 / 合成中 / 失败 / 待合成
            // 合成中：isProcessing 期间，该段尚未出现在 ttsResults 中（Strategy 增量推送，已完成段才会出现）
            // 原声保留段不参与合成：后端已过滤，永远无 TTS 结果，管线运行中也禁止显示"合成中"
            const isSynthesizing = isProcessing && !result && p.type !== 'original_audio';
            const status = result
              ? (result._failed ? "failed" : result.audioUrl ? "completed" : "failed")
              : (isSynthesizing ? "synthesizing" : "pending");
            const isPlaying = playingIdx === idx;
            // 顺序播放当前段高亮（区别于单段播放：用 accent 边框 + 脉冲背景）
            const isSequentialCurrent = isSequentialPlaying && sequentialIdx === idx;
            const durationStr = p.duration ? `${Number(p.duration).toFixed(1)}s` : '';
            return (
              <div key={`tts-${idx}-${p.id}`}
                ref={(el) => { cardRefs.current[idx] = el; }}
                className={`glass-card-sm p-2.5 flex items-center gap-3 transition-all ${
                  isSequentialCurrent ? "border-accent bg-accent/10 ring-1 ring-accent/30"
                  : isSynthesizing ? "border-accent-cyan/30 bg-accent-cyan/5"
                  : ""
                }`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-accent font-mono shrink-0">第 {String(idx + 1).padStart(2, '0')} 段</span>
                    {/* 原声保留段：独立 info 变体徽标，与解说段的合成状态彻底解耦 */}
                    <Badge variant={
                      p.type === 'original_audio' ? "info"
                      : status === "completed" ? "success"
                      : status === "synthesizing" ? "accent"
                      : status === "failed" ? "danger"
                      : "default"
                    }>
                      {p.type === 'original_audio' ? "原声保留"
                        : status === "completed" ? "已完成"
                        : status === "synthesizing" ? "合成中"
                        : status === "failed" ? "失败"
                        : "待合成"}
                    </Badge>
                    {durationStr && <span className="text-[12px] text-muted-foreground">{durationStr}</span>}
                    {/* 合成中显示脉冲动画点，增强用户感知 */}
                    {isSynthesizing && (
                      <span className="flex items-center gap-0.5 ml-1">
                        <span className="w-1 h-1 rounded-full bg-accent-cyan animate-pulse" style={{ animationDelay: '0ms' }}></span>
                        <span className="w-1 h-1 rounded-full bg-accent-cyan animate-pulse" style={{ animationDelay: '150ms' }}></span>
                        <span className="w-1 h-1 rounded-full bg-accent-cyan animate-pulse" style={{ animationDelay: '300ms' }}></span>
                      </span>
                    )}
                    {/* 顺序播放当前段显示播放图标 */}
                    {isSequentialCurrent && (
                      <span className="flex items-center gap-1 ml-1 text-accent">
                        <Volume2 size={11} className={isPaused ? "" : "animate-pulse"} />
                        <span className="text-[12px]">{isPaused ? "已暂停" : "播放中"}</span>
                      </span>
                    )}
                  </div>
                  <div className={`text-[13px] truncate mt-0.5 ${
                    isSequentialCurrent ? "text-accent"
                    : isSynthesizing ? "text-accent-cyan"
                    : "text-foreground"
                  }`}>
                    {/* 原声保留段：展示说话人 + 原片台词，明确其来源与不参与配音的原因 */}
                    {p.type === 'original_audio' ? (
                      <div className="flex items-center gap-1.5 min-w-0">
                        {p.audioSource.speaker && (
                          <span className="shrink-0 text-[11px] text-accent-cyan/90 border border-accent-cyan/20 rounded px-1 py-px leading-tight">
                            {p.audioSource.speaker}
                          </span>
                        )}
                        <span className="truncate">{p.audioSource.transcript || '(原声保留段)'}</span>
                      </div>
                    ) : p.text}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* 单段配音按钮：仅合成当前段落（失败/待合成段可单独重试）；原声保留段无解说词，禁用合成入口 */}
                  <button
                    onClick={() => onSingleSynthesize(idx)}
                    disabled={isProcessing || isSequentialPlaying || singleSynthIdx !== null || p.type === 'original_audio'}
                    title="仅配音本段"
                    className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                      singleSynthIdx === idx ? "bg-accent-cyan/20 text-accent-cyan animate-pulse"
                      : "bg-muted/20 text-muted-foreground hover:bg-muted/30 hover:text-foreground disabled:opacity-40"}`}>
                    {singleSynthIdx === idx ? <Mic size={12} className="animate-pulse" /> : <Mic size={12} />}
                  </button>
                  {/* 播放/试听按钮：解说段播 TTS 合成结果；原声保留段播原片对应时间窗的真实台词（后端 ffmpeg 截取） */}
                  <button
                    onClick={() => p.type === 'original_audio' ? onOriginalAudioPreview(idx, p.audioSource) : (result?.audioUrl && onPreview(idx, result.audioUrl!))}
                    disabled={isSequentialPlaying || (p.type === 'original_audio'
                      ? !(p.audioSource?.sourceStartMs && p.audioSource.sourceEndMs > p.audioSource.sourceStartMs)
                      : (!result?.audioUrl || result._failed || isProcessing))}
                    title={p.type === 'original_audio' ? "试听原片原声" : "试听配音"}
                    className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                      isPlaying ? "bg-accent/15 text-accent"
                      : isSequentialCurrent ? "bg-accent/15 text-accent"
                      : isSynthesizing ? "bg-muted/20 text-muted-foreground/30 cursor-not-allowed"
                      : p.type === 'original_audio' || (result?.audioUrl && !result._failed)
                        ? "bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20"
                        : "bg-muted/20 text-muted-foreground/30 cursor-not-allowed"}`}>
                    {isPlaying || isSequentialCurrent ? <Square size={14} /> : isSynthesizing ? <Mic size={12} className="animate-pulse" /> : <Play size={14} />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState title="配音待合成" description="文案确认后，TTS 引擎将逐段合成配音" iconType="audio" size="md" className="glass-card-sm" />
      )}
    </div>
  );
};
