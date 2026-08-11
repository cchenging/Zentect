// Module: pipeline/step1-material - FrameExtractConfig
// P0 · 契约收拢 UI：4 策略按钮 → 2 模式（AUTO_ADAPTIVE / UNIFORM_FPS）+ 3 档密度预设。
// 隐藏细粒度滑块（sceneThreshold / fps / minFrameInterval），密度预设作为唯一真源（SSOT）。

import React from 'react';
import { Sparkles, Clock, Layers, Image as ImageIcon, AlertTriangle } from 'lucide-react';
import { Slider } from '@renderer/components/ui/slider';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
// P0 · 抽帧契约唯一真源（normalize + preset 配置）
import {
  normalizeFrameStrategy,
  DENSITY_PRESET_CONFIG,
  type DensityPreset,
} from '../../../../../shared/contracts/capabilities';

interface FrameExtractConfigProps {
  isRunning?: boolean;
}

// P0 · 2 模式替代原 4 策略：
// - AUTO_ADAPTIVE：原 VLM_OPTIMIZED / FAST_KEYFRAME / PRECISE_SINGLE 全部收拢到此
// - UNIFORM_FPS：原 UNIFORM / UNIFORM_FPS
const STRATEGY_OPTIONS = [
  {
    value: 'AUTO_ADAPTIVE' as const,
    label: '智能自适应',
    desc: '转场感知 + 预算封顶',
    Icon: Sparkles,
  },
  {
    value: 'UNIFORM_FPS' as const,
    label: '均匀抽帧',
    desc: '固定帧率，帧分布均匀',
    Icon: Clock,
  },
] as const;

// P0 · 3 档抽帧密度预设（与 DENSITY_PRESET_CONFIG 同步）
type DensityOption = {
  value: DensityPreset;
  label: string;
  shortDesc: string;
  hint: string;
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
};
const DENSITY_OPTIONS: DensityOption[] = [
  {
    value: 'sparse',
    label: '稀疏',
    shortDesc: '省 Token · 轻量',
    hint: '≈12 张/分钟',
    Icon: Layers,
  },
  {
    value: 'standard',
    label: '标准',
    shortDesc: '推荐 · 均衡',
    hint: '≈20 张/分钟',
    Icon: Layers,
  },
  {
    value: 'dense',
    label: '高密度',
    shortDesc: '动作捕捉 · 细节',
    hint: '≈35 张/分钟',
    Icon: Layers,
  },
];

const SCALE_OPTIONS = [
  { value: 640, label: '640' },
  { value: 1024, label: '1024' },
  { value: 0, label: '原始' },
];

