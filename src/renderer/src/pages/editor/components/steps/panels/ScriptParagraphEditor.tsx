import React from "react";
import { Tag, AlertTriangle, Search } from "lucide-react";
import { Badge } from "../../../../components/shared";
import type { ScriptParagraph } from "../../../../../shared/types/entities/editor";

export interface ScriptParagraphEditorProps {
  paragraphs: ScriptParagraph[];
  onUpdate: (id: string, text: string) => void;
  onEmotionChange: (id: string, emotion: string) => void;
  onMatchVision?: (id: string) => void;
  vlmFramesCount?: number;
  isMatching?: string | null;
  matchResults?: Record<string, unknown[]>;
  disabled?: boolean;
}

const EMOTIONS = ["激昂", "温馨", "幽默", "平静", "紧张", "感慨", "震撼", "庄重"];

export const ScriptParagraphEditor: React.FC<ScriptParagraphEditorProps> = ({
  paragraphs, onUpdate, onEmotionChange, onMatchVision, vlmFramesCount, isMatching, disabled,
}) => (
  <div className="flex flex-col gap-2">
    {paragraphs.map((p) => {
      const pId = p.id || p.shotId || "";
      return (
        <div key={pId} className="glass-card-sm p-3">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-[10px] text-accent font-mono">{p.shotId || p.id}</span>
            {p.duration && <span className="text-[10px] text-muted-foreground">{p.duration}s</span>}
            <div className="flex items-center gap-1 ml-auto">
              <Tag size={10} className="text-muted-foreground" />
              <select
                value={p.emotion || ""}
                onChange={(e) => onEmotionChange(p.id, e.target.value)}
                className="text-[10px] px-1.5 py-0.5 rounded border outline-none cursor-pointer bg-bg-secondary text-muted-foreground"
              >
                <option value="">无标签</option>
                {EMOTIONS.map((em) => <option key={em} value={em}>{em}</option>)}
              </select>
              {p.emotion && <Badge variant="accent" className="text-[10px]">{p.emotion}</Badge>}
            </div>
          </div>
          <textarea
            value={p.text}
            onChange={(e) => onUpdate(p.id, e.target.value)}
            disabled={disabled}
            className="w-full text-[13px] leading-relaxed bg-transparent outline-none resize-none min-h-[48px]"
          />
          {onMatchVision && (
            <div className="flex items-center gap-2 mt-1 pt-1 border-t border-border/20">
              <button
                onClick={() => onMatchVision(pId)}
                disabled={!vlmFramesCount || isMatching === pId || disabled}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-accent transition-colors cursor-pointer disabled:opacity-40"
              >
                <Search size={10} />
                {isMatching === pId ? "匹配中..." : "匹配画面"}
              </button>
            </div>
          )}
        </div>
      );
    })}
  </div>
);