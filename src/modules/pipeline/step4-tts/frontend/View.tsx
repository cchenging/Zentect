// Module: pipeline/step4-tts - View

import React, { useRef, useEffect } from "react";
import { Play, Square, Volume2, Mic, User } from "lucide-react";
import { Badge, Progress, StatHeader, EmptyState } from "@renderer/components/shared";
import { VoiceCard } from "@renderer/components/shared/VoiceCard";
import type { ScriptParagraph } from "../../../../shared/types/entities/editor";
import type { TTSResult, TtsVoiceOption } from "../types";

export interface StepTTSSynthesisViewProps {
  ttsEngine: string;
  ttsVoiceId: string;
  ttsProgress: number;
  ttsResults: TTSResult[];
  scriptParagraphs: ScriptParagraph[];
  isProcessing: boolean;
  voices: TtsVoiceOption[];
  clonedVoices: TtsVoiceOption[];
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
  onSequentialPlay: () => void;
  onSequentialStop: () => void;
}

const ENGINE_LABELS: Record<string, string> = {
  edge: "Edge TTS", doubao: "火山引擎", sovits: "SoVITS",
};

export const StepTTSSynthesisView: React.FC<StepTTSSynthesisViewProps> = (props) => {
  const { ttsEngine, ttsVoiceId, ttsProgress, ttsResults, scriptParagraphs, isProcessing,
    voices, clonedVoices, speechRate, previewingVoiceId, playingIdx, successCount, failedCount,
    singleSynthIdx, isSequentialPlaying, sequentialIdx, isPaused,
    onSetTtsEngine, onSetTtsVoiceId, onSetSpeechRate, onPreview, onVoicePreview, onSynthesize,
    onSingleSynthesize, onSequentialPlay, onSequentialStop } = props;

  const currentVoices = [...voices, ...clonedVoices.map((v) => ({ ...v, lang: "克隆" }))];

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
        <div className="text-[13px] font-semibold">TTS 配音合成</div>
        {scriptParagraphs.length > 0 && <StatHeader value={scriptParagraphs.length} unit="段文案" secondary={ENGINE_LABELS[ttsEngine] || ttsEngine} />}
      </div>

      {/* 引擎选择 */}
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground shrink-0">引擎:</span>
        <div className="flex items-center gap-1 flex-wrap">
          {(["edge", "doubao", "sovits"] as const).map((eng) => (
            <Badge key={eng} variant={ttsEngine === eng ? "accent" : "default"} interactive="selectable" selected={ttsEngine === eng}
              onClick={() => onSetTtsEngine(eng)} disabled={isProcessing}>
              {ENGINE_LABELS[eng] || eng}
            </Badge>
          ))}
        </div>
      </div>

      {/* 音色选择 */}
      <div className="glass-card-sm p-3">
        <div className="flex items-center gap-2 mb-2 text-[13px] text-muted-foreground"><User size={12} /> 音色选择</div>
        <div className="grid grid-cols-3 gap-1.5 max-h-[200px] overflow-y-auto">
          {currentVoices.map((voice) => (
            <VoiceCard key={voice.id} id={voice.id} name={voice.name} lang={voice.lang}
              selected={ttsVoiceId === voice.id} isPreviewing={previewingVoiceId === voice.id}
              // 🔧 修复 TS2322：VoiceCard onSelect 期望 () => void，用箭头函数包装 id 参数
              onSelect={() => onSetTtsVoiceId(voice.id)} onPreview={onVoicePreview} />
          ))}
          {currentVoices.length === 0 && <div className="col-span-3 text-[10px] text-muted-foreground py-1">暂无可用音色</div>}
        </div>
      </div>

      {/* 语速 */}
      <div className="glass-card-sm p-3">
        <div className="flex items-center gap-2 mb-2 text-[13px] text-muted-foreground"><Volume2 size={12} /> 语速调节</div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground">0.5x</span>
          <input type="range" min={0.5} max={2.0} step={0.1} value={speechRate}
            onChange={(e) => onSetSpeechRate(parseFloat(e.target.value))}
            className="flex-1 h-1 accent-accent-cyan disabled:opacity-40" />
          <span className="text-[10px] text-accent-cyan font-mono w-8 text-right">{speechRate.toFixed(1)}x</span>
        </div>
      </div>

      {/* 进度 */}
      {scriptParagraphs.length > 0 && <Progress value={ttsProgress} color="cyan" size="sm" showLabel />}
      {ttsResults.length > 0 && (
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-accent-green">{successCount} 段成功</span>
          {failedCount > 0 && <span className="text-accent-rose">{failedCount} 段失败</span>}
        </div>
      )}

      {/* 结果列表 */}
      {scriptParagraphs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="text-[13px] font-semibold flex items-center gap-2"><Mic size={14} /> 配音列表</div>
          {scriptParagraphs.map((p, idx) => {
            // 严格按 id/shotId 匹配，禁止下标回退：避免 ttsResults 残留旧数据时误播试听文案
            // 匹配失败即为 null（UI 显示"待合成"），错误必须以原始形态暴露，不兜底
            const result = ttsResults.find((r) => r.shotId && (r.shotId === p.id || r.shotId === p.shotId)) || null;
            // 四态状态判断：已完成 / 合成中 / 失败 / 待合成
            // 合成中：isProcessing 期间，该段尚未出现在 ttsResults 中（Strategy 增量推送，已完成段才会出现）
            const isSynthesizing = isProcessing && !result;
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
                    <span className="text-[10px] text-accent font-mono shrink-0">第 {String(idx + 1).padStart(2, '0')} 段</span>
                    <Badge variant={
                      status === "completed" ? "success"
                      : status === "synthesizing" ? "accent"
                      : status === "failed" ? "danger"
                      : "default"
                    }>
                      {status === "completed" ? "已完成"
                        : status === "synthesizing" ? "合成中"
                        : status === "failed" ? "失败"
                        : "待合成"}
                    </Badge>
                    {durationStr && <span className="text-[10px] text-muted-foreground">{durationStr}</span>}
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
                        <span className="text-[10px]">{isPaused ? "已暂停" : "播放中"}</span>
                      </span>
                    )}
                  </div>
                  <div className={`text-[13px] truncate mt-0.5 ${
                    isSequentialCurrent ? "text-accent"
                    : isSynthesizing ? "text-accent-cyan"
                    : "text-foreground"
                  }`}>{p.text}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* 单段配音按钮：仅合成当前段落（失败/待合成段可单独重试） */}
                  <button
                    onClick={() => onSingleSynthesize(idx)}
                    disabled={isProcessing || isSequentialPlaying || singleSynthIdx !== null}
                    title="仅配音本段"
                    className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                      singleSynthIdx === idx ? "bg-accent-cyan/20 text-accent-cyan animate-pulse"
                      : "bg-muted/20 text-muted-foreground hover:bg-muted/30 hover:text-foreground disabled:opacity-40"}`}>
                    {singleSynthIdx === idx ? <Mic size={12} className="animate-pulse" /> : <Mic size={12} />}
                  </button>
                  {/* 播放按钮 */}
                  <button onClick={() => result?.audioUrl && onPreview(idx, result.audioUrl!)}
                    disabled={!result?.audioUrl || result._failed || isProcessing || isSequentialPlaying}
                    className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                      isPlaying ? "bg-accent/15 text-accent"
                      : isSequentialCurrent ? "bg-accent/15 text-accent"
                      : isSynthesizing ? "bg-muted/20 text-muted-foreground/30 cursor-not-allowed"
                      : result?.audioUrl && !result._failed ? "bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20"
                      : "bg-muted/20 text-muted-foreground/30 cursor-not-allowed"}`}>
                    {isPlaying || isSequentialCurrent ? <Square size={14} /> : isSynthesizing ? <Mic size={12} className="animate-pulse" /> : <Play size={14} />}
                  </button>
                </div>
              </div>
            );
          })}
          <button onClick={onSynthesize} disabled={isProcessing}
            className="flex items-center justify-center gap-2 py-2 rounded-md text-[13px] bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50 font-medium cursor-pointer">
            <Mic size={14} className={isProcessing ? "animate-pulse" : ""} />{isProcessing ? "合成中..." : "开始合成"}
          </button>
          {/* 顺序播放控制：仅当有已合成成功的段落时显示，支持播放/暂停切换 + 独立停止 */}
          {successCount > 0 && (
            <div className="flex items-center gap-2">
              <button onClick={onSequentialPlay} disabled={isProcessing}
                className={`flex items-center justify-center gap-2 py-2 px-3 rounded-md text-[13px] font-medium cursor-pointer transition-all disabled:opacity-50 ${
                  isSequentialPlaying
                    ? (isPaused ? "bg-accent/15 text-accent hover:bg-accent/25" : "bg-accent-cyan/20 text-accent-cyan")
                    : "bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20"
                }`}>
                {isSequentialPlaying && !isPaused ? <><Square size={12} /> 暂停</>
                  : isSequentialPlaying && isPaused ? <><Play size={12} /> 继续</>
                  : <><Play size={12} /> 顺序播放</>}
              </button>
              {isSequentialPlaying && (
                <button onClick={onSequentialStop}
                  className="flex items-center justify-center gap-1 py-2 px-3 rounded-md text-[13px] bg-muted/20 text-muted-foreground hover:bg-muted/30 font-medium cursor-pointer">
                  停止
                </button>
              )}
              {/* 播放进度提示：当前段/总段数 */}
              {isSequentialPlaying && sequentialIdx !== null && (
                <span className="text-[11px] text-muted-foreground ml-1">
                  第 {String(sequentialIdx + 1).padStart(2, '0')} 段 / 共 {successCount} 段
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <EmptyState title="配音待合成" description="文案确认后，TTS 引擎将逐段合成配音" iconType="audio" size="md" className="glass-card-sm" />
      )}
    </div>
  );
};
