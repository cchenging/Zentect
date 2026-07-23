// Module: pipeline/step1-material - AudioSeparationConfig

import React from 'react';
import { Zap, Sparkles } from 'lucide-react';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';

interface AudioSeparationConfigProps {
  isRunning?: boolean;
}

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

export const AudioSeparationConfig: React.FC<AudioSeparationConfigProps> = ({ isRunning }) => {
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const audio = extractionConfig?.audio || { enabled: true };
  const currentMode = audio.separationMode || 'quality';

  const handleModeChange = (mode: 'fast' | 'quality') => {
    if (isRunning) return;
    updateExtractionConfig({
      audio: { ...audio, separationMode: mode },
    });
  };

  const activeHint = MODE_OPTIONS.find((o) => o.value === currentMode)?.hint || '';

  return (
    <div className={`flex flex-col gap-2.5 ${isRunning ? 'opacity-60 pointer-events-none' : ''}`}>
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
    </div>
  );
};
