// 📁 路径：src/renderer/src/pages/editor/components/left-panel/WorkflowList.tsx
import React, { useState, useEffect, useRef } from 'react';
import { Play, SquareSquare, Settings, Cpu, ChevronRight, Layout } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import { TEMPLATES } from '../../config/templates';
import { AppNotifier } from '../../../../core/AppNotifier';
import { AppIcon } from '../../../../components/app-icon';
import { usePipelineExecutor } from '../../hooks/usePipelineExecutor'; // 复用已有的执行钩子

export const WorkflowList: React.FC = () => {
  const activeWorkflowId = useEditorStore(s => s.activeWorkflowId);
  const projectName = useEditorStore(s => s.projectName);
  const projectId = useEditorStore(s => s.projectId);
  const switchWorkflow = useEditorStore(s => s.switchWorkflow);
  
  const pipelineProgress = useEditorStore(s => s.pipelineProgress);
  const pipelineMessage = useEditorStore(s => s.pipelineMessage);

  const { isRunning, execute, abort } = usePipelineExecutor();

  const [instances, setInstances] = useState(() => 
    TEMPLATES.map(t => ({ ...t, instanceName: t.name }))
  );
  
  const [editingId, setEditingId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  // 瞬时切换工作流
  const handleActivate = (templateId: string, nodes: any[], edges: any[]) => {
    if (activeWorkflowId === templateId) return;
    if (isRunning) {
      return AppNotifier.warn("当前有任务正在运行，请先中止！");
    }
    switchWorkflow(templateId, nodes, edges);
  };

  // 桌面级内联重命名
  const handleRenameCommit = (id: string, newName: string) => {
    if (!newName.trim()) return setEditingId(null);
    setInstances(prev => prev.map(inst => inst.id === id ? { ...inst, instanceName: newName } : inst));
    setEditingId(null);
  };

  return (
    <div className="flex flex-col h-full bg-background p-3 gap-2.5 overflow-y-auto custom-scrollbar select-none relative">
      
      {/* 当前项目入口 */}
      <div 
        onClick={() => { if (projectId) switchWorkflow(projectId, [], []); }}
        className={`relative flex items-center gap-3 p-3 px-4 rounded-lg transition-all cursor-pointer outline-none ${
          !activeWorkflowId || activeWorkflowId === projectId ? 'bg-zinc-900 border border-zinc-700' : 'bg-zinc-900/40 border border-zinc-800/50 hover:bg-zinc-800/60'
        }`}
      >
        <div className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-500/20 text-blue-400 shrink-0">
          <Layout size={14} />
        </div>
        <span className="flex-1 text-xs font-semibold text-zinc-300 truncate">{projectName || '未命名工作流'}</span>
        {isRunning && activeWorkflowId === projectId && (
          <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse shrink-0" />
        )}
      </div>

      {/* 分隔线 */}
      <div className="h-px bg-zinc-800/50 mx-1" />

      {/* 模板列表 */}
      <span className="text-[10px] text-zinc-600 font-medium px-1">模板</span>
      
      {instances.map((inst, _index) => {
        const isActive = activeWorkflowId === inst.id;

        return (
          <div 
            key={inst.id}
            onClick={() => handleActivate(inst.id, inst.nodes, inst.edges)}
            className={`
              relative flex flex-col transition-all duration-300 ease-out overflow-hidden cursor-pointer outline-none border
              ${isActive 
                ? 'flex-1 min-h-[280px] bg-zinc-900 border-zinc-700 shadow-xl rounded-xl z-10 scale-100 opacity-100' 
                : 'h-14 bg-zinc-900/40 border-zinc-800/50 hover:bg-zinc-800/60 rounded-lg z-0 scale-[0.98] opacity-70 hover:scale-100 hover:opacity-100 shrink-0'
              }
            `}
          >
            {/* 卡片头部：Icon + 名称 + 状态灯 */}
            <div className={`flex items-center gap-3 w-full shrink-0 ${isActive ? 'p-4 pb-2' : 'p-3 px-4 h-full'}`}>
              <div className={`flex items-center justify-center rounded-md shrink-0 transition-colors ${isActive ? 'w-8 h-8 bg-primary/20 text-primary' : 'w-6 h-6 bg-zinc-800 text-zinc-400'}`}>
                {isActive ? <Cpu size={16} /> : <AppIcon name="Workflow" size={14} />}
              </div>
              
              <div className="flex-1 flex flex-col justify-center overflow-hidden">
                {editingId === inst.id ? (
                  <input
                    ref={editInputRef}
                    defaultValue={inst.instanceName}
                    onBlur={(e) => handleRenameCommit(inst.id, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRenameCommit(inst.id, e.currentTarget.value)}
                    className="w-full bg-black/50 text-white text-sm font-semibold border border-primary/50 rounded px-1.5 py-0.5 outline-none"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span 
                    onDoubleClick={(e) => { e.stopPropagation(); setEditingId(inst.id); }}
                    className={`font-semibold truncate tracking-wide transition-colors ${isActive ? 'text-zinc-100 text-sm' : 'text-zinc-400 text-xs'}`}
                    title="双击重命名"
                  >
                    {inst.instanceName}
                  </span>
                )}
              </div>

              {!isActive && <ChevronRight size={14} className="text-zinc-600 shrink-0" />}
            </div>

            {/* 💥 卡片展开区：Agent Console 智能体控制台 */}
            {isActive && (
              <div className="flex-1 flex flex-col px-4 pb-4 pt-1 animate-in fade-in duration-500">
                <p className="text-[11px] text-zinc-500 leading-relaxed m-0 mb-4 line-clamp-2">
                  {inst.description}
                </p>

                {/* 实时进度仪表盘 */}
                <div className="flex-1 bg-[#050505] border border-zinc-800/60 rounded-lg p-3 flex flex-col gap-3 relative overflow-hidden group">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-zinc-500 tracking-widest uppercase">Pipeline Status</span>
                    {isRunning && <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse" />}
                  </div>
                  
                  <div className="flex flex-col gap-1.5 mt-auto">
                    <div className="flex justify-between items-end">
                      <span className={`text-xs font-medium truncate pr-2 ${isRunning ? 'text-primary' : 'text-zinc-400'}`}>
                        {isRunning ? pipelineMessage : 'Agent Idle / 待命'}
                      </span>
                      <span className="text-[10px] font-mono text-zinc-500">{pipelineProgress}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-gradient-to-r from-blue-600 to-primary transition-all duration-300 ease-out"
                        style={{ width: `${pipelineProgress}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* 底部操作区 */}
                <div className="flex items-center gap-2 mt-4 pt-3 border-t border-zinc-800/60">
                  {isRunning ? (
                    <button 
                      onClick={(e) => { e.stopPropagation(); abort(); }}
                      className="flex-1 h-8 flex items-center justify-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-md transition-colors text-xs font-semibold cursor-pointer border border-red-500/20 outline-none"
                    >
                      <SquareSquare size={12} /> 中止任务
                    </button>
                  ) : (
                    <button 
                      onClick={(e) => { e.stopPropagation(); execute(); }}
                      className="flex-1 h-8 flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md transition-colors text-xs font-semibold shadow-md cursor-pointer outline-none"
                    >
                      <Play size={12} /> 立即投产
                    </button>
                  )}
                  <button 
                    onClick={(e) => e.stopPropagation()} 
                    className="h-8 w-8 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors cursor-pointer outline-none"
                  >
                    <Settings size={14} />
                  </button>
                </div>

              </div>
            )}
          </div>
        );
      })}

      {/* 底部新增堆栈按钮的隐喻 */}
      <div className="mt-auto pt-4 shrink-0 flex justify-center">
        <button className="flex items-center gap-2 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors bg-transparent border-none cursor-pointer outline-none font-medium">
          <AppIcon name="PlusCircle" size={14} /> 从模板库导入新管线
        </button>
      </div>

    </div>
  );
};