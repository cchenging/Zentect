// ParameterSlider - compatibility stub
import React from 'react';

interface ParameterSliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}

export const ParameterSlider: React.FC<ParameterSliderProps> = ({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange
}) => {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-gray-600">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </div>
  );
};

export default ParameterSlider;
