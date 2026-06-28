import React from "react";

export interface SpeechRateSelectorProps {
  value: number;
  onChange: (rate: number) => void;
  disabled?: boolean;
}

const OPTIONS = [
  { value: 5.5, label: "5.5 字/秒 (紧凑)", desc: "信息密度高，适合快节奏解说" },
  { value: 5.0, label: "5.0 字/秒 (轻快)", desc: "明快节奏，可读性好" },
  { value: 4.5, label: "4.5 字/秒 (标准)", desc: "自然说话节奏（推荐）" },
  { value: 4.0, label: "4.0 字/秒 (舒缓)", desc: "娓娓道来感" },
  { value: 3.5, label: "3.5 字/秒 (低缓)", desc: "语调低沉，适合情感类" },
];

export const SpeechRateSelector: React.FC<SpeechRateSelectorProps> = ({ value, onChange, disabled }) => (
  <div className="glass-card-sm p-3 flex flex-col gap-2">
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground">语速控制</span>
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary text-accent font-mono">{value}字/秒</span>
    </div>
    <div className="flex flex-wrap gap-1.5">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          disabled={disabled}
          title={opt.desc}
          className={`text-[11px] px-2.5 py-1 rounded-md border transition-all cursor-pointer outline-none ${
            value === opt.value
              ? "border-accent bg-accent/10 text-accent font-medium"
              : "border-border/30 bg-bg-secondary text-muted-foreground hover:border-accent/40"
          } ${disabled ? "opacity-50" : ""}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  </div>
);