import { useCallback } from 'react';
import { useEditorStore } from '../../../../../store/useStore';
import { AppIcon } from '../../../../../components/app-icon';

interface FrameExtractData {
  fps: number;
  strategy: 'uniform' | 'scene' | 'iframe';
  threshold?: number;
  outputFiles?: string[];
  previewUrls?: string[];
}

// 💥 将 icon 组件替换为 iconName 字符串
const STRATEGY_OPTIONS = [
  { value: 'uniform', label: '等距抽帧', desc: '按固定帧率均匀抽取', iconName: 'Clock' },
  { value: 'scene', label: '场景侦测', desc: '仅在画面发生大幅变化时抽取', iconName: 'LayoutTemplate' },
  { value: 'iframe', label: 'I帧提取', desc: '快速提取视频原生关键帧', iconName: 'Film' },
] as const;

export const FrameExtractConfig = ({ nodeId, data }: { nodeId: string; data: Partial<FrameExtractData> }) => {
  const updateNodeData = useEditorStore((s) => s.updateNodeData);

  const fps = data.fps || 1;
  const strategy = data.strategy || 'uniform';
  const threshold = data.threshold || 0.3;

  const handleChange = useCallback((key: string, value: any) => {
    updateNodeData(nodeId, { [key]: value });
  }, [nodeId, updateNodeData]);

  if (data.previewUrls && data.previewUrls.length > 0) {
    return (
      <div className="p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
            <AppIcon name="CheckCircle2" size={14} className="text-emerald-500" />
            提取成功 ({data.previewUrls.length} 帧)
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1.5 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
          {data.previewUrls.slice(0, 18).map((url, idx) => (
            <div key={idx} className="aspect-video bg-black rounded overflow-hidden border border-white/5 relative group">
              <img src={url} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt={`frame ${idx}`} />
              <span className="absolute bottom-0.5 right-1 text-[8px] bg-black/60 px-1 rounded text-white/80">{idx + 1}</span>
            </div>
          ))}
        </div>
        {data.previewUrls.length > 18 && (
          <div className="text-center text-[10px] text-zinc-500 pt-1 border-t border-white/5">
            滚动查看更多...
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-xs font-bold text-zinc-400 tracking-wider">抽取策略 (Strategy)</span>
        <div className="flex flex-col gap-1.5">
          {STRATEGY_OPTIONS.map((opt) => {
            const isSelected = strategy === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => handleChange('strategy', opt.value)}
                className={`
                  flex items-start gap-3 p-2.5 rounded-lg border text-left transition-all cursor-pointer outline-none
                  ${isSelected ? 'bg-blue-500/10 border-blue-500/40 text-blue-100' : 'bg-zinc-900 border-white/5 text-zinc-400 hover:bg-zinc-800 hover:border-white/10'}
                `}
              >
                <div className={`mt-0.5 ${isSelected ? 'text-blue-400' : 'text-zinc-500'}`}>
                  <AppIcon name={opt.iconName} size={14} />
                </div>
                <div className="flex flex-col">
                  <span className="text-[12px] font-semibold">{opt.label}</span>
                  <span className="text-[10px] opacity-60 mt-0.5">{opt.desc}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-4 bg-zinc-900/50 p-3 rounded-lg border border-white/5">
        {strategy === 'uniform' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                <AppIcon name="Clock" size={12} className="text-zinc-500" />
                抽取频率 (FPS)
              </span>
              <span className="text-xs font-mono text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">{fps} 帧/秒</span>
            </div>
            <input type="range" min="0.1" max="10" step="0.1" value={fps} onChange={(e) => handleChange('fps', parseFloat(e.target.value))} className="w-full accent-blue-500 h-1.5 bg-zinc-800 rounded-full appearance-none cursor-pointer" />
            <div className="flex justify-between text-[9px] text-zinc-600 px-1"><span>稀疏 (0.1)</span><span>密集 (10)</span></div>
          </div>
        )}

        {strategy === 'scene' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                <AppIcon name="LayoutTemplate" size={12} className="text-zinc-500" />
                变化阈值 (Threshold)
              </span>
              <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">{threshold}</span>
            </div>
            <input type="range" min="0.1" max="0.9" step="0.05" value={threshold} onChange={(e) => handleChange('threshold', parseFloat(e.target.value))} className="w-full accent-emerald-500 h-1.5 bg-zinc-800 rounded-full appearance-none cursor-pointer" />
            <div className="flex justify-between text-[9px] text-zinc-600 px-1"><span>敏感 (0.1)</span><span>迟钝 (0.9)</span></div>
          </div>
        )}

        {strategy === 'iframe' && (
          <div className="text-[11px] text-zinc-500 flex items-start gap-2 bg-black/40 p-2 rounded">
            <AppIcon name="Film" size={14} className="shrink-0 mt-0.5 text-zinc-400" />
            <p>该策略将直接提取视频编码层原生的关键帧。处理速度极快，无需调节参数，但帧的时间分布可能不均匀。</p>
          </div>
        )}
      </div>
    </div>
  );
};
