// 📁 路径：src/renderer/src/pages/editor/components/semantic-flow/views/FrameCompactView.tsx
import { useFrameExtract } from '../../../../../hooks/useFrameExtract';
import { useI18n } from '../../../../../store/useI18n';

export const FrameCompactView = ({ nodeId }: { nodeId: string }) => {
  const { fps, strategy, handleFpsChange, handleStrategyChange } = useFrameExtract(nodeId);
  const { t } = useI18n();
  const nt = t.nodes?.process || {};

  return (
    <div className="flex flex-col gap-2 p-1.5 bg-black/20 rounded-md border border-white/5">
      <div className="flex items-center gap-3">
        <span className="text-[10px] text-zinc-500 font-medium">{nt.fps || 'FPS'}</span>
        <input 
          type="range" min="0.1" max="10" step="0.1" 
          value={fps} 
          onChange={(e) => handleFpsChange(parseFloat(e.target.value))}
          className="nodrag flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
        <span className="text-[11px] font-mono font-bold text-blue-400 w-6 text-right">{fps}</span>
      </div>

      <div className="flex items-center justify-between">
         <span className="text-[10px] text-zinc-500 font-medium">{nt.strategy || '策略'}</span>
         <select 
           value={strategy} 
           onChange={(e) => handleStrategyChange(e.target.value)}
           className="nodrag appearance-none bg-transparent text-[11px] font-medium text-zinc-300 outline-none cursor-pointer hover:text-white text-right"
         >
           <option value="uniform">{nt.strategy_uniform || '等距抽帧'}</option>
           <option value="scene">{nt.strategy_scene || '场景侦测'}</option>
           <option value="iframe">{nt.strategy_iframe || 'I 帧提取'}</option>
         </select>
      </div>
    </div>
  );
};
