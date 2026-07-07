import React from "react";
import { Sliders } from "lucide-react";
import { ParameterSlider } from "../../../../components/shared/parameter-slider";
import type { PipelineParams } from "../../../../../shared/types/entities/editor";

export interface RSTPParamPanelProps {
  params: PipelineParams;
  onChange: (params: PipelineParams) => void;
  disabled?: boolean;
}

const PARAM_LABELS: Record<keyof PipelineParams, string> = {
  R: "经典保留",
  S: "原台词保留",
  T: "TTS覆盖",
  P: "节奏因子",
};

export const RSTPParamPanel: React.FC<RSTPParamPanelProps> = ({ params, onChange, disabled }) => {
  const keys = Object.keys(params) as (keyof PipelineParams)[];
  return (
    <div className="glass-card-sm p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Sliders size={12} /> 管线参数
      </div>
      {keys.map((key) => (
        <ParameterSlider
          key={key}
          label={PARAM_LABELS[key]}
          code={key}
          value={params[key]}
          onChange={(v) => onChange({ ...params, [key]: v })}
          disabled={disabled}
          unit="%"
        />
      ))}
    </div>
  );
};