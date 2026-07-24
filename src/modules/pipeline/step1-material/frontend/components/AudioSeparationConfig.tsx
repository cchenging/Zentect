// Module: pipeline/step1-material - AudioSeparationConfig

import React from 'react';
import { Layers, Cpu, Gauge, Zap } from 'lucide-react';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import type { AudioConfig } from '@modules/pipeline/stores/useStep1Store';

interface AudioSeparationConfigProps {
  isRunning?: boolean;
}

/**
 * 分离策略选项：统一为 4 选 1 单控件
 * - auto: Demucs→MDX 智能降级（默认，放第一位）
 * - demucs: 高保真，慢
 * - mdx: 轻量，极速
 * - fast: 跳过模型，仅 ffmpeg 降采样（不走任何分离引擎）
 *
 * UI 内部映射到 store 的 separationMode + engine 双字段，保持底层兼容
 */
const STRATEGY_OPTIONS = [
  {
    value: 'auto' as const,
    label: '自动',
    desc: 'Demucs→MDX 降级',
    Icon: Layers,
    hint: '默认顺序：优先 Demucs（高保真），失败时自动降级到 MDX-Net（极速）。推荐大多数场景使用。',
  },
  {
    value: 'demucs' as const,
    label: 'Demucs',
    desc: '高保真，慢',
    Icon: Cpu,
    hint: '使用 Demucs htdemucs 4-stem 模型，分离彻底、无渗音。适合最终导出/重剪合成。耗时较长（2-5 分钟）。',
  },
  {
    value: 'mdx' as const,
    label: 'MDX-Net',
    desc: '轻量，极速',
    Icon: Gauge,
    hint: '使用 MDX-Net 轻量模型，1-2 秒内完成。适合快速 ASR 识别场景。',
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
  return (audio.engine as StrategyValue) || 'auto';
}

/** 将 strategy 映射回 store 的 separationMode + engine 双字段 */
function strategyToConfig(strategy: StrategyValue): Pick<AudioConfig, 'separationMode' | 'engine'> {
  if (strategy === 'fast') {
    return { separationMode: 'fast', engine: 'auto' };
  }
  return { separationMode: 'quality', engine: strategy };
}

export const AudioSeparationConfig: React.FC<AudioSeparationConfigProps> = ({ isRunning }) => {
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const audio = extractionConfig?.audio || { enabled: true, engine: 'auto' as const };
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
      {/* 分离策略：4 选 1 单选按钮组（2×2 网格） */}
      <div className="grid grid-cols-2 gap-1.5">
        {STRATEGY_OPTIONS.map((opt) => {
          const isSelected = currentStrategy === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => handleStrategyChange(opt.value)}
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
