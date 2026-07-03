import React, { useState, useMemo } from "react";
import { Sliders, RefreshCw, Tag, Search } from "lucide-react";
import { SCRIPT_STYLES } from "../../../utils/pipelineConstants";
import { Badge, StatHeader, EmptyState } from "../../../../../components/shared";
import { ParameterSlider } from "../../../../../components/shared/ParameterSlider";
import type { ScriptParagraph, VlmFrame, PipelineParams } from "../../../../../../../shared/types/entities/editor";

export interface StepScriptGenerationProps {
  scriptParagraphs: ScriptParagraph[];
  scriptStyle: string;
  speechRate: number;
  pipelineParams: PipelineParams;
  vlmFrames: VlmFrame[];
  isGenerating: boolean;
  onSetScriptStyle: (style: string) => void;
  onSetSpeechRate: (rate: number) => void;
  onSetPipelineParams: (params: PipelineParams) => void;
  onUpdateParagraph: (id: string, text: string) => void;
  onUpdateParagraphEmotion: (id: string, emotion: string) => void;
  onSetScriptParagraphs: (paragraphs: ScriptParagraph[]) => void;
  onRegenerate: () => void;
  onMatchVision: (paragraphId: string) => void;
}

const SPEECH_RATE_OPTIONS = [
  { value: 5.5, label: "5.5 字/秒 (紧凑)" },
  { value: 5.0, label: "5.0 字/秒 (轻快)" },
  { value: 4.5, label: "4.5 字/秒 (标准)" },
  { value: 4.0, label: "4.0 字/秒 (舒缓)" },
  { value: 3.5, label: "3.5 字/秒 (低缓)" },
];

const EMOTIONS = ["激昂", "温馨", "幽默", "平静", "紧张", "感慨", "震撼", "庄重"];

export const StepScriptGenerationView: React.FC<StepScriptGenerationProps> = (props) => {
  const { scriptParagraphs, scriptStyle, speechRate, pipelineParams, vlmFrames, isGenerating,
    onSetScriptStyle, onSetSpeechRate, onSetPipelineParams, onUpdateParagraph,
    onUpdateParagraphEmotion, onRegenerate, onMatchVision } = props;

  const [matchingParagraphId, setMatchingParagraphId] = useState<string | null>(null);

  const totalChars = useMemo(() => scriptParagraphs.reduce((s, p) => s + (p.text?.length || 0), 0), [scriptParagraphs]);
  const estimatedDuration = useMemo(() => Math.ceil(totalChars / speechRate), [totalChars, speechRate]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold">AI 解说文案</div>
        {scriptParagraphs.length > 0 && <StatHeader value={scriptParagraphs.length} unit="段文案" secondary={`预估 ${Math.ceil(scriptParagraphs.reduce((s, p) => s + (p.duration || 0), 0) / 60)} 分钟`} />}
      </div>

      {/* 风格选择 */}
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground shrink-0">风格:</span>
        <select value={scriptStyle} onChange={(e) => onSetScriptStyle(e.target.value)} disabled={isGenerating}
          className="text-[13px] px-2 py-1 rounded-md bg-bg-secondary border border-border/30 text-foreground outline-none cursor-pointer">
          {SCRIPT_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* R/S/T/P 参数 */}
      <div className="glass-card-sm p-3 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Sliders size={12} /> 管线参数</div>
        <ParameterSlider label="经典保留" code="R" value={pipelineParams.R} onChange={(v) => onSetPipelineParams({ ...pipelineParams, R: v })} disabled={isGenerating} unit="%" />
        <ParameterSlider label="原台词保留" code="S" value={pipelineParams.S} onChange={(v) => onSetPipelineParams({ ...pipelineParams, S: v })} disabled={isGenerating} unit="%" />
        <ParameterSlider label="TTS覆盖" code="T" value={pipelineParams.T} onChange={(v) => onSetPipelineParams({ ...pipelineParams, T: v })} disabled={isGenerating} unit="%" />
        <ParameterSlider label="节奏因子" code="P" value={pipelineParams.P} onChange={(v) => onSetPipelineParams({ ...pipelineParams, P: v })} disabled={isGenerating} unit="%" />
      </div>

      {/* 语速 */}
      <div className="glass-card-sm p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-muted-foreground">语速控制</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary text-accent font-mono">{speechRate}字/秒</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>当前字数: <span className="text-foreground font-mono">{totalChars}</span></span>
          <span>预估时长: <span className="text-foreground font-mono">{estimatedDuration}s</span></span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SPEECH_RATE_OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => onSetSpeechRate(opt.value)} disabled={isGenerating}
              className={`text-[13px] px-2.5 py-1 rounded-md border transition-all cursor-pointer ${speechRate === opt.value ? "border-accent bg-accent/10 text-accent font-medium" : "border-border/30 bg-bg-secondary text-muted-foreground hover:border-accent/40"} ${isGenerating ? "opacity-50" : ""}`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 文案编辑 */}
      {scriptParagraphs.length > 0 ? (
        <div className="flex flex-col gap-2">
          {scriptParagraphs.map((p) => {
            const pId = p.id || p.shotId || "";
            return (
              <div key={pId} className="glass-card-sm p-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-[10px] text-accent font-mono">{p.shotId || p.id}</span>
                  {p.duration && <span className="text-[10px] text-muted-foreground">{p.duration}s</span>}
                  <div className="flex items-center gap-1 ml-auto">
                    <Tag size={10} className="text-muted-foreground" />
                    <select value={p.emotion || ""} onChange={(e) => onUpdateParagraphEmotion(p.id, e.target.value)}
                      className="text-[10px] px-1.5 py-0.5 rounded border outline-none cursor-pointer bg-bg-secondary text-muted-foreground">
                      <option value="">无标签</option>
                      {EMOTIONS.map((em) => <option key={em} value={em}>{em}</option>)}
                    </select>
                    {p.emotion && <Badge variant="accent" className="text-[10px]">{p.emotion}</Badge>}
                  </div>
                </div>
                <textarea value={p.text} onChange={(e) => onUpdateParagraph(p.id, e.target.value)} className="w-full text-[13px] leading-relaxed bg-transparent outline-none resize-none min-h-[48px]" />
                <div className="flex items-center gap-2 mt-1 pt-1 border-t border-border/20">
                  <button onClick={() => { setMatchingParagraphId(pId); onMatchVision(pId); }} disabled={!vlmFrames.length || matchingParagraphId === pId}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-accent transition-colors cursor-pointer disabled:opacity-40">
                    <Search size={10} />{matchingParagraphId === pId ? "匹配中..." : "匹配画面"}
                  </button>
                </div>
              </div>
            );
          })}
          <button onClick={onRegenerate} disabled={isGenerating}
            className="flex items-center justify-center gap-2 py-2 rounded-md text-[13px] bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 font-medium cursor-pointer">
            <RefreshCw size={14} className={isGenerating ? "animate-pulse" : ""} />{isGenerating ? "生成中..." : "重新生成"}
          </button>
        </div>
      ) : (
        <EmptyState title="解说文案待生成" description="完成画面描述后，AI 将生成解说文案" iconType="media" size="md" className="glass-card-sm" />
      )}
    </div>
  );
};