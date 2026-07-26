// ParameterSlider - compatibility stub
import React from 'react';

// 🔧 修复 TS2322：与 parameter-slider.tsx 对齐，补充 code/unit/desc 等可选字段
interface ParameterSliderProps {
  label: string;
  code?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  unit?: string;
  desc?: string;
}

export const ParameterSlider: React.FC<ParameterSliderProps> = ({
  label,
  code,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  disabled,
  unit = '%',
  desc,
}) => {
  return (
    <div className="flex flex-col gap-1" title={desc}>
      <label className="text-sm text-gray-600">
        {code && <span className="text-accent font-mono mr-1">{code}</span>}
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
      <span className="text-[11px] text-accent font-mono text-right">{value}{unit}</span>
    </div>
  );
};

export default ParameterSlider;
