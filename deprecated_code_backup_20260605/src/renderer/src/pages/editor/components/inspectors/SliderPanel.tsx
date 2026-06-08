import { Slider } from '../../../../components/ui/slider';
import { useEditorStore } from '../../../../store/useStore';
import { useDebouncedParams } from '../../hooks/useDebouncedParams';
import { Film, Mic, Volume2, Gauge } from 'lucide-react';

/** 参数标签配置 */
const PARAM_CONFIG = [
  { key: 'R' as const, label: '经典片段保留', icon: Film, hint: '控制 AI 保留原始经典片段比例', left: '全删', right: '全留' },
  { key: 'S' as const, label: '原台词保留', icon: Mic, hint: '控制 AI 保留/重写原始语音台词比例', left: '全重写', right: '全保留' },
  { key: 'T' as const, label: 'TTS 覆盖', icon: Volume2, hint: '控制 AI 使用 TTS 配音的比例', left: '原音', right: '全配音' },
  { key: 'P' as const, label: '节奏', icon: Gauge, hint: '控制成片节奏', left: '缓慢', right: '快节奏' },
];

/** V1.1 R/S/T/P 参数调节面板 — 四滑块 + 500ms 防抖 */
export const SliderPanel = () => {
  const pipelineParams = useEditorStore((s) => s.pipelineParams);
  const setPipelineParams = useEditorStore((s) => s.setPipelineParams);
  useDebouncedParams();

  return (
    <div className="space-y-5 animate-in fade-in duration-300 p-1">
      {PARAM_CONFIG.map(({ key, label, icon: Icon, hint, left, right }) => (
        <div key={key} className="space-y-2.5">
          <div className="flex justify-between items-center">
            <label className="text-[11px] text-zinc-300 flex items-center gap-1.5">
              <Icon size={12} className="text-blue-400" />
              {label}
            </label>
            <span className="text-[10px] text-zinc-400 font-mono bg-zinc-900/80 px-1.5 py-0.5 rounded border border-zinc-800">
              {pipelineParams[key]}%
            </span>
          </div>
          <Slider
            value={[pipelineParams[key]]}
            min={0}
            max={100}
            step={1}
            onValueChange={(v) => setPipelineParams({ ...pipelineParams, [key]: v[0] })}
          />
          <div className="flex justify-between text-[9px] text-zinc-500 font-mono -mt-1.5">
            <span>{left}</span>
            <span>{right}</span>
          </div>
          <p className="text-[9px] text-zinc-600 leading-tight">{hint}</p>
        </div>
      ))}
    </div>
  );
};
