// 📁 路径：src/renderer/src/pages/editor/components/semantic-flow/nodes/ScriptNode.tsx
import { Clapperboard } from 'lucide-react';
import { BaseNode } from './BaseNode';
import { useEditorStore } from '../../../../../store/useStore';
import { useI18n } from '../../../../../store/useI18n';
import { NODE_STATUS } from '../../../../../store/constants';
import { NODE_MENU_CONFIG } from '../../../config/nodeMenu';

export const ScriptNode = ({ id, data, selected }) => {
  const updateNodeData = useEditorStore((s) => s.updateNodeData);
  const { t } = useI18n();
  const sn = t.nodes?.script || {};
  const engine = data.llmEngine || 'DeepSeek-V3';
  
  const config = NODE_MENU_CONFIG.flatMap(c => c.items).find(i => i.type === 'scriptNode');
  const Icon = config?.icon || Clapperboard;

  const DisplayCore = (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center text-[11px]">
        <span className="text-zinc-500 font-medium">{sn.core_driver || '核心驱动'}</span>
        <span className="font-mono text-zinc-300 bg-zinc-900/50 px-1 rounded border border-zinc-800">{engine}</span>
      </div>
      
      <div className="flex justify-between items-center text-[11px]">
        <span className="text-zinc-500 font-medium">{sn.current_style || '当前流派'}</span>
        <select
          value={data.scriptStyle || 'workplace_drama'}
          onChange={(e) => updateNodeData(id, { scriptStyle: e.target.value })}
          className="nodrag bg-zinc-800/80 border border-zinc-700/50 rounded px-1.5 py-0.5 text-[11px] outline-none cursor-pointer hover:border-zinc-500 transition-colors"
          style={{ color: 'var(--amber-400)' }}
        >
          <option value="workplace_drama">{sn.style_workplace || '高张力爽文'}</option>
          <option value="domestic_conflict">{sn.style_domestic || '逻辑冲突抓马'}</option>
          <option value="nonsense_humor">{sn.style_nonsense || '荒诞无厘头'}</option>
          <option value="movie_recap">{sn.style_movie || '悬疑解说'}</option>
          <option value="custom">{sn.style_custom || '自定义指令'}</option>
        </select>
      </div>
    </div>
  );

  const InspectorForm = (
    <div className="flex flex-col gap-3 min-w-[200px] p-2">
      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] text-zinc-500 font-medium">{sn.prompt_label || '自定义提示词 (Prompt)'}</label>
        <textarea
          className="nodrag w-full h-20 bg-black/40 border border-white/10 rounded-lg text-[11px] text-zinc-300 p-2 focus:outline-none focus:border-amber-500/50 resize-none transition-colors"
          value={data.customPrompt || ''}
          onChange={(e) => updateNodeData(id, { customPrompt: e.target.value })}
          placeholder={sn.prompt_placeholder || '输入自定义剧本指令...'}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between items-center">
          <label className="text-[10px] text-zinc-500 font-medium">{sn.temp_label || 'AI 创造力 (Temp)'}</label>
          <span className="text-[10px] text-zinc-400 font-mono">{data.temperature || 0.7}</span>
        </div>
        <input
          type="range" min="0" max="2" step="0.1" value={data.temperature || 0.7}
          onChange={(e) => updateNodeData(id, { temperature: parseFloat(e.target.value) })}
          className="nodrag w-full accent-amber-500"
        />
      </div>
    </div>
  );

  return (
    <BaseNode
      {...({
        id,
        selected,
        title: data.label || (sn.title || 'AI 编剧台'),
        icon: <Icon size={16} />,
        accent: 'amber',
        variant: 'wide',
        themeColor: config?.color,
        themeBg: config?.bg,
        width: config?.defaultWidth || 280,
        status: data.status || NODE_STATUS.IDLE,
        inspector: InspectorForm,
        inputs: true,
        outputs: true
      } as any)}
    >
      {DisplayCore}
    </BaseNode>
  );
};
