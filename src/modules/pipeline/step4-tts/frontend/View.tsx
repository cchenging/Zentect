// Module: pipeline/step4-tts - View

import React from "react";
import { Play, Square, Volume2, Mic, User } from "lucide-react";
import { Badge, Progress, StatHeader, EmptyState } from "../../../../renderer/src/components/shared";
import { VoiceCard } from "../../../../renderer/src/components/shared/VoiceCard";
import type { ScriptParagraph } from "../../../shared/types/entities/editor";
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
  onSetTtsEngine: (engine: string) => void;
  onSetTtsVoiceId: (id: string) => void;
  onSetSpeechRate: (rate: number) => void;
  onPreview: (idx: number, audioUrl: string) => void;
  onVoicePreview: (voiceId: string) => void;
  onSynthesize: () => void;
}

const ENGINE_LABELS: Record<string, string> = {
  edge: "Edge TTS", moss: "MOSS", doubao: "火山引擎", fish: "Fish Audio", sovits: "SoVITS",
};

export const StepTTSSynthesisView: React.FC<StepTTSSynthesisViewProps> = (props) => {
  const { ttsEngine, ttsVoiceId, ttsProgress, ttsResults, scriptParagraphs, isProcessing,
    voices, clonedVoices, speechRate, previewingVoiceId, playingIdx, successCount, failedCount,
    onSetTtsEngine, onSetTtsVoiceId, onSetSpeechRate, onPreview, onVoicePreview, onSynthesize } = props;

  const currentVoices = [...voices, ...clonedVoices.map((v) => ({ ...v, lang: "克隆" }))];

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
          {(["edge", "moss", "doubao", "fish", "sovits"] as const).map((eng) => (
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
              onSelect={onSetTtsVoiceId} onPreview={onVoicePreview} />
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
            onChange={(e) => onSetSpeechRate(parseFloat(e.target.value))} className="flex-1 h-1 accent-accent-cyan" />
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
            const pId = p.shotId || p.id || ''; const result = ttsResults.find((r) => (r.shotId || '') === pId) || ttsResults[idx] || null;
            const status = result ? (result._failed ? "failed" : result.audioUrl ? "completed" : "failed") : null;
            const isPlaying = playingIdx === idx;
            return (
              <div key={`tts-${idx}-${p.id}`} className="glass-card-sm p-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-accent font-mono shrink-0">{p.shotId || p.id}</span>
                    <Badge variant={status === "completed" ? "success" : status === "failed" ? "danger" : "default"}>
                      {status === "completed" ? "已完成" : status === "failed" ? "失败" : "待合成"}
                    </Badge>
                    {p.duration && <span className="text-[10px] text-muted-foreground">{p.duration}s</span>}
                  </div>
                  <div className="text-[13px] text-foreground truncate mt-0.5">{p.text}</div>
                </div>
                <button onClick={() => result?.audioUrl && onPreview(idx, result.audioUrl!)}
                  disabled={!result?.audioUrl || result._failed || isProcessing}
                  className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                    isPlaying ? "bg-accent/15 text-accent" : result?.audioUrl && !result._failed ? "bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20" : "bg-muted/20 text-muted-foreground/30 cursor-not-allowed"}`}>
                  {isPlaying ? <Square size={14} /> : <Play size={14} />}
                </button>
              </div>
            );
          })}
          <button onClick={onSynthesize} disabled={isProcessing}
            className="flex items-center justify-center gap-2 py-2 rounded-md text-[13px] bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50 font-medium cursor-pointer">
            <Mic size={14} className={isProcessing ? "animate-pulse" : ""} />{isProcessing ? "合成中..." : "开始合成"}
          </button>
        </div>
      ) : (
        <EmptyState title="配音待合成" description="文案确认后，TTS 引擎将逐段合成配音" iconType="audio" size="md" className="glass-card-sm" />
      )}
    </div>
  );
};
