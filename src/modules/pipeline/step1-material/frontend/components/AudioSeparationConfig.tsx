// Module: pipeline/step1-material - AudioSeparationConfig

import React from 'react';
import { Zap, Sparkles, Cpu, Gauge, Layers } from 'lucide-react';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import type { AudioConfig } from '@modules/pipeline/stores/useStep1Store';

interface AudioSeparationConfigProps {
  isRunning?: boolean;
}

/** 模式选项：fast=极速 / quality=高质量 */
const MODE_OPTIONS = [
  {
    value: 'fast',
    label: '极速',
    desc: '跳过分离，原始音轨',
    Icon: Zap,
    hint: '跳过 Demucs/MDX-Net 人声分离，ASR 直接使用含 BGM 的原始音轨。速度极快，但识别质量可能下降。',
  },
  {
    value: 'quality',
    label: '高质量',
    desc: 'Demucs/MDX-Net 分离',
    Icon: Sparkles,
    hint: '使用 AI 引擎分离人声与背景音，ASR 识别更精准。处理耗时较长。',
  },
] as const;

/** 引擎选项：仅在 quality 模式下可见 */
const ENGINE_OPTIONS = [
  {
    value: 'auto',
    label: '自动',
    desc: 'Demucs → MDX 降级',
    Icon: Layers,
    hint: '默认顺序：优先 Demucs（高保真），失败时降级到 MDX-Net（极速）',
  },
  {
    value: 'demucs',
    label: 'Demucs',
    desc: '重型，高保真',
    Icon: Cpu,
    hint: '使用 Demucs htdemucs 4-stem 模型，分离彻底、无渗音。适合最终导出/重剪合成。耗时较长。',
  },
  {
    value: 'mdx',
    label: 'MDX-Net',
    desc: '轻量，极速',
    Icon: Gauge,
    hint: '使用 MDX-Net (UVR-MDX-NET-Inst_HQ_4) 轻量模型，1-2 秒内完成。适合快速 ASR 识别。',
  },
] as const;

/** 引擎选择器：仅在 quality 模式下渲染 */
const EngineSelector: React.FC<{
  currentEngine: NonNullable<AudioConfig['engine']>;
  onChange: (engine: AudioConfig['engine']) => void;
  disabled: boolean;
}> = ({ currentEngine, onChange, disabled }) => {
  const activeHint = ENGINE_OPTIONS.find((o) => o.value === currentEngine)?.hint || '';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] text-muted-foreground/70 font-medium px-0.5">分离引擎</div>
      <div className="grid grid-cols-3 gap-1">
        {ENGINE_OPTIONS.map((opt) => {
          const isSelected = currentEngine === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              disabled={disabled}
              className={`
                flex flex-col items-center gap-0.5 py-1.5 px-1 rounded-md border text-center transition-all cursor-pointer outline-none select-none
                ${isSelected
                  ? 'bg-primary/10 border-primary/30 text-primary shadow-sm shadow-primary/5'
                  : 'bg-muted/30 border-border/50 text-muted-foreground hover:bg-muted/50 hover:border-border'}
                ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
              `}
            >
              <opt.Icon size={12} strokeWidth={isSelected ? 2.2 : 1.8} />
              <span className="text-[10px] font-semibold leading-tight">{opt.label}</span>
              <span className="text-[8px] opacity-50 leading-tight">{opt.desc}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[9px] text-muted-foreground/60 leading-relaxed bg-muted/30 p-1.5 rounded border border-border/30">
        {activeHint}
      </p>
    </div>
  );
};

export const AudioSeparationConfig: React.FC<AudioSeparationConfigProps> = ({ isRunning }) => {
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const audio = extractionConfig?.audio || { enabled: true, engine: 'auto' as const };
  const currentMode = audio.separationMode || 'quality';
  const currentEngine = audio.engine || 'auto';

  /** 切换模式：fast → quality 或反向 */
  const handleModeChange = (mode: 'fast' | 'quality') => {
    if (isRunning) return;
    updateExtractionConfig({
      audio: { ...audio, separationMode: mode },
    });
  };

  /** 切换引擎：仅在 quality 模式下生效 */
  const handleEngineChange = (engine: AudioConfig['engine']) => {
    if (isRunning) return;
    updateExtractionConfig({
      audio: { ...audio, engine },
    });
  };

  const activeHint = MODE_OPTIONS.find((o) => o.value === currentMode)?.hint || '';

  return (
    <div className={`flex flex-col gap-2.5 ${isRunning ? 'opacity-60 pointer-events-none' : ''}`}>
      {/* 模式选择：fast / quality */}
      <div className="grid grid-cols-2 gap-1.5">
        {MODE_OPTIONS.map((opt) => {
          const isSelected = currentMode === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => handleModeChange(opt.value)}
              disabled={isRunning}
              className={`
                flex flex-col items-center gap-1 py-2 px-1.5 rounded-lg border text-center transition-all cursor-pointer outline-none select-none
                ${isSelected
                  ? 'bg-primary/10 border-primary/30 text-primary shadow-sm shadow-primary/5'
                  : 'bg-muted/30 border-border/50 text-muted-foreground hover:bg-muted/50 hover:border-border'}
                ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}
              `}
            >
              <opt.Icon size={14} strokeWidth={isSelected ? 2.2 : 1.8} />
              <span className="text-[11px] font-semibold leading-tight">{opt.label}</span>
              <span className="text-[9px] opacity-50 leading-tight">{opt.desc}</span>
            </button>
          );
        })}
      </div>

      <p className="text-[9px] text-muted-foreground/60 leading-relaxed bg-muted/30 p-2 rounded border border-border/30">
        {activeHint}
      </p>

      {/* 引擎选择：仅在 quality 模式下显示 */}
      {currentMode === 'quality' && (
        <EngineSelector
          currentEngine={currentEngine}
          onChange={handleEngineChange}
          disabled={!!isRunning}
        />
      )}
    </div>
  );
};
