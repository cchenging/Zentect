import React from 'react';

export interface ParameterSliderProps {
  label: string; code?: string; value: number;
  min?: number; max?: number; step?: number;
  onChange: (value: number) => void;
  disabled?: boolean; unit?: string; desc?: string;
}

export const ParameterSlider: React.FC<ParameterSliderProps> = ({
  label, code, value, min = 0, max = 100, step = 1,
  onChange, disabled, unit = '%', desc,
}) => (
  <div className="flex items-center gap-2" title={desc}>
    <span className="w-24 text-[11px] text-foreground font-medium shrink-0">
      {code && <span className="text-accent font-mono mr-1">{code}</span>}
      {label}
    </span>
    <input type="range" min={min} max={max} step={step} value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="flex-1 h-1 accent-accent" />
    <span className="w-10 text-[11px] text-accent font-mono text-right">{value}{unit}</span>
  </div>
);