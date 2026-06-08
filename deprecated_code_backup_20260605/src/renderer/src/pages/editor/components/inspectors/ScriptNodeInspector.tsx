// 📁 路径：src/renderer/src/pages/editor/components/inspectors/ScriptNodeInspector.tsx
import { useEditorStore } from '../../../../store/useStore';
import { AlignLeft, Mic, Sparkles, User, PlayCircle } from 'lucide-react';
import { Textarea } from '../../../../components/ui/textarea';

export const ScriptNodeInspector = () => {
  // 从 Zustand 拉取真实的 shots 数据和更新方法 (假设 store 中有 updateShot 方法)
  const { shots, updateShot } = useEditorStore();

  if (!shots || shots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-zinc-500 gap-3">
        <Sparkles size={32} className="opacity-50" />
        <span className="text-[12px]">等待 AI 剧本重铸...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest border-b border-zinc-800 pb-1">
        镜头序列编辑器
      </div>

      <div className="flex flex-col gap-4">
        {shots.map((shot, index) => (
          <div key={shot.id} className="bg-background/50 border border-zinc-800 rounded-lg p-3 flex flex-col gap-3 group transition-colors hover:border-zinc-600">
            
            {/* 镜头 Header */}
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="bg-zinc-800 text-zinc-300 text-[10px] px-1.5 py-0.5 rounded font-mono">
                  Shot {String(index + 1).padStart(2, '0')}
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">[{shot.duration || '0.0'}s]</span>
              </div>
              <button className="text-zinc-500 hover:text-blue-400 transition-colors">
                <PlayCircle size={14} />
              </button>
            </div>

            {/* 台词编辑区 (双向绑定核心) */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                <AlignLeft size={12} /> 旁白台词
              </div>
              <Textarea 
                value={shot.text}
                onChange={(e) => updateShot(shot.id, { text: e.target.value })}
                className="min-h-[60px] text-[12px] bg-[#18181B] border-zinc-800 text-zinc-200 resize-none focus-visible:ring-1 focus-visible:ring-blue-500 p-2"
                placeholder="输入解说文案..."
              />
            </div>

            {/* AI 角色与音色配置区 */}
            <div className="grid grid-cols-2 gap-2 mt-1">
               <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded p-1.5 cursor-pointer hover:bg-zinc-800 transition-colors">
                  <User size={12} className="text-zinc-500" />
                  <span className="text-[10px] text-zinc-300 truncate">{shot.roleId || '默认角色'}</span>
               </div>
               <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded p-1.5 cursor-pointer hover:bg-zinc-800 transition-colors">
                  <Mic size={12} className="text-zinc-500" />
                  <span className="text-[10px] text-blue-400 truncate">{(shot as any).audioConfig?.voice || '全局音色'}</span>
               </div>
            </div>

          </div>
        ))}
      </div>
    </div>
  );
};