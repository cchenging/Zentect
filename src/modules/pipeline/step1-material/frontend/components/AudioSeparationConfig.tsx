// Module: pipeline/step1-material - AudioSeparationConfig

import React from 'react';
import { Cpu, Gauge, Zap } from 'lucide-react';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import type { AudioConfig } from '@modules/pipeline/stores/useStep1Store';

interface AudioSeparationConfigProps {
  isRunning?: boolean;
}

/**
 * 分离策略选项：统一为 3 选 1 单控件
 * - mdx: 轻量，极速（默认，放第一位）
 * - demucs: 高保真，慢
 * - fast: 跳过模型，仅 ffmpeg 降采样（不走任何分离引擎）
 *
 * UI 内部映射到 store 的 separationMode + engine 双字段，保持底层兼容
 */
const STRATEGY_OPTIONS = [
  {
    value: 'mdx' as const,
    label: 'MDX-Net',
    desc: '轻量，极速',
    Icon: Gauge,
    hint: '使用 MDX-Net 轻量模型，1-2 秒内完成。适合快速 ASR 识别场景。',
  },
  {
    value: 'demucs' as const,
    label: 'Demucs',
    desc: '高保真，慢',
    Icon: Cpu,
    hint: '使用 Demucs htdemucs 4-stem 模型，分离彻底、无渗音。适合最终导出/重剪合成。耗时较长（2-5 分钟）。',
  },
  {
    value: 'fast' as const,
    label: '极速',
    desc: '跳过模型，仅降采样',
    Icon: Zap,
    hint: '跳过所有分离模型，直接用 ffmpeg 把音轨降采样到 16k mono 给 ASR。速度最快，但识别质量可能下降（含 BGM）。',
  },
] as const;

type StrategyValue = typeof STRATEGY_OPTIONS[number]['value'];

/** 从 store 的 separationMode + engine 推导当前 strategy 值 */
function deriveStrategy(audio: AudioConfig): StrategyValue {
  if (audio.separationMode === 'fast') return 'fast';
  return (audio.engine as StrategyValue) || 'mdx';
}

/** 将 strategy 映射回 store 的 separationMode + engine 双字段 */
function strategyToConfig(strategy: StrategyValue): Pick<AudioConfig, 'separationMode' | 'engine'> {
  if (strategy === 'fast') {
    return { separationMode: 'fast', engine: 'mdx' };
  }
  return { separationMode: 'quality', engine: strategy };
}

export const AudioSeparationConfig: React.FC<AudioSeparationConfigProps> = ({ isRunning }) => {
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const audio = extractionConfig?.audio || { enabled: true, engine: 'mdx' as const };
  const currentStrategy = deriveStrategy(audio);

  /** 切换策略：UI 单选 → store 双字段映射 */
  const handleStrategyChange = (strategy: StrategyValue) => {
    if (isRunning) return;
    updateExtractionConfig({
      audio: { ...audio, ...strategyToConfig(strategy) },
    });
  };

  const activeHint = STRATEGY_OPTIONS.find((o) => o.value === currentStrategy)?.hint || '';

  return (
    <div className={`flex flex-col gap-2.5 ${isRunning ? 'opacity-60 pointer-events-none' : ''}`}>
      {/* 分离策略：3 选 1 单选按钮组（三等分占满整行） */}
      <div className="grid grid-cols-3 gap-1.5 w-full">
        {STRATEGY_OPTIONS.map((opt) => {
          const isSelected = currentStrategy === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => handleStrategyChange(opt.value)}
              disabled={isRunning}
              className={`
                flex flex-row items-center gap-1.5 px-2.5 py-2 rounded-lg border transition-all cursor-pointer outline-none select-none w-full min-w-0
                ${isSelected
                  ? 'bg-accent/15 border-accent text-accent shadow-sm shadow-accent/10'
                  : `bg-muted/30 border-border/50 text-muted-foreground ${isRunning ? '' : 'hover:bg-muted/50 hover:border-border'}`}
                ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}
              `}
            >
              <opt.Icon size={14} strokeWidth={isSelected ? 2.4 : 1.8} className="shrink-0" />
              <span className="flex flex-col items-start gap-0.5 leading-tight min-w-0">
                <span className="text-[12px] font-semibold">{opt.label}</span>
                <span className={`text-[11px] ${isSelected ? 'text-accent/70' : 'opacity-60'}`}>{opt.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground/70 leading-relaxed bg-muted/30 p-2 rounded border border-border/30">
        {activeHint}
      </p>
    </div>
  );
};
