// Module: pipeline/step1-material - FrameExtractConfig

import React from 'react';
import { Sparkles, Clock, Zap, Crosshair, Sliders, Image as ImageIcon } from 'lucide-react';
import { Slider } from '../../../../../renderer/src/components/ui/slider';
import { Input } from '../../../../../renderer/src/components/ui/input';
import { useStep1Store } from '../../../stores/useStep1Store';

const STRATEGY_OPTIONS = [
  { value: 'VLM_OPTIMIZED', label: 'VLM 最优化', desc: '转场+兜底', Icon: Sparkles },
  { value: 'UNIFORM_FPS', label: '均匀抽帧', desc: '固定帧率', Icon: Clock },
  { value: 'FAST_KEYFRAME', label: '极速关键帧', desc: '仅I帧', Icon: Zap },
  { value: 'PRECISE_SINGLE', label: '精准单帧', desc: '定点截图', Icon: Crosshair },
] as const;

const SCALE_OPTIONS = [
  { value: 640, label: '640' },
  { value: 1024, label: '1024' },
  { value: 0, label: '原始' },
];

export const FrameExtractConfig: React.FC = () => {
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const frames = extractionConfig?.frames || {};
  const rawMode = (frames.mode || 'VLM_OPTIMIZED').toUpperCase();
  const MODE_MAP: Record<string, string> = {
    'VLM_OPTIMIZED': 'VLM_OPTIMIZED', 'UNIFORM_FPS': 'UNIFORM_FPS',
    'FAST_KEYFRAME': 'FAST_KEYFRAME', 'PRECISE_SINGLE': 'PRECISE_SINGLE',
    'UNIFORM': 'UNIFORM_FPS', 'SCENE': 'VLM_OPTIMIZED', 'IFRAME': 'FAST_KEYFRAME',
  };
  const strategy = MODE_MAP[rawMode] || 'VLM_OPTIMIZED';
  const sceneThreshold = frames.sceneThreshold ?? (frames as any).value ?? 0.28;
  const fps = frames.fps || 2;
  const scale = frames.scale ?? 1024;
  const quality = frames.quality ?? 3;
  const minInterval = frames.minFrameInterval ?? 4;

  const updateFrames = (patch: Record<string, any>) => {
    const nextThreshold = patch.sceneThreshold ?? sceneThreshold;
    updateExtractionConfig({
      frames: {
        ...frames,
        ...patch,
        sceneThreshold: nextThreshold,
        value: nextThreshold
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-1.5">
        {STRATEGY_OPTIONS.map((opt) => {
          const isSelected = strategy === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => updateFrames({ mode: opt.value })}
              className={`
                flex flex-col items-center gap-1 py-2 px-1.5 rounded-lg border text-center transition-all cursor-pointer outline-none select-none
                ${isSelected
                  ? 'bg-primary/10 border-primary/30 text-primary shadow-sm shadow-primary/5'
                  : 'bg-muted/30 border-border/50 text-muted-foreground hover:bg-muted/50 hover:border-border'}
              `}
            >
              <opt.Icon size={14} strokeWidth={isSelected ? 2.2 : 1.8} />
              <span className="text-[11px] font-semibold leading-tight">{opt.label}</span>
              <span className="text-[9px] opacity-50 leading-tight">{opt.desc}</span>
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-border/50 bg-muted/20 p-2.5 shadow-inner">
        {strategy === 'VLM_OPTIMIZED' && (
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Sliders size={10} /> 灵敏度
                  </span>
                  <span className="text-[10px] font-mono text-accent-green font-semibold bg-accent-green/10 px-1.5 rounded">{sceneThreshold}</span>
                </div>
                <Slider min={0.1} max={0.5} step={0.01} value={[sceneThreshold]} onValueChange={([v]) => updateFrames({ sceneThreshold: v })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">最小间隔</span>
                  <span className="text-[10px] font-mono text-accent-cyan font-semibold bg-accent-cyan/10 px-1.5 rounded">{minInterval}s</span>
                </div>
                <Slider min={1} max={10} step={1} value={[minInterval]} onValueChange={([v]) => updateFrames({ minFrameInterval: v })} />
              </div>
            </div>
            <p className="text-[9px] text-muted-foreground/60 leading-relaxed bg-muted/30 p-2 rounded border border-border/30">
              场景转场自动捕捉 + {minInterval}秒无转场自动补帧，防止文戏丢失
            </p>
          </div>
        )}

        {strategy === 'UNIFORM_FPS' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">抽取频率</span>
              <span className="text-[10px] font-mono text-accent-cyan font-semibold bg-accent-cyan/10 px-1.5 rounded">{fps} 帧/秒</span>
            </div>
            <Slider min={0.1} max={5} step={0.1} value={[fps]} onValueChange={([v]) => { updateFrames({ fps: v }); }} />
            <div className="flex justify-between text-[8px] text-muted-foreground/40 px-0.5">
              <span>稀疏</span><span>密集</span>
            </div>
          </div>
        )}

        {strategy === 'FAST_KEYFRAME' && (
          <p className="text-[10px] text-muted-foreground/70 leading-relaxed text-center py-1">
            直接提取编码层原生 I 帧，速度极快，帧分布可能不均匀
          </p>
        )}

        {strategy === 'PRECISE_SINGLE' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">截图时间点</span>
              <span className="text-[10px] font-mono text-foreground">{(frames as any).timePoint ?? 0}s</span>
            </div>
            <Input
              type="number" min={0} step={0.1}
              value={(frames as any).timePoint ?? 0}
              onChange={(e) => updateFrames({ timePoint: parseFloat(e.target.value) || 0 })}
              placeholder="秒，如 12.5"
              className="h-7 text-[11px] font-mono"
            />
          </div>
        )}
      </div>

      {strategy !== 'PRECISE_SINGLE' && (
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded-lg border border-border/50 bg-muted/20 p-2 flex flex-col gap-1.5 shadow-sm">
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <ImageIcon size={10} /> 缩放宽度
            </span>
            <div className="flex gap-1">
              {SCALE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => updateFrames({ scale: opt.value })}
                  className={`flex-1 text-[9px] py-0.5 rounded transition-all cursor-pointer border ${
                    scale === opt.value
                      ? 'bg-primary/10 text-primary font-semibold border-primary/20'
                      : 'bg-muted/40 text-muted-foreground border-transparent hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-border/50 bg-muted/20 p-2 flex flex-col gap-1.5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">画质</span>
              <span className="text-[10px] font-mono text-accent-warm font-semibold">{quality}/5</span>
            </div>
            <Slider min={1} max={5} step={1} value={[quality]} onValueChange={([v]) => updateFrames({ quality: v })} />
          </div>
        </div>
      )}
    </div>
  );
};