export const FrameExtractConfig: React.FC<FrameExtractConfigProps> = ({ isRunning }) => {
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const frames = extractionConfig?.frames || {};

  // P0 · 策略归一化：所有历史别名 → 2 枚举（旧数据迁移在 zustand migrate 中已执行）
  const strategy = normalizeFrameStrategy(frames.mode, 'AUTO_ADAPTIVE');
  const isUniform = strategy === 'UNIFORM_FPS';

  // P0 · 密度预设：缺省回落到 standard（SSOT）
  const rawPreset = (frames.frameDensityPreset ?? (frames as any).density) as
    | DensityPreset
    | string
    | undefined;
  const densityPreset: DensityPreset =
    typeof rawPreset === 'string' && ['sparse', 'standard', 'dense'].includes(rawPreset)
      ? (rawPreset as DensityPreset)
      : 'standard';
  const presetConfig = DENSITY_PRESET_CONFIG[densityPreset];

  // P0 · 细粒度参数（不再在 UI 中调整，仅作显示使用 + 作为 patch 基准）
  const sceneThreshold = frames.sceneThreshold ?? presetConfig.sceneThreshold;
  const fps = frames.fps || 2;
  const scale = frames.scale ?? 1024;
  const quality = frames.quality ?? 3;
  const minInterval = frames.minFrameInterval ?? presetConfig.minFrameInterval;

  // 探测是否为 PRECISE_SINGLE 历史数据（仅展示一条提示条，不做功能）
  const isLegacyPreciseSingle =
    typeof frames.mode === 'string' &&
    /PRECISE|precise|single|SINGLE/.test(frames.mode);

  /**
   *  更新抽帧帧配置（P0 增强：切 densityPreset 时同步派生 sceneThreshold/minFrameInterval/fps）
   */
  const updateFrames = (patch: Record<string, any>) => {
    if (isRunning) return;

    // 如果是切换 densityPreset → 同步把 preset 里的参数带进去（作为隐藏字段的真源）
    let extraPatch: Record<string, any> = {};
    const nextPreset: DensityPreset | undefined = patch.frameDensityPreset as
      | DensityPreset
      | undefined;
    if (nextPreset && DENSITY_PRESET_CONFIG[nextPreset]) {
      const cfg = DENSITY_PRESET_CONFIG[nextPreset];
      // 均匀模式：fps 直接从 framesPerMinute 派生（= framesPerMinute / 60）
      const effectiveStrategy = patch.mode ?? strategy;
      if (effectiveStrategy === 'UNIFORM_FPS') {
        extraPatch.fps = Math.max(0.1, +(cfg.framesPerMinute / 60).toFixed(2));
      }
      // 自适应：sceneThreshold / minFrameInterval 走 preset
      extraPatch.sceneThreshold = cfg.sceneThreshold;
      extraPatch.minFrameInterval = cfg.minFrameInterval;
      // 同步清掉旧 density 字段，避免与 frameDensityPreset 双写
      extraPatch.density = undefined;
    }

    const nextThreshold = extraPatch.sceneThreshold ?? patch.sceneThreshold ?? sceneThreshold;
    updateExtractionConfig({
      frames: {
        ...frames,
        ...patch,
        ...extraPatch,
        // 🔧 修复 TS2353：frames 配置无 value 字段，统一用 sceneThreshold
        sceneThreshold: nextThreshold,
      },
    });
  };

  return (
    <div
      className={`flex flex-col gap-3 ${
        isRunning ? 'opacity-60 pointer-events-none' : ''
      }`}
    >
      {/* P0 · 2 模式选择 */}
      <div className="grid grid-cols-2 gap-1.5">
        {STRATEGY_OPTIONS.map((opt) => {
          const isSelected = strategy === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => updateFrames({ mode: opt.value })}
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
              <span className="text-[12px] font-semibold leading-tight">
                {opt.label}
              </span>
              <span className="text-[11px] opacity-60 leading-tight">{opt.desc}</span>
            </button>
          );
        })}
      </div>

      {/* PRECISE_SINGLE 历史数据提示条（只读） */}
      {isLegacyPreciseSingle && (
        <div
          className="flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300/90"
          role="note"
        >
          <AlertTriangle size={12} className="mt-[1px] shrink-0" />
          <span>
            旧版「精准单帧」已收拢为「智能自适应」；定点截图请调用独立截图 API，不再出现在抽帧策略中。
          </span>
        </div>
      )}

      {/* P0 · 3 档抽帧密度预设（SSOT，两模式均显示） */}
      <div
        className="rounded-lg border border-border/50 bg-muted/20 p-2.5 shadow-inner flex flex-col gap-2"
      >
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-foreground/80">抽帧密度</span>
          <span
            className="text-[11px] font-mono text-muted-foreground/70"
            title="预算封顶：最大帧数 = 视频分钟数 × 每分钟帧数（±10% 容差）"
          >
            预算 {presetConfig.framesPerMinute} 张/分钟 · 最小间隔{' '}
            {presetConfig.minFrameInterval}s
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {DENSITY_OPTIONS.map((opt) => {
            const isSelected = densityPreset === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => updateFrames({ frameDensityPreset: opt.value })}
                disabled={isRunning}
                className={`
                  flex flex-col items-center gap-0.5 py-1.5 px-1 rounded-md border text-center transition-all cursor-pointer outline-none select-none
                  ${isSelected
                    ? 'bg-primary/12 border-primary/40 text-primary shadow-sm shadow-primary/5'
                    : 'bg-background/40 border-border/40 text-muted-foreground hover:bg-background/70 hover:border-border/70'}
                  ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}
                `}
              >
                <div className="flex items-center gap-1">
                  <opt.Icon size={11} strokeWidth={isSelected ? 2.2 : 1.8} />
                  <span className="text-[12px] font-semibold leading-tight">
                    {opt.label}
                  </span>
                </div>
                <span className="text-[10.5px] opacity-70 leading-tight">
                  {opt.shortDesc}
                </span>
                <span
                  className={`text-[10px] font-mono ${
                    isSelected ? 'text-primary/80' : 'text-muted-foreground/60'
                  }`}
                >
                  {opt.hint}
                </span>
              </button>
            );
          })}
        </div>

        {/* P0 · 预设说明：按模式展示辅助文案（不再展示细粒度滑块） */}
        <p
          className="text-[11px] text-muted-foreground/75 leading-relaxed bg-muted/30 p-2 rounded border border-border/30"
        >
          {!isUniform
            ? `「智能自适应」结合镜头转场检测（灵敏度 ${sceneThreshold}）与 ${minInterval}s 兜底采样，再按「${presetConfig.label}」预算封顶，避免长视频爆 Token。`
            : `「均匀抽帧」按 ${presetConfig.label} 档位（${presetConfig.framesPerMinute} 张/分钟）均匀采样；当前实际帧率 ${fps} 帧/秒，同样受预算封顶保护。`}
        </p>
      </div>

      {/* 通用输出参数：缩放宽度 + 画质 */}
      <div className="grid grid-cols-2 gap-1.5">
        <div
          className="rounded-lg border border-border/50 bg-muted/20 p-2 flex flex-col gap-1.5 shadow-sm"
        >
          <span className="text-[12px] text-muted-foreground flex items-center gap-1">
            <ImageIcon size={11} /> 缩放宽度
          </span>
          <div className="flex gap-1">
            {SCALE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => updateFrames({ scale: opt.value })}
                disabled={isRunning}
                className={`flex-1 text-[11px] py-0.5 rounded transition-all cursor-pointer border ${
                  scale === opt.value
                    ? 'bg-primary/10 text-primary font-semibold border-primary/20'
                    : 'bg-muted/40 text-muted-foreground border-transparent hover:bg-muted/60 hover:text-foreground'
                } ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div
          className="rounded-lg border border-border/50 bg-muted/20 p-2 flex flex-col gap-1.5 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-muted-foreground">画质</span>
            <span className="text-[12px] font-mono text-accent-warm font-semibold">
              {quality}/5
            </span>
          </div>
          <Slider
            min={1}
            max={5}
            step={1}
            value={[quality]}
            onValueChange={([v]) => updateFrames({ quality: v })}
            disabled={isRunning}
          />
        </div>
      </div>
    </div>
  );
};
