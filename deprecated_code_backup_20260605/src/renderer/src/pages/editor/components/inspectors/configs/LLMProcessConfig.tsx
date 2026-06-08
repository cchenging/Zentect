// 📁 src/renderer/src/pages/editor/components/inspectors/configs/LLMProcessConfig.tsx
// 画布节点系统已移除，updateNodeData/activeWorkflowId 调用改为 console.warn + no-op
import { useCallback } from 'react';
import { BrainCircuit, Settings2, AlignLeft } from 'lucide-react';

interface LLMProcessConfigProps {
  node: any;
}

/**
 * LLM 处理节点配置面板
 * 画布节点系统已移除，参数变更与保存操作暂为空操作
 */
export const LLMProcessConfig = ({ node }: LLMProcessConfigProps) => {
  const params = node.data?.params || {};

  /** 参数变更回调（画布节点系统已移除，暂为空操作） */
  const handleParamChange = (_key: string, _value: any) => {
    console.warn('[LLMProcessConfig] 画布节点系统已移除，参数变更操作暂不可用');
  };

  /** 静默保存回调（画布节点系统已移除，暂为空操作） */
  const triggerSilentSave = useCallback(() => {
    console.warn('[LLMProcessConfig] 画布节点系统已移除，草稿保存操作暂不可用');
  }, []);

  return (
    <div className="flex flex-col gap-5 text-zinc-300">
      <div className="flex flex-col gap-2">
        <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
          <BrainCircuit size={14} /> 基础算力模型 (Engine)
        </label>
        <select
          value={params.model || 'volcengine-deepseek-v3'}
          onChange={(e) => {
            handleParamChange('model', e.target.value);
            triggerSilentSave();
          }}
          className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-[12px] text-zinc-200 focus:outline-none focus:border-blue-500/50 transition-colors"
        >
          <optgroup label="火山引擎 (Volcengine)">
            <option value="volcengine-deepseek-v3">DeepSeek V3 (满血版)</option>
            <option value="volcengine-deepseek-r1">DeepSeek R1 (推理版)</option>
            <option value="volcengine-doubao-pro">Doubao Pro (豆包)</option>
          </optgroup>
          <optgroup label="OpenAI 生态">
            <option value="gpt-4o">GPT-4o (全能旗舰)</option>
            <option value="gpt-4o-mini">GPT-4o-Mini (疾速版)</option>
          </optgroup>
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
          <AlignLeft size={14} /> 核心指令设定 (System Prompt)
        </label>
        <textarea
          value={params.systemPrompt || ''}
          onChange={(e) => handleParamChange('systemPrompt', e.target.value)}
          onBlur={triggerSilentSave}
          placeholder="例如：你是一个严谨的剧本审核专家，请分析传入的文本并提取核心冲突点..."
          className="w-full h-40 bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-blue-500/50 transition-colors resize-none leading-relaxed"
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex justify-between items-center">
          <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
            <Settings2 size={14} /> 创造力指数 (Temperature)
          </label>
          <span className="text-[10px] text-blue-400 font-mono bg-blue-500/10 px-1.5 py-0.5 rounded">
            {params.temperature !== undefined ? params.temperature : 0.7}
          </span>
        </div>
        <input
          type="range"
          min="0" max="2" step="0.1"
          value={params.temperature !== undefined ? params.temperature : 0.7}
          onChange={(e) => handleParamChange('temperature', parseFloat(e.target.value))}
          onMouseUp={triggerSilentSave}
          className="w-full accent-blue-500 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer"
        />
        <div className="flex justify-between text-[9px] text-zinc-600 font-medium">
          <span>精确客观 (0.0)</span>
          <span>天马行空 (2.0)</span>
        </div>
      </div>
    </div>
  );
};
