// — 路径：src/renderer/src/pages/editor/components/InspectorDrawer.tsx
import { PanelRightClose } from 'lucide-react';
import { useEditorStore } from '../../../store/useStore';
import { useI18n } from '../../../store/useI18n';
import { AIProcessInspector } from './inspectors/AIProcessInspector';
import { DefaultInspector } from './inspectors/DefaultInspector';
import { MediaNodeInspector } from './inspectors/MediaNodeInspector';
import { ScriptNodeInspector } from './inspectors/ScriptNodeInspector';
import { SliderPanel } from './inspectors/SliderPanel';

export const InspectorDrawer = () => {
  const { activeNode, nodes, isInspectorOpen, setInspectorOpen } = useEditorStore();
  const { t } = useI18n();
  const ins = t.inspector || {};
  const selectedNode = activeNode ? nodes.find(n => n.id === activeNode.id) : null;

  if (!isInspectorOpen) return null;

  const renderInspector = () => {
    if (!selectedNode) return <div className="p-4 text-zinc-500 text-xs">{ins.empty || '请选择一个节点'}</div>;

    switch (selectedNode.type) {
      case 'processNode':
        return <AIProcessInspector />;
      case 'sourceNode':
        return <MediaNodeInspector />;
      case 'scriptNode':
        return <ScriptNodeInspector />;
      case 'playerNode':
      default:
        return <DefaultInspector data={selectedNode.data} />;
    }
  };

  return (
    <div className="w-[280px] flex-shrink-0 h-full bg-[#0A0A0A] border-l border-white/10 flex flex-col z-40 shadow-[-10px_0_30px_rgba(0,0,0,0.5)]">
      <div className="h-12 flex items-center justify-between px-4 border-b border-zinc-800/60 bg-transparent">
        <div className="flex items-center gap-3 overflow-hidden">
          <span className="text-[13px] font-bold tracking-widest text-zinc-200 whitespace-nowrap">
            {ins.title || '属性配置'}
          </span>
          <span className="text-[11px] text-zinc-500 font-mono truncate">
            {selectedNode?.id ? `#${selectedNode.id.slice(-6)}` : ''}
          </span>
        </div>
        <button 
          onClick={() => setInspectorOpen(false)} 
          className="p-1.5 hover:bg-white/10 rounded-md text-zinc-400 hover:text-zinc-100 transition-colors"
          aria-label="收起"
          title="收起面板 (Esc)"
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6" style={{ scrollbarWidth: 'none' }}>
        {/* V1.1: 全局 R/S/T/P 参数调节 — 始终可见 */}
        <div className="border-b border-zinc-800/60 pb-5 mb-2">
          <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
            {ins.global_params || '全局参数'}
          </div>
          <SliderPanel />
        </div>
        {renderInspector()}
      </div>
    </div>
  );
};
